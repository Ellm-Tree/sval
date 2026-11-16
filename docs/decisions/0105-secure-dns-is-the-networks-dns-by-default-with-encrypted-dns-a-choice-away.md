# 0105. Secure DNS is the network's DNS by default, with encrypted DNS a choice away

**Status:** Accepted on 2026-10-15.

## Context

DNS over HTTPS and ECH on by default, with a privacy-respecting resolver, is
the fingerprinting catalogue's proposal (§4). Encrypted DNS hides lookups from
the network, but it also bypasses whatever the network's DNS does on purpose: internal names on a home
or work network, a VPN's resolver, a router's filters such as a Pi-hole.
Firefox's own answer is its DoH rollout, which picks a resolver for the user
by region; Sval turns that off.

Firefox offers encrypted DNS as four levels: Default (mode 0), Increased
(mode 2, falling back to the network's DNS), Max (mode 3, no fallback) and
Off (mode 5). Its provider list comes from the `doh-providers` and
`doh-config` Remote Settings collections, which Sval does not sync, unless the
`doh-rollout.provider-list` pref is set, which outranks them. ECH is on in
Gecko by default (`network.dns.echconfig.enabled`,
`network.dns.http3_echconfig.enabled`) and gets its configs from encrypted
DNS.

Mullvad shuts down its public DoH service on 2026-11-02 and sponsors Quad9
instead.

## Decision

- **The default is the network's own DNS** (`network.trr.mode` 0). Mozilla's
  rollout stays off.
- **Secure DNS is a card in Privacy and protection** with three choices: the network's
  DNS, encrypted with fallback (mode 2) and encrypted only (mode 3). It uses
  Firefox's own DoH controls for the resolver, its status, a custom URL and
  the names that always use the network's DNS
  (`network.trr.excluded-domains`). The category does not show Firefox's DoH
  group.
- **The resolvers are Quad9 (pre-selected), Cloudflare and a custom URL**,
  pinned in `doh-rollout.provider-list` and `network.trr.default_provider_uri`
  rather than taken from Remote Settings. Each URL is its provider's
  documented endpoint: `https://dns.quad9.net/dns-query` (Quad9's service
  addresses page, the recommended service) and
  `https://cloudflare-dns.com/dns-query` (Cloudflare's 1.1.1.1 DoH
  documentation). Mullvad is left out because its service is closing.
- **ECH is on whenever encrypted DNS is on**, through Gecko's defaults.
- **The choice lives in Settings alone.** The Privacy and Security panel is
  about the site you are on (decision 0131), and this is one choice for every
  site.
- **The choice syncs**, with the resolver URL, custom or not, and the
  excluded names.

## Consequences

- A fresh profile resolves names exactly as other software on the machine
  does, so nothing on the user's network breaks.
- Pinning the list keeps the resolvers Sval's decision: allowing Mozilla's
  collections would add a Remote Settings sync for a list that offers neither
  Quad9 nor this order, and let Mozilla change it.
- `dns.quad9.net` and `cloudflare-dns.com` are opt-in contacts (§10.9): only
  once the user picks encrypted DNS, and only the chosen one.
- "Encrypted only" breaks every site when the resolver cannot be reached, as
  Firefox's Max Protection does; the card says so.
- A synced "Encrypted only" applies on every device, including one on a
  network that blocks the resolver.
- Adding or removing a resolver is a new decision.
