// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Which names a per-site rule for a host may be filed under, most specific
//! first, as the desktop's `siteOf` and `scopeChain` file them: the host,
//! then each name above it down to its site, the registrable domain under the
//! Public Suffix List. A host with no registrable domain, such as a public
//! suffix like `github.io`, is a site of its own, and only its own name
//! covers it.

/// The names to look a host's rule up under, most specific first. Empty for
/// a host the desktop's `siteOfHost` can't classify either.
#[uniffi::export]
pub fn site_names(host: String) -> Vec<String> {
    // An IP literal is its own site, named without brackets, as `nsIURI.host`
    // gives an IPv6 address.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return vec![match ip {
            std::net::IpAddr::V4(ip) => ip.to_string(),
            std::net::IpAddr::V6(ip) => ipv6_host(ip),
        }];
    }
    // `example.com.` is `example.com`, so a trailing dot can't dodge a rule.
    // Any other empty label names no host.
    let host = host.strip_suffix('.').unwrap_or(&host).to_ascii_lowercase();
    if host.is_empty() || host.split('.').any(str::is_empty) || host.contains(['/', ':', ' ']) {
        return Vec::new();
    }
    let Some(site) = base_domain(&host).map(str::to_owned) else {
        return vec![host];
    };
    let mut names = vec![host.clone()];
    let mut name = host.as_str();
    while name != site {
        match name.split_once('.') {
            Some((_, parent)) => {
                name = parent;
                names.push(name.to_owned());
            }
            None => break,
        }
    }
    names
}

/// An IPv6 address as the URL Standard serializes a host, and so as
/// `nsIURI.host` names it: hexadecimal pieces, the first longest run of two
/// or more zero pieces compressed. Rust's own form writes an IPv4-mapped
/// address with a dotted quad, which no desktop rule is filed under.
fn ipv6_host(ip: std::net::Ipv6Addr) -> String {
    let pieces = ip.segments();
    let mut run: Option<(usize, usize)> = None;
    let mut at = 0;
    while at < pieces.len() {
        let start = at;
        while at < pieces.len() && pieces[at] == 0 {
            at += 1;
        }
        let length = at - start;
        if length >= 2 && run.is_none_or(|(_, longest)| length > longest) {
            run = Some((start, length));
        }
        at = at.max(start + 1);
    }
    let hex = |range: &[u16]| {
        range
            .iter()
            .map(|piece| format!("{piece:x}"))
            .collect::<Vec<_>>()
            .join(":")
    };
    match run {
        Some((start, length)) => format!(
            "{}::{}",
            hex(&pieces[..start]),
            hex(&pieces[start + length..])
        ),
        None => hex(&pieces),
    }
}

/// Whether `host` ends in a suffix the Public Suffix List names, as Gecko's
/// `nsIEffectiveTLDService.hasKnownPublicSuffix` answers it. A suffix only
/// the list's default rule gives, such as `js` in `node.js`, is unknown.
#[uniffi::export]
pub fn has_known_public_suffix(host: String) -> bool {
    let host = host.strip_suffix('.').unwrap_or(&host).to_ascii_lowercase();
    public_suffix(&host).is_some_and(|(_, known)| known)
}

/// Gecko's Public Suffix List at the pinned commit, written by
/// `generate-psl.py`: each rule's name and its kind.
static RULES: std::sync::LazyLock<std::collections::HashMap<&'static str, u8>> =
    std::sync::LazyLock::new(|| {
        include_str!("effective_tld_names.txt")
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with("//"))
            .filter_map(|line| {
                let (name, kind) = line.split_at(line.len() - 1);
                kind.parse().ok().map(|kind| (name, kind))
            })
            .collect()
    });

const EXCEPTION: u8 = 1;
const WILDCARD: u8 = 2;

/// Where `host`'s public suffix starts, and whether a rule of the list gave
/// it, as `nsEffectiveTLDService::GetBaseDomainInternal` walks the list:
/// from the whole host up, the first name with a rule decides, and a host
/// no rule covers ends in its last label. None for an empty label.
fn public_suffix(host: &str) -> Option<(usize, bool)> {
    let mut previous: Option<usize> = None;
    let mut at = 0;
    loop {
        let name = &host[at..];
        if name.is_empty() || name.starts_with('.') {
            return None;
        }
        let next = name.find('.').map(|dot| at + dot + 1);
        if let Some(&kind) = RULES.get(name) {
            return Some(match (kind, previous, next) {
                (WILDCARD, Some(previous), _) => (previous, true),
                (EXCEPTION, _, Some(next)) => (next, true),
                _ => (at, true),
            });
        }
        match next {
            Some(next) => {
                previous = Some(at);
                at = next;
            }
            None => return Some((at, false)),
        }
    }
}

/// `host`'s registrable domain: its public suffix and the label before it,
/// or none for a host that is a public suffix itself.
fn base_domain(host: &str) -> Option<&str> {
    let (suffix, _) = public_suffix(host)?;
    let before = host[..suffix].strip_suffix('.')?;
    let start = before.rfind('.').map_or(0, |dot| dot + 1);
    Some(&host[start..])
}

/// The registrable domain adblock-rust matches a request's and its page's
/// hosts by, for `$domain=` and `$third-party`. It is adblock-rust's
/// embedded resolver with Gecko's list in place of the `psl` crate's, so
/// `addr` judges what is a domain name exactly as it does there.
pub(crate) struct Resolver;

impl adblock::url_parser::ResolvesDomain for Resolver {
    fn get_host_domain(&self, host: &str) -> (usize, usize) {
        use addr::parser::DomainName;

        if host.is_empty() {
            return (0, 0);
        }
        match Rules.parse_domain_name(host) {
            Err(_) => (0, host.len()),
            Ok(domain) => {
                let domain_len = domain.root().unwrap_or_else(|| domain.suffix()).len();
                (host.len() - domain_len, host.len())
            }
        }
    }
}

/// [`RULES`] as `addr` reads a list.
struct Rules;

impl psl_types::List for Rules {
    fn find<'a, T>(&self, labels: T) -> psl_types::Info
    where
        T: Iterator<Item = &'a [u8]>,
    {
        let mut labels: Vec<&[u8]> = labels.collect();
        labels.reverse();
        let name = labels.join(&b'.');
        match std::str::from_utf8(&name).ok().and_then(public_suffix) {
            // `generate-psl.py` keeps no rule's section of the list, and
            // `addr` reads only the suffix's length and whether a rule gave it.
            Some((start, known)) => psl_types::Info {
                len: name.len() - start,
                typ: known.then_some(psl_types::Type::Icann),
            },
            None => psl_types::Info { len: 0, typ: None },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_from_the_host_to_its_site() {
        assert_eq!(
            site_names("www.news.example.co.uk".into()),
            [
                "www.news.example.co.uk",
                "news.example.co.uk",
                "example.co.uk"
            ]
        );
    }

    #[test]
    fn stops_at_a_site_under_a_public_suffix() {
        assert_eq!(site_names("foo.github.io".into()), ["foo.github.io"]);
        assert_eq!(site_names("github.io".into()), ["github.io"]);
    }

    #[test]
    fn follows_wildcard_and_exception_rules() {
        assert_eq!(
            site_names("a.foo.bar.ck".into()),
            ["a.foo.bar.ck", "foo.bar.ck"]
        );
        assert_eq!(site_names("bar.ck".into()), ["bar.ck"]);
        assert_eq!(site_names("a.www.ck".into()), ["a.www.ck", "www.ck"]);
        assert_eq!(site_names("ck".into()), ["ck"]);
    }

    #[test]
    fn ignores_case_and_a_trailing_dot() {
        assert_eq!(
            site_names("WWW.Example.com.".into()),
            ["www.example.com", "example.com"]
        );
    }

    #[test]
    fn has_no_names_for_what_is_not_a_host() {
        assert!(site_names("".into()).is_empty());
        assert!(site_names(".".into()).is_empty());
        assert!(site_names("example.com..".into()).is_empty());
    }

    #[test]
    fn names_an_ip_address_as_itself() {
        assert_eq!(site_names("192.168.1.20".into()), ["192.168.1.20"]);
        assert_eq!(site_names("[::1]".into()), ["::1"]);
        assert_eq!(site_names("fe80::1".into()), ["fe80::1"]);
    }

    #[test]
    fn names_an_ipv6_address_as_the_url_standard_does() {
        assert_eq!(
            site_names("[::ffff:192.168.1.1]".into()),
            ["::ffff:c0a8:101"]
        );
        assert_eq!(
            site_names("2001:DB8:0:0:1:0:0:1".into()),
            ["2001:db8::1:0:0:1"]
        );
        assert_eq!(site_names("1:0:2:3:4:5:6:7".into()), ["1:0:2:3:4:5:6:7"]);
        assert_eq!(site_names("::".into()), ["::"]);
        assert_eq!(site_names("1::".into()), ["1::"]);
    }

    #[test]
    fn knows_a_listed_suffix_only() {
        assert!(has_known_public_suffix("example.com".into()));
        assert!(has_known_public_suffix("example.co.uk.".into()));
        assert!(!has_known_public_suffix("node.js".into()));
        assert!(!has_known_public_suffix("localhost".into()));
        assert!(has_known_public_suffix("www.foo".into()));
        assert!(has_known_public_suffix("a.b.ck".into()));
    }

    /// adblock-rust's embedded resolver, as `adblock::url_parser` has it,
    /// over the `psl` crate's list.
    fn embedded_domain(host: &str) -> &str {
        use addr::parser::DomainName;

        if host.is_empty() {
            return host;
        }
        match psl::List.parse_domain_name(host) {
            Err(_) => host,
            Ok(domain) => {
                &host[host.len() - domain.root().unwrap_or_else(|| domain.suffix()).len()..]
            }
        }
    }

    fn resolved_domain(host: &str) -> &str {
        use adblock::url_parser::ResolvesDomain;

        let (start, end) = Resolver.get_host_domain(host);
        &host[start..end]
    }

    #[test]
    fn resolves_the_domain_adblock_rusts_own_list_does() {
        // Hosts as adblock-rust's parser hands them over: lowercase, IDNs
        // in punycode, an IPv6 address in brackets.
        let hosts = [
            "",
            "example.com",
            "www.example.com",
            "a.b.c.example.org",
            "example.com.",
            "www.example.com.",
            "news.bbc.co.uk",
            "co.uk",
            "uk",
            "www.city.kawasaki.jp",
            "a.b.kawasaki.jp",
            "foo.bar.ck",
            "www.ck",
            "a.www.ck",
            "user.github.io",
            "github.io",
            "a.b.blogspot.com",
            "bucket.s3.amazonaws.com",
            "app.herokuapp.com",
            "foo.appspot.com",
            "node.js",
            "example.unknowntld",
            "localhost",
            "intranet",
            "192.168.1.20",
            "10.0.0.1",
            "[::1]",
            "[2001:db8::1]",
            "xn--bcher-kva.de",
            "www.xn--bcher-kva.de",
            "xn--85x722f.xn--55qx5d.cn",
            "www.xn--fiqs8s",
            "sande.xn--mre-og-romsdal-qqb.no",
            "a_b.example.com",
            "-a.example.com",
            "example.123",
            "a..example.com",
        ];
        for host in hosts {
            assert_eq!(resolved_domain(host), embedded_domain(host), "{host:?}");
        }
    }

    #[test]
    fn resolves_a_host_to_its_site() {
        assert_eq!(resolved_domain("news.bbc.co.uk"), "bbc.co.uk");
        assert_eq!(resolved_domain("user.github.io"), "user.github.io");
        assert_eq!(resolved_domain("github.io"), "github.io");
        assert_eq!(resolved_domain("www.example.com."), "example.com.");
        assert_eq!(resolved_domain("192.168.1.20"), "192.168.1.20");
        assert_eq!(resolved_domain("intranet"), "intranet");
        assert_eq!(resolved_domain(""), "");
    }
}
