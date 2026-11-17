// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The parts of uBlock Origin's filter syntax that adblock-rust's content
//! blocking conversion leaves wrong for WebKit, read here before it runs:
//! `!#if` blocks, hiding rules whose sites WebKit can't name, and the
//! exceptions that turn hiding off on a site. The syntax is uBlock Origin's
//! "Static filter syntax".

use std::borrow::Cow;

/// The `!#if` tokens uBlock Origin defines, and their value on the iPhone:
/// uBlock Origin's lists, read by WebKit's content blockers on a phone, with
/// no HTML filtering and no user stylesheets. `env_safari` blocks hold the
/// rules written for WebKit's content blocker regex, and their `!#else`
/// the full regex WebKit can't compile. Mirrors the desktop's
/// `PREPARSER_TOKENS` (`SvalBlockingLists.sys.mjs`) with the phone's values.
const TOKENS: &[(&str, bool)] = &[
    ("ext_ublock", true),
    ("ext_ubol", false),
    ("ext_devbuild", false),
    ("env_brave", false),
    ("env_chromium", false),
    ("env_edge", false),
    ("env_firefox", false),
    ("env_legacy", false),
    ("env_mobile", true),
    ("env_mv3", false),
    ("env_safari", true),
    ("cap_html_filtering", false),
    ("cap_ipaddress", false),
    ("cap_user_stylesheet", false),
    ("false", false),
    ("ext_abp", false),
    ("adguard", false),
    ("adguard_app_android", false),
    ("adguard_app_cli", false),
    ("adguard_app_ios", false),
    ("adguard_app_mac", false),
    ("adguard_app_windows", false),
    ("adguard_ext_android_cb", false),
    ("adguard_ext_chromium", false),
    ("adguard_ext_chromium_mv3", false),
    ("adguard_ext_edge", false),
    ("adguard_ext_firefox", false),
    ("adguard_ext_opera", false),
    ("adguard_ext_safari", false),
];

/// A token's value: known, false for an unknown `cap_` token, and unknown
/// otherwise, which keeps its block as uBlock Origin does.
fn token(name: &str) -> Option<bool> {
    TOKENS
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, value)| *value)
        .or_else(|| name.starts_with("cap_").then_some(false))
}

/// The value of an `!#if` expression of tokens, `!`, `&&`, `||` and
/// parentheses: none when a token is unknown or it doesn't parse.
fn condition(expr: &str) -> Option<bool> {
    let mut tokens = Vec::new();
    let mut rest = expr.trim();
    while !rest.is_empty() {
        let (token, after) = if let Some(after) = rest.strip_prefix("&&") {
            ("&&", after)
        } else if let Some(after) = rest.strip_prefix("||") {
            ("||", after)
        } else if rest.starts_with(['!', '(', ')']) {
            rest.split_at(1)
        } else {
            let end = rest
                .find(|c: char| c.is_whitespace() || "()!&|".contains(c))
                .unwrap_or(rest.len());
            if end == 0 {
                return None;
            }
            rest.split_at(end)
        };
        tokens.push(token);
        rest = after.trim_start();
    }
    let mut parser = Condition { tokens, at: 0 };
    let value = parser.either()?;
    (parser.at == parser.tokens.len()).then_some(value?)
}

/// A recursive descent over an `!#if` expression. Each step is `None` when
/// the expression doesn't parse, and `Some(None)` when a token is unknown.
struct Condition<'a> {
    tokens: Vec<&'a str>,
    at: usize,
}

impl Condition<'_> {
    fn next(&mut self) -> Option<&str> {
        let token = self.tokens.get(self.at).copied();
        self.at += 1;
        token
    }

    fn primary(&mut self) -> Option<Option<bool>> {
        match self.next()? {
            "!" => Some(self.primary()?.map(|value| !value)),
            "(" => {
                let value = self.either()?;
                (self.next()? == ")").then_some(value)
            }
            "&&" | "||" | ")" => None,
            name => Some(token(name)),
        }
    }

    fn both(&mut self) -> Option<Option<bool>> {
        let mut value = self.primary()?;
        while self.tokens.get(self.at) == Some(&"&&") {
            self.at += 1;
            let right = self.primary()?;
            value = value.zip(right).map(|(a, b)| a && b);
        }
        Some(value)
    }

    fn either(&mut self) -> Option<Option<bool>> {
        let mut value = self.both()?;
        while self.tokens.get(self.at) == Some(&"||") {
            self.at += 1;
            let right = self.both()?;
            value = value.zip(right).map(|(a, b)| a || b);
        }
        Some(value)
    }
}

/// `text` with its `!#if`/`!#else`/`!#endif` blocks resolved for the
/// iPhone, nested blocks included. adblock-rust reads the directives as
/// comments, so without this every branch applies. A block whose condition
/// is unknown stays, both its branches.
pub fn resolve_directives(text: &str) -> Cow<'_, str> {
    if !text.contains("!#if") {
        return Cow::Borrowed(text);
    }
    let mut kept = String::with_capacity(text.len());
    // Each open block: Some(false) when its lines are dropped.
    let mut stack: Vec<Option<bool>> = Vec::new();
    for line in text.lines() {
        if let Some(expr) = directive(line, "if") {
            stack.push(condition(expr));
            continue;
        }
        if directive(line, "else").is_some() {
            if let Some(top) = stack.last_mut() {
                *top = top.map(|value| !value);
            }
            continue;
        }
        if directive(line, "endif").is_some() {
            stack.pop();
            continue;
        }
        if !stack.contains(&Some(false)) {
            kept.push_str(line);
            kept.push('\n');
        }
    }
    Cow::Owned(kept)
}

/// What follows `!#<name>` on `line`, when it is that directive.
fn directive<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let rest = line.trim_end().strip_prefix("!#")?.strip_prefix(name)?;
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then_some(rest)
}

/// uBlock Origin's procedural and action operators ("Procedural cosmetic
/// filters", "Action operators") and the ABP and AdGuard forms of them,
/// which no browser's CSS parses. adblock-rust built without its
/// `css-validation` feature passes them through as CSS, and WebKit skips a
/// selector it can't parse (`loadAction` in `ContentExtensionParser`), so
/// such a rule only takes room under `MAX_RULES`. `:has()` and `:not()` are
/// CSS, which WebKit applies.
const PROCEDURAL: &[&str] = &[
    ":has-text(",
    ":matches-attr(",
    ":matches-css(",
    ":matches-css-before(",
    ":matches-css-after(",
    ":matches-media(",
    ":matches-path(",
    ":matches-prop(",
    ":min-text-length(",
    ":others(",
    ":upward(",
    ":watch-attr(",
    ":xpath(",
    ":remove-attr(",
    ":remove-class(",
    ":style(",
    ":contains(",
    ":-abp-",
];

/// A list's site name, as WebKit's domain triggers take it, or none for a
/// negated, entity (`example.*`), regex or wildcard entry, which WebKit
/// can't express.
pub fn site(name: &str) -> Option<String> {
    let name = name.trim().trim_end_matches('.').to_ascii_lowercase();
    (!name.is_empty() && !name.starts_with('~') && !name.contains(['*', '/', '|'])).then_some(name)
}

/// The hiding rule `line` (`sites##selector`) as WebKit can carry it, or
/// none when it can't be carried without hiding where the list never asked.
/// adblock-rust drops each site it can't express and keeps the rest:
///
/// - With only unexpressible sites to hide on, the rule kept its `~`
///   exceptions as `unless-domain` and hid on every other site:
///   `~vipbox.pl,vipbox.*##.position-absolute` hid that class everywhere
///   but vipbox.pl. It is left out.
/// - An unexpressible exception, `~example.*`, would be dropped and the rule
///   would hide there too. It is left out.
/// - A regex site can hold a comma, which splits it into parts that read as
///   sites. A rule with one is left out.
///
/// `*` among the sites makes the rule generic, as uBlock Origin's
/// "specific-generic" form, and adblock-rust would otherwise take `*` for a
/// host name. A trailing `:remove()` hides instead, which shows the same.
pub fn hiding_rule(line: &str) -> Option<Cow<'_, str>> {
    let Some((sites, rule)) = line.split_once("##") else {
        return Some(Cow::Borrowed(line));
    };
    // A network filter whose address holds `##`, anchored or with options.
    // A regex site is `/…/` or `~/…/`, and may hold `$`.
    let regex = sites
        .split(',')
        .any(|entry| entry.trim().trim_start_matches('~').starts_with('/'));
    if regex {
        return None;
    }
    if sites.starts_with('|') || sites.contains(['^', '$', '=', ':', '/']) {
        return Some(Cow::Borrowed(line));
    }
    // Scriptlets and HTML filters, which adblock-rust leaves out itself.
    if rule.starts_with('+') || rule.starts_with('^') {
        return Some(Cow::Borrowed(line));
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut named = 0;
    let mut dropped = false;
    for entry in sites
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if entry == "*" {
            dropped = true;
            continue;
        }
        if let Some(except) = entry.strip_prefix('~') {
            site(except)?;
            kept.push(entry);
            continue;
        }
        named += 1;
        if site(entry).is_some() {
            kept.push(entry);
        } else {
            dropped = true;
        }
    }
    if named > 0 && !kept.iter().any(|entry| !entry.starts_with('~')) {
        return None;
    }
    let selector = rule.strip_suffix(":remove()").unwrap_or(rule);
    if PROCEDURAL
        .iter()
        .any(|operator| selector.contains(operator))
    {
        return None;
    }
    if !dropped && selector.len() == rule.len() {
        return Some(Cow::Borrowed(line));
    }
    Some(Cow::Owned(format!("{}##{selector}", kept.join(","))))
}

/// The hiding an exception filter turns off, and on which sites.
#[derive(Debug, PartialEq, Eq)]
pub struct HidingOff {
    pub kind: HidingKind,
    pub sites: Vec<String>,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum HidingKind {
    /// `$elemhide`, `$ehide`: every hiding rule.
    All,
    /// `$generichide`, `$ghide`: hiding rules for every site.
    Generic,
    /// `$specifichide`, `$shide`: hiding rules for named sites.
    Specific,
}

/// The hiding the exception `rule` (what follows `@@`) turns off, if any.
/// Its sites are its `domain=` (or `from=`) sites when it has them, as
/// `@@*$ghide,domain=a.com|b.com` writes them, and else its pattern's host,
/// as `@@||a.com^$ghide`. Sites WebKit can't name are left out.
pub fn hiding_off(rule: &str) -> Option<HidingOff> {
    let (pattern, options) = rule.rsplit_once('$')?;
    let mut kind = None;
    let mut domains: Vec<String> = Vec::new();
    for option in options.split(',').map(str::trim) {
        let found = match option {
            "elemhide" | "ehide" => Some(HidingKind::All),
            "generichide" | "ghide" => Some(HidingKind::Generic),
            "specifichide" | "shide" => Some(HidingKind::Specific),
            _ => None,
        };
        // `elemhide` covers the other two when one filter names several.
        if let Some(found) = found
            && kind != Some(HidingKind::All)
        {
            kind = Some(found);
        }
        if let Some(values) = option
            .strip_prefix("domain=")
            .or_else(|| option.strip_prefix("from="))
        {
            domains.extend(values.split('|').filter_map(site));
        }
    }
    let kind = kind?;
    let sites = if domains.is_empty() {
        pattern_host(pattern).and_then(site).into_iter().collect()
    } else {
        domains
    };
    (!sites.is_empty()).then_some(HidingOff { kind, sites })
}

/// The host a network pattern anchors to: `||host^`, `|https://host/`.
fn pattern_host(pattern: &str) -> Option<&str> {
    let rest = pattern
        .strip_prefix("||")
        .or_else(|| pattern.strip_prefix("|https://"))
        .or_else(|| pattern.strip_prefix("|http://"))?;
    let end = rest
        .find(['^', '/', '*', ':', '?', '|'])
        .unwrap_or(rest.len());
    Some(&rest[..end]).filter(|host| !host.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(text: &str) -> Vec<String> {
        resolve_directives(text)
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn a_list_without_directives_is_left_as_it_is() {
        assert!(matches!(resolve_directives("##.a\n##.b"), Cow::Borrowed(_)));
    }

    #[test]
    fn keeps_a_block_whose_condition_holds_and_drops_one_whose_doesnt() {
        let text = "##.a\n!#if env_mobile\n##.b\n!#endif\n!#if env_firefox\n##.c\n!#endif\n##.d";
        assert_eq!(resolved(text), ["##.a", "##.b", "##.d"]);
    }

    #[test]
    fn takes_the_else_branch_of_a_block_whose_condition_fails() {
        let text = "!#if cap_html_filtering\nexample.com##^script\n!#else\nexample.com##+js(rmnt)\n!#endif";
        assert_eq!(resolved(text), ["example.com##+js(rmnt)"]);
        let text = "!#if env_safari\n/safari-regex/\n!#else\n/full-regex{3}/\n!#endif";
        assert_eq!(resolved(text), ["/safari-regex/"]);
    }

    #[test]
    fn resolves_nested_blocks() {
        let text =
            "!#if ext_ublock\n##.a\n!#if env_chromium\n##.b\n!#else\n##.c\n!#endif\n##.d\n!#endif";
        assert_eq!(resolved(text), ["##.a", "##.c", "##.d"]);
        let text = "!#if false\n!#if ext_ublock\n##.a\n!#else\n##.b\n!#endif\n!#endif\n##.c";
        assert_eq!(resolved(text), ["##.c"]);
    }

    #[test]
    fn evaluates_negation_and_or_and_parentheses() {
        assert_eq!(condition("!env_firefox"), Some(true));
        assert_eq!(condition("ext_ublock && !env_mobile"), Some(false));
        assert_eq!(condition("(ext_ublock && !env_mobile)"), Some(false));
        assert_eq!(condition("env_firefox || env_safari"), Some(true));
        assert_eq!(
            condition("!(env_chromium || env_firefox) && env_mobile"),
            Some(true)
        );
        assert_eq!(condition("!!ext_ublock"), Some(true));
    }

    #[test]
    fn an_unknown_token_keeps_both_branches_and_an_unknown_capability_is_false() {
        let text = "!#if env_unheard_of\n##.a\n!#else\n##.b\n!#endif";
        assert_eq!(resolved(text), ["##.a", "##.b"]);
        assert_eq!(condition("cap_unheard_of"), Some(false));
        assert_eq!(condition("env_unheard_of && false"), None);
    }

    #[test]
    fn an_expression_that_doesnt_parse_keeps_its_block() {
        for expr in [
            "",
            "(ext_ublock",
            "ext_ublock)",
            "&& ext_ublock",
            "ext_ublock &&",
            "ext_ublock env_mobile",
        ] {
            assert_eq!(condition(expr), None, "{expr}");
        }
        assert_eq!(resolved("!#if (ext_ublock\n##.a\n!#endif"), ["##.a"]);
    }

    #[test]
    fn a_directive_needs_its_whole_name() {
        // `!#iffy` and `!#endiffy` are comments, not directives.
        assert_eq!(
            resolved("!#if false\n!#endiffy\n##.a\n!#endif\n##.b"),
            ["##.b"]
        );
        assert_eq!(resolved("!#iffy\n##.a"), ["!#iffy", "##.a"]);
    }

    #[test]
    fn an_unclosed_block_runs_to_the_end_of_the_list() {
        assert_eq!(resolved("##.a\n!#if false\n##.b"), ["##.a"]);
    }

    #[test]
    fn a_stray_else_or_endif_is_ignored() {
        assert_eq!(
            resolved("!#if ext_ublock\n!#endif\n!#endif\n!#else\n##.a"),
            ["##.a"]
        );
    }

    #[test]
    fn site_takes_plain_names_and_refuses_what_webkit_cant_name() {
        assert_eq!(site("Example.COM."), Some("example.com".into()));
        assert_eq!(site("sub.example.co.uk"), Some("sub.example.co.uk".into()));
        for name in [
            "",
            "~example.com",
            "example.*",
            "*",
            "/img[a-z]+\\.buzz/",
            "a|b",
        ] {
            assert_eq!(site(name), None, "{name}");
        }
    }

    fn hiding(line: &str) -> Option<String> {
        hiding_rule(line).map(Cow::into_owned)
    }

    #[test]
    fn leaves_a_rule_webkit_can_carry_as_it_is() {
        for line in [
            "##.ad",
            "example.com##.ad",
            "a.com,b.org##.ad",
            "~a.com,~b.org##.ad",
            "example.com##+js(nowoif)",
            "example.com##^script",
        ] {
            assert!(
                matches!(hiding_rule(line), Some(Cow::Borrowed(_))),
                "{line}"
            );
        }
    }

    #[test]
    fn leaves_out_a_rule_whose_sites_are_all_entities() {
        assert_eq!(
            hiding("~vipbox.pl,vipbox.*,vipboxtv.*##.position-absolute"),
            None
        );
        assert_eq!(hiding("example.*##.promo"), None);
    }

    #[test]
    fn keeps_a_rule_on_its_named_sites_without_its_entities() {
        assert_eq!(
            hiding("example.com,other.*##.ad"),
            Some("example.com##.ad".into())
        );
        assert_eq!(
            hiding("japan-webike.*,webike.*,webike-china.cn##.ad_box"),
            Some("webike-china.cn##.ad_box".into())
        );
    }

    #[test]
    fn leaves_out_a_rule_with_an_exception_webkit_cant_name() {
        assert_eq!(hiding("~google.*##.ad"), None);
        assert_eq!(hiding("example.com,~shop.*##.ad"), None);
        assert_eq!(hiding("org,~/^example\\.org$/##h1"), None);
    }

    #[test]
    fn leaves_out_a_rule_for_regex_sites_commas_and_all() {
        assert_eq!(hiding("/img[a-z]{3,5}\\.buzz/##.ad"), None);
        assert_eq!(
            hiding("/^nitter(?:\\.[^.]+){1,2}$/,somesite.org##.item"),
            None
        );
    }

    #[test]
    fn reads_a_star_as_every_site() {
        assert_eq!(hiding("*##.ez-video-wrap"), Some("##.ez-video-wrap".into()));
        assert_eq!(
            hiding("*,~edu,~example.com##.ad"),
            Some("~edu,~example.com##.ad".into())
        );
    }

    #[test]
    fn leaves_a_network_filter_holding_two_hashes_alone() {
        for line in [
            "||example.com/page##frag$script",
            "|https://example.com/##x",
            "example.com/page##x$image",
        ] {
            assert_eq!(hiding(line), Some(line.into()), "{line}");
        }
    }

    #[test]
    fn leaves_out_procedural_and_action_operators() {
        for line in [
            "example.com##.box:has-text(Sponsored)",
            "example.com##.box:upward(2)",
            "example.com##.box:matches-path(/ads)",
            "example.com##.box:style(height: 0 !important)",
            "example.com##div:not(:has-text(News))",
            "example.com##.box:-abp-has(.ad)",
            "example.com##.box:xpath(//div)",
            "example.com##.box:remove-attr(onclick)",
            "example.com##.box:has-text(x):remove()",
        ] {
            assert_eq!(hiding(line), None, "{line}");
        }
        for line in [
            "example.com##.card:has(> .ad)",
            "example.com##div:not(.keep)",
        ] {
            assert_eq!(hiding(line), Some(line.into()), "{line}");
        }
    }

    #[test]
    fn hides_what_remove_takes_away() {
        assert_eq!(
            hiding("aranzulla.it##.banner:remove()"),
            Some("aranzulla.it##.banner".into())
        );
        assert_eq!(hiding("##.ad:remove()"), Some("##.ad".into()));
    }

    #[test]
    fn reads_every_kind_of_hiding_exception() {
        let off = |rule: &str| hiding_off(rule).map(|off| (off.kind, off.sites));
        let one = |kind, site: &str| Some((kind, vec![site.to_owned()]));
        assert_eq!(
            off("||figma.com^$generichide"),
            one(HidingKind::Generic, "figma.com")
        );
        assert_eq!(
            off("||figma.com^$ghide"),
            one(HidingKind::Generic, "figma.com")
        );
        assert_eq!(
            off("||example.com^$elemhide"),
            one(HidingKind::All, "example.com")
        );
        assert_eq!(
            off("||example.com^$ehide"),
            one(HidingKind::All, "example.com")
        );
        assert_eq!(
            off("||magyarhang.org^$shide"),
            one(HidingKind::Specific, "magyarhang.org")
        );
        assert_eq!(
            off("||example.com^$specifichide"),
            one(HidingKind::Specific, "example.com")
        );
        assert_eq!(
            off("||example.com/path/*$ghide"),
            one(HidingKind::Generic, "example.com")
        );
        assert_eq!(
            off("|https://example.com/$ghide"),
            one(HidingKind::Generic, "example.com")
        );
        assert_eq!(
            off("||example.com^$ghide,important"),
            one(HidingKind::Generic, "example.com")
        );
        assert_eq!(
            off("||example.com^$generichide,elemhide"),
            one(HidingKind::All, "example.com")
        );
        assert_eq!(
            off("||example.com^$elemhide,generichide"),
            one(HidingKind::All, "example.com")
        );
    }

    #[test]
    fn takes_an_exceptions_sites_from_its_domain_option() {
        let off = hiding_off("*$ghide,domain=web.de|gmx.*|~mail.web.de").unwrap();
        assert_eq!(off.kind, HidingKind::Generic);
        assert_eq!(off.sites, ["web.de"]);
        let off = hiding_off("$generichide,from=a.com|b.org").unwrap();
        assert_eq!(off.sites, ["a.com", "b.org"]);
    }

    #[test]
    fn ignores_an_exception_that_turns_no_hiding_off_or_names_no_site() {
        assert_eq!(hiding_off("||example.com^$script"), None);
        assert_eq!(hiding_off("||example.com^"), None);
        assert_eq!(hiding_off("*$ghide"), None);
        assert_eq!(hiding_off("*$ghide,domain=gplinks.*"), None);
        assert_eq!(hiding_off("/ads/$ghide"), None);
    }
}
