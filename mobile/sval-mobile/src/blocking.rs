// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Ad blocking on the iPhone (mobile spec §4.1): the desktop's filter lists,
//! converted into WebKit content rules by adblock-rust.

use std::collections::{BTreeMap, BTreeSet};

use adblock::Engine;
use adblock::content_blocking::{CbRule, CbType};
use adblock::lists::{FilterSet, ParseOptions, ParsedLine, RuleTypes, parse_filter};
use adblock::request::Request;
use serde_json::{Value, json};

use crate::filter_syntax::{HidingKind, hiding_off, hiding_rule, resolve_directives, site};

/// The most rules WebKit compiles into one list. A larger list fails to
/// compile, so the rules are split across lists under it.
pub const MAX_RULES: usize = 150_000;

/// The content rules for a set of filter lists, as the JSON text of each
/// rule list to compile.
#[derive(uniffi::Record)]
pub struct ContentRules {
    pub lists: Vec<String>,
    /// How many rules the lists produced.
    pub rules: u32,
}

/// Converts `lists`, each a filter list's text, into WebKit rule lists of at
/// most `MAX_RULES` rules. With `page_rules` off, only request blocking is
/// kept, as the desktop's `browser.sval.adblock.pageRules` does. No request
/// to a domain in `allowed_domains`, or a name under one, is blocked, on any
/// site, as the desktop's `@@||domain^$important` exceptions
/// (`SvalBlockingLists.getListBytes`) leave it; page rules still apply on
/// that domain's own pages.
///
/// WebKit applies an exception only to the rules before it in the same
/// list, so every list carries all the exceptions after its share of the
/// blocking rules, and the allowed domains' rules last.
#[uniffi::export]
pub fn content_rules(
    lists: Vec<String>,
    page_rules: bool,
    allowed_domains: Vec<String>,
) -> ContentRules {
    convert(
        lists,
        if page_rules {
            RuleTypes::All
        } else {
            RuleTypes::NetworkOnly
        },
        &allowed_domains,
    )
}

fn convert(lists: Vec<String>, rule_types: RuleTypes, allowed_domains: &[String]) -> ContentRules {
    let options = ParseOptions {
        rule_types,
        ..ParseOptions::default()
    };
    // Conversion needs each rule's text, which only a debug set keeps.
    let mut set = FilterSet::new(true);
    let mut exceptions = Exceptions::default();
    for list in lists {
        set.add_filter_list(exceptions.take_from(&list), options);
    }
    let rules = set
        .into_content_blocking()
        .map(|(rules, _)| rules)
        .unwrap_or_default();
    let (lifts, rules): (Vec<CbRule>, Vec<CbRule>) = rules
        .into_iter()
        .partition(|rule| rule.action.typ == CbType::IgnorePreviousRules);
    let lifts: Vec<Value> = lifts
        .iter()
        .filter_map(|rule| serde_json::to_value(rule).ok())
        .collect();
    let rules: Vec<Value> = rules
        .iter()
        .filter_map(|rule| serde_json::to_value(rule).ok())
        .filter_map(|rule| exceptions.apply(rule))
        .collect();
    let (hiding, blocking): (Vec<Value>, Vec<Value>) = rules
        .into_iter()
        .partition(|rule| rule["action"]["type"] == "css-display-none");
    let (site_hiding, generic_hiding): (Vec<Value>, Vec<Value>) = hiding
        .into_iter()
        .partition(|rule| rule["trigger"].get("if-domain").is_some());

    // A lift reaches only the rules before it in its own list, so request
    // blocking and hiding go in lists of their own, each ending with the
    // lifts that concern it: the lists' exceptions and the allowed domains
    // after the blocking rules, and the sites with hiding turned off after
    // the hiding rules.
    let generic_off: Vec<String> = exceptions
        .generic_off
        .iter()
        .chain(&exceptions.all_off)
        .cloned()
        .collect();
    let specific_off: Vec<String> = exceptions
        .specific_off
        .iter()
        .chain(&exceptions.all_off)
        .cloned()
        .collect();
    let mut blocking_lifts = lifts;
    blocking_lifts.extend(
        allowed_domains
            .iter()
            .filter_map(|domain| site(domain))
            .filter_map(|domain| requests_to(&domain))
            .map(|filter| {
                json!({
                    "trigger": { "url-filter": filter },
                    "action": { "type": "ignore-previous-rules" },
                })
            }),
    );

    let total = (blocking.len() + generic_hiding.len() + site_hiding.len()) as u32;
    let mut lists = chunked(&blocking, &blocking_lifts);
    lists.extend(chunked(
        &generic_hiding,
        &lift(&generic_off).into_iter().collect::<Vec<_>>(),
    ));
    lists.extend(chunked(
        &site_hiding,
        &lift(&specific_off).into_iter().collect::<Vec<_>>(),
    ));
    ContentRules {
        lists,
        rules: total,
    }
}

/// What the conversion is, for the app's key to its compiled rules: this
/// file and the crates it's built with, adblock-rust's version among them.
/// A changed converter makes different rules from the same lists, so rules
/// compiled by an earlier build are made again.
#[uniffi::export]
pub fn converter_version() -> String {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    include_str!("blocking.rs").hash(&mut hasher);
    include_str!("../Cargo.lock").hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// My filters' page rules alone, as rule lists of at most `MAX_RULES`, for
/// the pages the lists' rules skip: a site with protections off, and every
/// page while the level runs no list. My filters' request
/// blocking follows the lists, so `content_rules` carries it.
#[uniffi::export]
pub fn own_page_rules(my_filters: String) -> ContentRules {
    convert(vec![my_filters], RuleTypes::CosmeticOnly, &[])
}

/// The exception lines of `list`, its `!#if` blocks resolved: the `@@`
/// lines and the page-rule exceptions (`#@#` and its kin).
///
/// An exception reaches only the rules converted with it (`content_rules`),
/// so My filters compile apart from the downloaded lists with each side's
/// exceptions added to the other. A line My filters gain then compiles the
/// small list alone.
#[uniffi::export]
pub fn exception_lines(list: String) -> String {
    kept_lines(&list, |_| false)
}

/// The lines of `list` that act on rules from other lists: its exception
/// lines (`exception_lines`) and its `$badfilter` lines, which adblock-rust
/// applies across every list converted together
/// (`FilterSet::into_content_blocking`).
///
/// The app converts its lists in groups, each compiled apart, and adds each
/// group's shared lines to the others', so a group's rules come out as
/// they would from all the lists converted at once. `exception_lines` of
/// the result is `exception_lines` of `list`.
#[uniffi::export]
pub fn shared_lines(list: String) -> String {
    kept_lines(&list, is_badfilter)
}

/// The exception lines of `list`, its `!#if` blocks resolved, with the
/// lines `also` keeps.
fn kept_lines(list: &str, also: impl Fn(&str) -> bool) -> String {
    let mut kept = String::new();
    for line in resolve_directives(list).lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('!')
            && (trimmed.starts_with("@@") || trimmed.contains("#@") || also(trimmed))
        {
            kept.push_str(trimmed);
            kept.push('\n');
        }
    }
    kept
}

/// Whether `line` is a network filter with the `badfilter` option.
fn is_badfilter(line: &str) -> bool {
    line.contains("badfilter")
        && matches!(
            parse_filter(line, false, ParseOptions::default()),
            Ok(ParsedLine::Network(filter)) if filter.is_badfilter()
        )
}

/// The lists' request blocking, for a request the app makes itself, which
/// no content rule sees: a site's icon, fetched as the desktop's
/// `FaviconLoader` fetches one through its channel's classifier.
#[derive(uniffi::Object)]
pub struct RequestBlocker {
    engine: Engine,
    /// The allowed domains, which no request to is blocked, as in
    /// `content_rules`.
    allowed: Vec<String>,
}

#[uniffi::export]
impl RequestBlocker {
    /// The request blocking of `lists`, each a filter list's text, with
    /// requests to `allowed_domains` and the names under them let through.
    #[uniffi::constructor]
    pub fn new(lists: Vec<String>, allowed_domains: Vec<String>) -> Self {
        // adblock-rust panics on a request without a resolver to name its
        // hosts' sites. Only the first one set counts, and every one is the
        // same.
        let _ = adblock::url_parser::set_domain_resolver(Box::new(crate::site::Resolver));
        let options = ParseOptions {
            rule_types: RuleTypes::NetworkOnly,
            ..ParseOptions::default()
        };
        let mut set = FilterSet::new(false);
        for list in lists {
            set.add_filter_list(resolve_directives(&list).into_owned(), options);
        }
        Self {
            engine: Engine::new_with_filter_set(set),
            allowed: allowed_domains
                .iter()
                .filter_map(|domain| site(domain))
                .collect(),
        }
    }

    /// Whether the lists block the image at `url` loaded by the page at
    /// `page`. An address the lists can't read is blocked, so nothing is
    /// fetched unchecked.
    pub fn blocks_image(&self, url: String, page: String) -> bool {
        let Ok(request) = Request::new(&url, &page, "image", "GET") else {
            return true;
        };
        let host = request.hostname.trim_end_matches('.').to_ascii_lowercase();
        if self.allowed.iter().any(|allowed| covers(allowed, &host)) {
            return false;
        }
        self.engine.check_network_request(&request).should_block()
    }
}

/// The rules that stop the scripts a frame of a site with JavaScript off
/// loads, as one rule list's JSON text, or none when no site has it off.
///
/// WebKit decides JavaScript once for a whole page, from its top frame's
/// policy, so a frame of another site runs scripts by the top page's rule.
/// The desktop decides by each frame's own site (`SvalJavascript`), and
/// these rules carry that decision to the scripts a frame loads; a frame's
/// inline scripts are beyond a content rule's reach.
///
/// `allowed_default` is what a name without a rule gets
/// (`javascript.enabled`). `rules` pairs each name with whether it allows
/// JavaScript. The most specific name decides, so the rules run from the
/// shortest name to the longest, and a lift for an allowing name undoes the
/// block of a name above it. A rule that agrees with what its name would
/// get without it adds nothing.
#[uniffi::export]
pub fn script_rules(allowed_default: bool, rules: Vec<ScriptRule>) -> Option<String> {
    let rules: BTreeMap<String, bool> = rules
        .into_iter()
        .filter_map(|rule| site(&rule.name).map(|name| (name, rule.allowed)))
        .collect();
    let inherited = |name: &str| {
        let mut above = name;
        while let Some((_, parent)) = above.split_once('.') {
            above = parent;
            if let Some(allowed) = rules.get(above) {
                return *allowed;
            }
        }
        allowed_default
    };
    let mut ordered: Vec<(String, bool)> = rules
        .iter()
        .filter(|(name, allowed)| **allowed != inherited(name))
        .map(|(name, allowed)| (name.clone(), *allowed))
        .collect();
    ordered.sort_by_key(|(name, _)| name.split('.').count());
    let mut out: Vec<Value> = Vec::new();
    if !allowed_default {
        out.push(json!({
            "trigger": { "url-filter": ".*", "resource-type": ["script"] },
            "action": { "type": "block" },
        }));
    }
    for (name, allowed) in ordered {
        let Some(frame) = requests_to(&name) else {
            continue;
        };
        out.push(json!({
            "trigger": {
                "url-filter": ".*",
                "resource-type": ["script"],
                "if-frame-url": [frame],
            },
            "action": { "type": if allowed { "ignore-previous-rules" } else { "block" } },
        }));
    }
    (!out.is_empty()).then(|| Value::Array(out).to_string())
}

/// A site's JavaScript rule, for `script_rules`.
#[derive(uniffi::Record)]
pub struct ScriptRule {
    pub name: String,
    pub allowed: bool,
}

/// A WebKit pattern for any address on `domain` or a name under it, or none
/// for a name that can't be a host.
fn requests_to(domain: &str) -> Option<String> {
    domain
        .bytes()
        .all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
        })
        .then(|| {
            format!(
                "^[a-z][a-z0-9+.-]*://([^/]*@)?([^/:@]*\\.)?{}[:/]",
                domain.replace('.', "\\.")
            )
        })
}

/// `rules` in lists of at most `MAX_RULES`, each ending with `lifts`.
fn chunked(rules: &[Value], lifts: &[Value]) -> Vec<String> {
    let room = MAX_RULES.saturating_sub(lifts.len()).max(1);
    rules
        .chunks(room)
        .map(|chunk| {
            let mut list = chunk.to_vec();
            list.extend(lifts.iter().cloned());
            Value::Array(list).to_string()
        })
        .collect()
}

/// The page-rule exceptions of a set of lists, which WebKit's rules can only
/// carry as the sites a hiding rule skips (`unless-domain`), or as a lift at
/// the end of a hiding list.
///
/// adblock-rust converts `site#@#selector` into a rule of its own that hides
/// the selector on every site but `site`, which adds hiding the list never
/// asked for and leaves the rule it excepts hiding on `site`. So those lines
/// are taken out before conversion and applied to the hiding rules after it.
/// The sites `$generichide`, `$specifichide` and `$elemhide` exceptions
/// name, which adblock-rust can't convert at all, are lifted at the end of
/// the hiding lists (`content_rules`).
#[derive(Default)]
struct Exceptions {
    /// Selector to the sites it isn't hidden on. An empty name: anywhere.
    unhide: BTreeMap<String, BTreeSet<String>>,
    /// Sites with no generic hiding.
    generic_off: BTreeSet<String>,
    /// Sites with no hiding at all.
    all_off: BTreeSet<String>,
    /// Sites with no hiding for named sites.
    specific_off: BTreeSet<String>,
}

impl Exceptions {
    /// `list` read for WebKit: its `!#if` blocks resolved, its `#@#` lines
    /// and hiding exceptions recorded, and its hiding rules as WebKit can
    /// carry them (`filter_syntax`).
    fn take_from(&mut self, list: &str) -> String {
        let list = resolve_directives(list);
        let mut kept = String::with_capacity(list.len());
        for line in list.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('!') {
                continue;
            }
            if let Some((sites, selector)) = trimmed.split_once("#@#")
                && !selector.starts_with("+js(")
            {
                let entry = self.unhide.entry(selector.to_owned()).or_default();
                // An entity or regex site can't be named to WebKit, so the
                // hiding it excepts goes on hiding there.
                let sites: Vec<&str> = sites
                    .split(',')
                    .filter(|name| !name.trim().is_empty())
                    .collect();
                if sites.is_empty() || sites.contains(&"*") {
                    entry.insert(String::new());
                }
                entry.extend(sites.into_iter().filter_map(site));
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("@@")
                && let Some(off) = hiding_off(rest)
            {
                match off.kind {
                    HidingKind::All => self.all_off.extend(off.sites),
                    HidingKind::Generic => self.generic_off.extend(off.sites),
                    HidingKind::Specific => self.specific_off.extend(off.sites),
                }
                continue;
            }
            if let Some(rule) = hiding_rule(trimmed) {
                kept.push_str(&rule);
                kept.push('\n');
            }
        }
        kept
    }

    /// `rule` with the exceptions applied, or none when they leave it no
    /// site to hide on.
    fn apply(&self, mut rule: Value) -> Option<Value> {
        if rule["action"]["type"] != "css-display-none" {
            return Some(rule);
        }
        let selector = rule["action"]["selector"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let mut skipped: BTreeSet<String> = BTreeSet::new();
        if let Some(sites) = self.unhide.get(&selector) {
            if sites.contains("") {
                return None;
            }
            skipped.extend(sites.iter().cloned());
        }
        let trigger = rule["trigger"].as_object_mut()?;
        // A list's site covers the names under it, as `*site` does in WebKit;
        // adblock-rust writes a hiding rule's sites bare, which WebKit
        // matches exactly, so `youtube.com##…` missed `m.youtube.com`.
        for key in ["if-domain", "unless-domain"] {
            if let Some(Value::Array(sites)) = trigger.get_mut(key) {
                for entry in sites.iter_mut() {
                    if let Some(name) = entry.as_str().filter(|name| !name.starts_with('*')) {
                        *entry = Value::from(format!("*{name}"));
                    }
                }
            }
        }
        match trigger.get("if-domain").and_then(Value::as_array).cloned() {
            Some(sites) => {
                let kept: Vec<Value> = sites
                    .into_iter()
                    .filter(|entry| {
                        let name = entry.as_str().unwrap_or_default().trim_start_matches('*');
                        !skipped.iter().any(|off| covers(off, name))
                    })
                    .collect();
                if kept.is_empty() {
                    return None;
                }
                trigger.insert("if-domain".into(), Value::Array(kept));
            }
            None => {
                if !skipped.is_empty() {
                    let mut unless: BTreeSet<String> = trigger
                        .get("unless-domain")
                        .and_then(Value::as_array)
                        .map(|sites| {
                            sites
                                .iter()
                                .filter_map(|site| site.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default();
                    unless.extend(skipped.iter().map(|site| format!("*{site}")));
                    trigger.insert(
                        "unless-domain".into(),
                        unless.into_iter().map(Value::from).collect(),
                    );
                }
            }
        }
        Some(rule)
    }
}

/// Whether site `off` covers `name`: the same name, or one under it.
fn covers(off: &str, name: &str) -> bool {
    name == off || name.ends_with(&format!(".{off}"))
}

/// The rule that lifts every earlier rule in its list on `sites` and the
/// names under them, or none for no sites.
fn lift(sites: &[String]) -> Option<Value> {
    let sites: BTreeSet<String> = sites.iter().map(|site| format!("*{site}")).collect();
    (!sites.is_empty()).then(|| {
        json!({
            "trigger": { "url-filter": ".*", "if-domain": sites },
            "action": { "type": "ignore-previous-rules" },
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_an_image_the_lists_block_outside_the_allowed_domains() {
        let blocker = RequestBlocker::new(
            vec![
                "||ads.example.com^\n||tracker.example.net^\n@@||tracker.example.net/ok^\n".into(),
            ],
            vec!["Example.org.".into()],
        );
        let page = "https://news.example.co.uk/".to_owned();
        assert!(blocker.blocks_image("https://ads.example.com/icon.png".into(), page.clone()));
        assert!(blocker.blocks_image("https://tracker.example.net/icon.png".into(), page.clone()));
        assert!(!blocker.blocks_image(
            "https://tracker.example.net/ok/icon.png".into(),
            page.clone()
        ));
        assert!(!blocker.blocks_image(
            "https://news.example.co.uk/favicon.ico".into(),
            page.clone()
        ));
        assert!(blocker.blocks_image("not an address".into(), page.clone()));

        let allowing = RequestBlocker::new(
            vec!["||example.org^\n||evil.test^\n".into()],
            vec!["example.org".into()],
        );
        assert!(!allowing.blocks_image("https://cdn.example.org/icon.png".into(), page.clone()));
        assert!(allowing.blocks_image("https://example.org.evil.test/icon.png".into(), page));
    }

    fn rules(list: &str) -> Vec<Value> {
        serde_json::from_str(list).unwrap()
    }

    #[test]
    fn converts_blocking_and_exception_rules() {
        let out = content_rules(
            vec!["||ads.example.com^\n@@||ads.example.com/ok^\n".into()],
            true,
            vec![],
        );
        assert_eq!(out.lists.len(), 1);
        let kinds: Vec<_> = rules(&out.lists[0])
            .iter()
            .map(|rule| rule["action"]["type"].as_str().unwrap().to_owned())
            .collect();
        let first_exception = kinds
            .iter()
            .position(|kind| kind == "ignore-previous-rules")
            .unwrap();
        assert!(first_exception > 0);
        assert!(kinds[..first_exception].iter().all(|kind| kind == "block"));
        assert!(
            kinds[first_exception..]
                .iter()
                .all(|kind| kind == "ignore-previous-rules")
        );
    }

    #[test]
    fn lifts_requests_to_an_allowed_domain_in_the_blocking_lists_alone() {
        let out = content_rules(
            vec!["||ads.example.com^\n##.banner\nexample.net##.promo\n".into()],
            true,
            vec!["Example.org.".into()],
        );
        assert_eq!(out.lists.len(), 3);
        let blocking = rules(&out.lists[0]);
        let last = blocking.last().unwrap();
        assert_eq!(last["action"]["type"], "ignore-previous-rules");
        assert!(last["trigger"].get("if-domain").is_none());
        let filter = last["trigger"]["url-filter"].as_str().unwrap();
        assert_eq!(
            filter,
            "^[a-z][a-z0-9+.-]*://([^/]*@)?([^/:@]*\\.)?example\\.org[:/]"
        );
        // The pattern, read as a regular expression, takes the domain and
        // the names under it, and no other name that ends the same way.
        let pattern = regex::Regex::new(filter).unwrap();
        assert!(pattern.is_match("https://example.org/a.js"));
        assert!(pattern.is_match("https://cdn.example.org:8443/a.js"));
        assert!(!pattern.is_match("https://notexample.org/a.js"));
        assert!(!pattern.is_match("https://example.org.evil.net/a.js"));
        assert!(!pattern.is_match("https://evil.net/?u=https://example.org/"));
        // Hiding stays on the domain's own pages.
        for list in &out.lists[1..] {
            assert!(
                rules(list)
                    .iter()
                    .all(|rule| rule["action"]["type"] == "css-display-none")
            );
        }
    }

    #[test]
    fn keeps_request_blocking_and_hiding_in_lists_of_their_own() {
        let out = content_rules(vec!["||ads.example.com^\n##.banner\n".into()], true, vec![]);
        let kinds: Vec<Vec<String>> = out
            .lists
            .iter()
            .map(|list| {
                rules(list)
                    .iter()
                    .map(|rule| rule["action"]["type"].as_str().unwrap().to_owned())
                    .collect()
            })
            .collect();
        assert!(kinds[0].iter().all(|kind| kind != "css-display-none"));
        assert_eq!(kinds[1], ["css-display-none"]);
    }

    #[test]
    fn keeps_only_request_blocking_without_page_rules() {
        let out = content_rules(
            vec!["||ads.example.com^\nexample.com##.banner\n".into()],
            false,
            vec![],
        );
        let list = rules(&out.lists[0]);
        assert!(
            list.iter()
                .all(|rule| rule["action"]["type"] != "css-display-none")
        );
    }

    #[test]
    fn a_site_exception_keeps_a_generic_rule_off_that_site() {
        let out = content_rules(
            vec!["##.video-ads\nyoutube.com#@#.video-ads\n".into()],
            true,
            vec![],
        );
        let list = rules(&out.lists[0]);
        assert_eq!(list.len(), 1, "the exception adds no rule of its own");
        assert_eq!(list[0]["action"]["selector"], ".video-ads");
        assert_eq!(list[0]["trigger"]["unless-domain"], json!(["*youtube.com"]));
    }

    #[test]
    fn a_site_exception_removes_that_site_from_a_site_rule() {
        let out = content_rules(
            vec!["example.com,youtube.com##.promo\nyoutube.com#@#.promo\n".into()],
            true,
            vec![],
        );
        let list = rules(&out.lists[0]);
        assert_eq!(list[0]["trigger"]["if-domain"], json!(["*example.com"]));
    }

    #[test]
    fn an_exception_everywhere_drops_the_rule() {
        let out = content_rules(vec!["##.promo\n#@#.promo\n".into()], true, vec![]);
        assert!(out.lists.is_empty());
    }

    #[test]
    fn generichide_keeps_generic_rules_off_a_site() {
        let out = content_rules(
            vec!["##.banner\nexample.com##.promo\n@@||example.com^$generichide\n".into()],
            true,
            vec![],
        );
        // The generic list ends by lifting its rules on the site; the site
        // list doesn't.
        let generic = rules(&out.lists[0]);
        assert_eq!(generic[0]["action"]["selector"], ".banner");
        assert_eq!(
            generic.last().unwrap()["trigger"]["if-domain"],
            json!(["*example.com"])
        );
        let site = rules(&out.lists[1]);
        assert_eq!(site.len(), 1);
        assert_eq!(site[0]["action"]["selector"], ".promo");
    }

    /// Every hiding rule `lists` convert to, from every list, with each
    /// list's lifts.
    fn hiding(lists: &[&str]) -> Vec<Value> {
        let out = content_rules(
            lists.iter().map(|list| (*list).to_owned()).collect(),
            true,
            vec![],
        );
        out.lists
            .iter()
            .flat_map(|list| rules(list))
            .filter(|rule| rule["action"]["type"] == "css-display-none")
            .collect()
    }

    fn selectors(rules: &[Value]) -> Vec<String> {
        rules
            .iter()
            .filter_map(|rule| rule["action"]["selector"].as_str().map(str::to_owned))
            .collect()
    }

    fn rule_for<'a>(rules: &'a [Value], selector: &str) -> &'a Value {
        rules
            .iter()
            .find(|rule| rule["action"]["selector"] == selector)
            .unwrap_or_else(|| panic!("no rule hides {selector}"))
    }

    /// The sites each hiding list ends by lifting its rules on.
    fn lifted(lists: &[&str]) -> Vec<Vec<String>> {
        let out = content_rules(
            lists.iter().map(|list| (*list).to_owned()).collect(),
            true,
            vec![],
        );
        out.lists
            .iter()
            .map(|list| rules(list))
            .filter(|rules| {
                rules
                    .iter()
                    .any(|rule| rule["action"]["type"] == "css-display-none")
            })
            .map(|rules| {
                let last = rules.last().unwrap();
                if last["action"]["type"] != "ignore-previous-rules" {
                    return vec![];
                }
                last["trigger"]["if-domain"]
                    .as_array()
                    .map(|sites| {
                        sites
                            .iter()
                            .filter_map(|site| site.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .collect()
    }

    #[test]
    fn hides_on_a_site_and_every_name_under_it() {
        let rules = hiding(&["example.com,news.example.org##.ad\n"]);
        assert_eq!(
            rule_for(&rules, ".ad")["trigger"]["if-domain"],
            json!(["*example.com", "*news.example.org"])
        );
    }

    #[test]
    fn skips_a_generic_rule_on_its_excepted_sites() {
        let rules = hiding(&["~example.com##.ad\n"]);
        let ad = rule_for(&rules, ".ad");
        assert_eq!(ad["trigger"]["unless-domain"], json!(["*example.com"]));
        assert!(ad["trigger"].get("if-domain").is_none());
    }

    #[test]
    fn names_an_international_site_in_punycode() {
        let rules = hiding(&["bücher.de##.ad\n"]);
        assert_eq!(
            rule_for(&rules, ".ad")["trigger"]["if-domain"],
            json!(["*xn--bcher-kva.de"])
        );
    }

    #[test]
    fn hides_a_specific_generic_rule_everywhere() {
        let rules = hiding(&["*##.everywhere\n*,~example.com##.mostly\n"]);
        assert!(
            rule_for(&rules, ".everywhere")["trigger"]
                .get("if-domain")
                .is_none()
        );
        assert_eq!(
            rule_for(&rules, ".mostly")["trigger"]["unless-domain"],
            json!(["*example.com"])
        );
    }

    #[test]
    fn hides_what_remove_takes_away_and_leaves_what_webkit_cant_do() {
        let rules = hiding(&[concat!(
            "example.com##.gone:remove()\n",
            "example.com##.box:has-text(Sponsored)\n",
            "example.com##.box:style(height: 0 !important)\n",
            "example.com##+js(nowoif)\n",
            "example.com##^script:has-text(ad)\n",
            "example.com##.box:upward(2)\n",
            "example.com##.box:matches-path(/ads)\n",
            "example.com##.ünïcode\n",
        )]);
        assert_eq!(selectors(&rules), [".gone"]);
    }

    #[test]
    fn keeps_a_native_has_selector() {
        let rules = hiding(&["example.com##.card:has(> .sponsored)\n"]);
        assert_eq!(selectors(&rules), [".card:has(> .sponsored)"]);
    }

    #[test]
    fn leaves_out_a_rule_naming_both_sites_and_exceptions() {
        // WebKit takes `if-domain` or `unless-domain`, never both, so
        // adblock-rust converts neither; hiding less is the safe side.
        let rules = hiding(&["example.com,~shop.example.com##.ad\n##.kept\n"]);
        assert_eq!(selectors(&rules), [".kept"]);
    }

    #[test]
    fn resolves_directives_before_converting() {
        let rules = hiding(&[concat!(
            "!#if env_firefox\n##.firefox\n!#else\n##.not-firefox\n!#endif\n",
            "!#if env_mobile\n##.mobile\n!#endif\n",
            "!#if false\n##.never\n!#endif\n",
        )]);
        assert_eq!(selectors(&rules), [".not-firefox", ".mobile"]);
    }

    #[test]
    fn resolves_directives_for_requests_the_app_makes() {
        let blocker = RequestBlocker::new(
            vec!["!#if env_firefox\n||firefox.test^\n!#else\n||webkit.test^\n!#endif\n".into()],
            vec![],
        );
        let page = "https://example.com/".to_owned();
        assert!(blocker.blocks_image("https://webkit.test/a.png".into(), page.clone()));
        assert!(!blocker.blocks_image("https://firefox.test/a.png".into(), page));
    }

    #[test]
    fn lifts_generic_hiding_on_an_exceptions_domain_option() {
        let lists = [
            "##.banner\nexample.com##.promo\n@@*$ghide,domain=web.de|gmx.*\n@@||figma.com^$generichide\n",
        ];
        assert_eq!(
            lifted(&lists),
            [vec!["*figma.com".to_owned(), "*web.de".to_owned()], vec![]]
        );
    }

    #[test]
    fn specifichide_lifts_site_hiding_alone() {
        let lists = ["##.banner\nexample.com##.promo\n@@||example.com^$shide\n"];
        assert_eq!(lifted(&lists), [vec![], vec!["*example.com".to_owned()]]);
    }

    #[test]
    fn a_star_exception_unhides_everywhere() {
        assert_eq!(
            selectors(&hiding(&["##.ad\n##.kept\n*#@#.ad\n"])),
            [".kept"]
        );
    }

    #[test]
    fn an_exception_for_sites_webkit_cant_name_leaves_the_hiding() {
        // `example.*` can't be named to WebKit, so `.ad` goes on hiding there.
        let rules = hiding(&["##.ad\nexample.*#@#.ad\n"]);
        assert!(
            rule_for(&rules, ".ad")["trigger"]
                .get("unless-domain")
                .is_none()
        );
    }

    #[test]
    fn no_rule_hides_everywhere_that_the_list_scoped() {
        // Each line hides on named sites alone, or nowhere WebKit can name;
        // none may come out hiding on every site.
        let rules = hiding(&[concat!(
            "~vipbox.pl,vipbox.*,vipboxtv.*##.a\n",
            "oxy.*,~oxy.edu##.b\n",
            "~google.*,~bing.com##.c\n",
            "/img[a-z]{3,5}\\.buzz/##.d\n",
            "org,~/^example\\.org$/##.e\n",
            "example.com,~shop.*##.f\n",
            "amazon.*##.g\n",
        )]);
        assert_eq!(selectors(&rules), Vec::<String>::new());
    }

    #[test]
    fn leaves_out_hiding_for_sites_webkit_cannot_name() {
        let out = content_rules(
            vec!["~vipbox.pl,vipbox.*##.position-absolute\nexample.*##.promo\n*##.banner\nexample.com,other.*##.ad\n".into()],
            true,
            vec![],
        );
        let all: Vec<Value> = out.lists.iter().flat_map(|list| rules(list)).collect();
        let selectors: Vec<&str> = all
            .iter()
            .filter_map(|rule| rule["action"]["selector"].as_str())
            .collect();
        assert!(!selectors.contains(&".position-absolute"));
        assert!(!selectors.contains(&".promo"));
        assert!(selectors.contains(&".banner"));
        let ad = all
            .iter()
            .find(|rule| rule["action"]["selector"] == ".ad")
            .unwrap();
        assert_eq!(ad["trigger"]["if-domain"], json!(["*example.com"]));
    }

    #[test]
    fn elemhide_keeps_every_hiding_rule_off_a_site() {
        let out = content_rules(
            vec!["example.com,other.org##.promo\n@@||example.com^$elemhide\n".into()],
            true,
            vec![],
        );
        let site = rules(&out.lists[0]);
        assert_eq!(
            site[0]["trigger"]["if-domain"],
            json!(["*example.com", "*other.org"])
        );
        let last = site.last().unwrap();
        assert_eq!(last["action"]["type"], "ignore-previous-rules");
        assert_eq!(last["trigger"]["if-domain"], json!(["*example.com"]));
    }

    #[test]
    fn own_page_rules_keep_hiding_alone() {
        let out = own_page_rules("||ads.example.com^\nexample.com##.promo\n##.banner\n".into());
        let kinds: Vec<String> = out
            .lists
            .iter()
            .flat_map(|list| rules(list))
            .map(|rule| rule["action"]["type"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(kinds, ["css-display-none", "css-display-none"]);
    }

    #[test]
    fn script_rules_block_a_sites_frames_and_lift_an_allowed_host() {
        let list = script_rules(
            true,
            vec![
                ScriptRule {
                    name: "a.example.com".into(),
                    allowed: true,
                },
                ScriptRule {
                    name: "example.com".into(),
                    allowed: false,
                },
                ScriptRule {
                    name: "other.org".into(),
                    allowed: true,
                },
            ],
        )
        .unwrap();
        let list = rules(&list);
        assert_eq!(list.len(), 2, "a rule that changes nothing adds none");
        assert_eq!(list[0]["action"]["type"], "block");
        assert_eq!(list[0]["trigger"]["resource-type"], json!(["script"]));
        assert_eq!(
            list[0]["trigger"]["if-frame-url"],
            json!(["^[a-z][a-z0-9+.-]*://([^/]*@)?([^/:@]*\\.)?example\\.com[:/]"])
        );
        assert_eq!(list[1]["action"]["type"], "ignore-previous-rules");
    }

    #[test]
    fn script_rules_block_everywhere_with_javascript_off() {
        let list = rules(&script_rules(false, vec![]).unwrap());
        assert_eq!(list.len(), 1);
        assert!(list[0]["trigger"].get("if-frame-url").is_none());
        assert!(script_rules(true, vec![]).is_none());
    }

    #[test]
    fn exception_lines_keep_the_exceptions_alone() {
        let list = "! a note\n||ads.example.com^\n@@||ads.example.com/ok^\nexample.com##.promo\nexample.com#@#.promo\n@@||example.org^$generichide\n!#if false\n@@||hidden.test^\n!#endif\n";
        assert_eq!(
            exception_lines(list.into()),
            "@@||ads.example.com/ok^\nexample.com#@#.promo\n@@||example.org^$generichide\n"
        );
    }

    /// My filters compiled apart from the lists still meet the lists'
    /// exceptions, and the lists meet My filters'.
    #[test]
    fn exceptions_carried_across_lift_the_other_sides_rules() {
        let downloaded = "||ads.example.com^\nexample.com##.promo\n@@||ads.example.com/ok^\nshop.test#@#.banner\n";
        let mine = "||ads.example.com/ok/more^\n##.banner\nexample.com#@#.promo\n";
        let all = |lists: Vec<String>| -> Vec<Value> {
            content_rules(lists, true, vec![])
                .lists
                .iter()
                .flat_map(|list| rules(list))
                .collect()
        };
        let lists = all(vec![downloaded.into(), exception_lines(mine.into())]);
        assert!(
            !lists
                .iter()
                .any(|rule| rule["action"]["selector"] == ".promo"),
            "My filters' exception unhides the lists' rule"
        );
        let own = all(vec![exception_lines(downloaded.into()), mine.into()]);
        let banner = own
            .iter()
            .find(|rule| rule["action"]["selector"] == ".banner")
            .unwrap();
        assert_eq!(banner["trigger"]["unless-domain"], json!(["*shop.test"]));
        let block = own
            .iter()
            .position(|rule| rule["action"]["type"] == "block")
            .unwrap();
        assert!(
            own[block..]
                .iter()
                .any(|rule| rule["action"]["type"] == "ignore-previous-rules"),
            "the lists' exception follows My filters' block"
        );
    }

    #[test]
    fn shared_lines_keep_the_exceptions_and_badfilters_alone() {
        let list = "! a note\n||ads.example.com^\n||bad.example^$badfilter\n@@||ads.example.com/ok^\nexample.com##.promo\nexample.com#@#.promo\nexample.com##.badfilter\n!#if false\n||hidden.test^$badfilter\n!#endif\n";
        let shared = shared_lines(list.into());
        assert_eq!(
            shared,
            "||bad.example^$badfilter\n@@||ads.example.com/ok^\nexample.com#@#.promo\n"
        );
        assert_eq!(exception_lines(shared), exception_lines(list.into()));
    }

    /// A `$badfilter` in one list drops another list's rule when the lists
    /// are converted apart, each with the other's shared lines.
    #[test]
    fn a_badfilter_carried_across_drops_the_other_lists_rule() {
        let malware = "||evil.example^$all\n||worse.example^$all\n";
        let fixes = "||evil.example^$all,badfilter\n";
        let blocked: Vec<String> = content_rules(
            vec![malware.into(), shared_lines(fixes.into())],
            true,
            vec![],
        )
        .lists
        .iter()
        .flat_map(|list| rules(list))
        .filter(|rule| rule["action"]["type"] == "block")
        .map(|rule| rule["trigger"]["url-filter"].as_str().unwrap().to_owned())
        .collect();
        assert!(blocked.iter().any(|filter| filter.contains("worse")));
        assert!(
            !blocked.iter().any(|filter| filter.contains("evil")),
            "the badfilter reaches the other list's rule"
        );
    }

    #[test]
    fn has_no_lists_for_no_rules() {
        assert!(content_rules(vec![], true, vec![]).lists.is_empty());
    }
}
