# Security audit, 2026-11-08

A point-in-time, read-only audit of Sval at `f1c5bad8f`. Eight area reviews
each traced the known attack classes for their area through the code: the
agent's actions in pages, the agent listener and sval-mcp, sync, workspace
and private-session isolation, the web-facing actors and UI, import, export
and feedback, the Gecko patches, and CI and the supply chain. Findings of the
2026-10-24 audit were re-checked only where a reviewer saw a regression, and
none had regressed. Line numbers in the reports were as of `f1c5bad8f`.

Every finding below has since been fixed, accepted as a known limitation, or
recorded as open.

Nothing is Critical or High. A web page cannot reach Sval's chrome or its
agent listener, and the agent gates hold against a page steering the agent.
The Mediums are an agent tab using the user's saved device grants, upload
grants covering credential dotfiles, a long host's end hidden in the address
bar, and CI and sync trust boundaries, which were accepted.

## Findings and decisions

| ID | Severity | Finding | Decision |
|---|---|---|---|
| AGB-1 | Medium | An agent's click let a page go full screen above the agent overlay | The reported attack is refuted: Gecko refuses full screen outside the focused tab (`IsInFocusedTab`). A page's full screen ends as the agent takes its tab back |
| AGB-2 | Medium | Agent tabs used the user's saved camera, microphone and location grants | Agent tabs ignore saved grants and always ask, with no option to remember |
| AGB-3 | Medium | An upload grant on a folder covered the dotfiles in it (`.netrc`, `.git-credentials`) | Hidden files, and files in hidden folders, always ask. Windows short names count as hidden. The alert says so |
| WEB-1 | Medium | The address bar's domain label and the Peek bar clipped the end of a long host, so `accounts.google.com.example.net` could read as Google | Both clip the start and keep the end |
| SC-1 | Medium | The macOS release built its engine in a registry image any branch could overwrite | The release builds its engine in its own compile VM |
| SC-2 | Medium | Any branch's workflow can read the token that deploys sval.app | Accepted while one person develops Sval: anyone who can push a branch can already merge one |
| SYNC-1 | Medium | A peer's `javascript:` favorite runs in the site the user has open | Accepted: a peer holds the user's key, and a bookmarklet runs in the open page by design. A bookmarklet runs only on a web or `file:` page |
| ISO-1 / SYNC-2 | Medium | A peer can switch protections off and redirect DNS on every device, against spec §10.8 | Accepted: a peer holds the user's key and is the user. Spec §10.8 is narrowed to the prefs decision 0133's one-way rule names |
| AGB-4 | Low | The local-network prompt missed IPv4-mapped IPv6 literals; a public name resolving to a local address goes unasked | Mapped addresses are placed by their IPv4 address. The name case is a known limitation, and `docs/features.md` says how Sval tells a local device apart |
| AGB-5 | Low | On Windows, `upload_file` followed directory links, touching a UNC target before the alert | A path through any reparse point is refused, except dedup and cloud-file tags |
| AGB-6 | Low | A tool call that finished after Take control reported the user's page address and title | The result leaves them out |
| AGB-7 | Low | Agent screenshots show which links the user has visited | Known limitation, in `docs/features.md` |
| AGB-8 | Low | Activation from the agent's last input outlives the clipboard refusal by up to 5 seconds | Known limitation, in `docs/features.md`. Each fix found either blocked the user's own copy after a take or needed a new child-to-parent wait |
| AGB-9 | Low | On a Full-access page, writes and beacons to a site the user Blocked were sent unasked | Writes to a site a rule blocks are refused |
| GK-1 | Low | An extension turned off on a site could still read it through find, parent-domain cookies and service-worker requests | Find is refused. The cookie and service-worker paths are a known limitation, and `docs/features.md` says what the extension still gets |
| GK-2 | Low | Sval turned off the Web Console's paste warning | Every build takes release Firefox's devtools defaults: no browser debugging, no remote debugging, no chrome console output, the paste warning on. File's developer restart is removed, and unsigned add-on warnings show outside automation |
| IMP-1 | Low | A `file:` address from an imported file opened with the system principal, including one naming another machine | Imported `file:` addresses with a host are refused. Arc export and HTML bookmark files keep only `http:`, `https:` and `ftp:` |
| IMP-2 | Low | Import copied other browsers' databases to a world-readable temp folder on Linux | The copy folder is 0700 |
| IMP-3 / ISO-2 | Low | The feedback report named the sites where an extension was switched on or off | The report gives a count |
| MCP-1 | Low | sval-mcp passed Gecko's non-`MOZ_` switches (`SSLKEYLOGFILE`, `NSPR_LOG_*`, `XRE_*`) to the Sval it starts | Stripped |
| MCP-2 | Low | Unauthenticated loopback connections were uncapped and could exhaust sockets | Capped |
| SC-3 | Low | The Windows maintenance service trusts any updater Microsoft's shared Artifact Signing CAs issued to "Ellm Tree, Inc." | Open: pin the signing profile's EKU in `CheckCertificateForPEFile` once Windows signing is live |
| WEB-2 | Low | A web page can load Sval's chrome files and tell Sval from Firefox ESR | Accepted, and recorded in the fingerprinting catalogue |
| SC-4 | Info | Nothing limits the newsletter endpoint | A Cloudflare rate-limit rule |
| SC-5 | Info | The jobs holding deploy credentials ran in an unpinned `node` image | Pinned by digest |

## Checked and fine

- **Agent gates.** Every load, redirect, popup, frame and app launch in an
  agent tab is decided in the parent from its own records. File pickers,
  downloads and the clipboard are gated in Gecko by the parent's context.
  Agent input cannot reach chrome or a Gecko prompt. Site tools are listed
  only from the top document, and Always allow is bound to a hash of the
  tool's definition.
- **Agent listener.** It binds loopback only, refuses any frame above 4 KiB
  before the handshake, and a web page cannot speak its protocol. The
  handshake uses distinct prefixes, fresh nonces and constant-time checks.
  The port file and secrets are 0600 or a protected DACL. sval-mcp runs only
  absolute programs, from a cleared environment.
- **Sync.** The folder's AEAD binds the path and version. A writer of the
  folder cannot plant a key, roll back a file to resurrect data, or make a
  peer's address open with the system principal. Pairing's Argon2id
  parameters are fixed in the code. `sval-folder` refuses links, devices and
  `..`, caps every read and writes through a temp file and a rename.
- **Isolation.** Each isolated workspace and private session has its own jar,
  and every network cache Gecko keeps is keyed by the full origin
  attributes. HSTS and cert overrides keep the workspace. Page-rule CSS
  refuses every URL-taking function.
- **Web-facing actors.** Peek, pins, page rules, the element picker and the
  home pages take the site and principal from the parent's records and
  re-check every address a child sends.
- **Import, export and feedback.** No importer reads cookies, passwords or
  keys. Imported addresses pass one scheme filter, and parsers are bounded.
  Feedback posts without credentials, and what View shows is what Send posts.
- **Gecko patches.** Sval's `BrowsingContext` fields are parent-set and
  top-only. Its hooks fail closed in an agent tab.
- **CI and updates.** Actions, images and tools are pinned. Fork pull
  requests get no secrets. The 2026-10-24 rollback fix holds: the updater
  compares the signed version. MAR certificates are Ellm Tree's.

## Sources

- Brave, "Agentic browser security: indirect prompt injection in Perplexity
  Comet": https://brave.com/blog/comet-prompt-injection/
- ETH Zurich, "End-to-End Encrypted Cloud Storage in the Wild: A Broken
  Ecosystem" (2024): https://brokencloudstorage.info/
- CVE-2024-45489, Arc Boosts: https://nvd.nist.gov/vuln/detail/CVE-2024-45489
- CVE-2025-66414, DNS rebinding in the MCP TypeScript SDK:
  https://nvd.nist.gov/vuln/detail/CVE-2025-66414
- Microsoft, "Naming Files, Paths, and Namespaces" (short names):
  https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
- Mozilla's code at the pinned ESR in `build/firefox`, cited by symbol.
