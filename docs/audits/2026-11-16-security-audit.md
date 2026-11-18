# Security audit, 2026-11-16

A point-in-time, read-only audit of Sval at `3830c75d3`. Seven area reviews
each traced the known attack classes for their area through the code:

- the security fixes Firefox has that the pinned ESR lacks
- the agent listener and sval-mcp
- sync and its cryptography
- the chrome UI's privilege boundaries
- the Gecko patches and Workspace isolation
- updates and the supply chain
- network contacts and what reaches disk

The 2026-10-24 and 2026-11-08 audits
were read first, and a finding of theirs was re-checked only where a reviewer
saw a regression. None had regressed. Line numbers in the reports were as of
`3830c75d3`.

Every finding below has since been fixed, accepted as a known limitation, or
recorded as open.

Nothing is Critical or High. The Mediums are a page's address kept in crash
reports, private windows included, and an untrusted filter list able to run
one of uBlock Origin's trusted scriptlets. Both are fixed.

## Findings and decisions

| ID | Severity | Finding | Decision |
|---|---|---|---|
| PRV-1 | Medium | Gecko recorded the address being loaded as the `URL` crash annotation, private windows included. The parent, each content process and the GPU process did so. It stayed in the report's `.extra` file, and about:crashes posted it | The annotation is removed from Gecko, with its seven writers and the two boxes that offered to include the address. Recording one fails to compile or throws |
| BL-5 | Medium | uBlock Origin registers `trusted-prevent-xhr` without `requiresTrust`, so any list could choose the body of a page's XHR responses | A scriptlet whose name or alias starts `trusted-` needs trust as well |
| PRV-2 | Low | A minidump written while a private window is open holds each thread's stack, which can hold parts of its pages | A crash keeps no minidump while private browsing is in use. A private site's process writes none. The parent writes none for itself and removes the one of every process that serves every window. A crash of Sval itself then ends it with no crash reporter window |
| WEB-3 | Low | A dialog the page under a Quick Peek opened took the keyboard behind it, so keys meant for the peeked site went back to that page | The dialog takes focus when the Quick Peek closes |
| MCP-3 | Low | sval-mcp passed `XUL_APP_FILE` to the Sval it starts, which runs the application.ini it names on the user's profile | Stripped. `LD_PRELOAD` and `DYLD_*` are left: whoever sets them already runs code in sval-mcp |
| AG-3 | Low | An app pairing again under a launch id on record kept that pairing's permissions and Workspaces, and the alert asked the same question as a first pairing | The alert says the app was paired before and what it keeps. A program that reads the app's saved secret never pairs and sees no alert, which is same-user code (decision 0088) |
| MCP-4 | Low | Any local process can hold the listener's eight unproven connections and keep agents from connecting | Open. A socket file inside the agents directory would close it |
| IMP-4 | Low | The LevelDB reader allocated whatever a table entry's shared prefix and a Snappy block's length claimed | Both are bounded by what the input can back |
| SC-6 | Low | The Linux build image and the macOS guest piped `sh.rustup.rs` into a shell | rustup-init is pinned by version and SHA-256. The guest still pipes Homebrew's installer: open |
| SC-7 | Low | The newsletter endpoint accepted posts from any site | A post whose `Origin` is another site is refused |
| UPD-1 | Low | A two-part ESR version, as a new ESR line starts with, makes the signed version compare a date with a version part. Latent at 153.7.0 | Open, for the rebase onto the next ESR line |
| UPD-2 | Low | Release candidates and releases share one MAR channel and key, so a writer of the update feed can move release users onto a signed candidate | Accepted: it needs write access to the release bucket |
| SC-8 | Low | A branch can publish the Gecko or toolchain package `main` next fetches | Accepted with SC-2: anyone who can push a branch can already merge one |
| SC-9 | Low | The installer runs `ServicesHelper.dll`, a committed binary no job rebuilds or hashes | Accepted with SC-2 |
| SC-10 | Low | The Gecko key leaves out `chrome/browser/components/sval/moz.build`, which names XPIDL sources | Accepted: adding it would recompile Gecko for every new module. Releases compile from the tag |
| SY-2 | Low | Junk files in a document directory use up the listing's cap before a peer's files are read | Accepted: a writer of the folder can as well delete the files |
| SY-3 | Low | A storage provider can show a newly paired device an old copy of one device's file, and it shows tabs since closed until the newer file arrives | Accepted. Nothing is disclosed and no honest data is dropped |
| SY-4 | Low | On Windows a backup of the key can be saved into the sync folder through a junction | Open |
| SY-5 | Info | No single device can be removed from sync. Each holds the key until Set Up Sync Again makes a new one | Accepted as a known limitation. The website's "Set up sync again with a new key" says what to do about a lost device |
| KG-1 | Low | A Kagi Privacy Pass token is handed out before its removal is saved, so a crash can send it twice | Accepted |
| GP-4 | Low | Mozilla's quarantined-domains list never reaches Sval | Accepted, as decision 1659 has it. The live list is six Brazilian bank hosts, last changed in July 2023 |
| GP-5 | Low | Downloads get no Safe Browsing check, and Linux has no operating system check behind it | Accepted: the check sends Google the name, hash and source of each downloaded program |
| RD-1 | Low | `--marionette` and `--remote-debugging-port` with `--remote-allow-system-access` work on the user's own data directory | Accepted: it needs a same-user process and a closed Sval |
| ESR-1 | Info | Three high-severity fixes on the rapid-release channel are absent from ESR 153, with their old code present (bugs 2073653, 2077770, 2086062). Mozilla's bugs are private, so whether ESR is affected is unknown | Not backported. Sval takes security fixes when the ESR line ships them |
| EXP-1 | Low | Export writes a `javascript:` favorite as it is | Accepted: it is the user's own bookmarklet |
| PRV-3 | Info | Crash files written before PRV-1 keep their `URL` line | Accepted. No build sends it, and `CrashFileCleaner` removes a crash file after 180 days |

Two reported findings were wrong. A check that the pin is the current ESR
release exists, as `esr_pin` in the nightly of `Sval/renovate-config`. The
.deb and .rpm turn the in-app updater off as Mozilla's own .deb does, by an
install directory the user cannot write, which is what decision 0094 asks.

## Still open from earlier audits

- **C1** (2026-10-24): with no closed tab in the shown Workspace, undo close
  tab can reopen another Workspace's tab closed in the same window.
- **SY-1** (2026-10-24): after Set Up Sync Again, an old key copy and the old
  directory replanted in the folder return a reinstalled device to the
  revoked key.
- **SC-3** (2026-11-08): the Windows maintenance service's certificate list.
  It runs no updater while Windows ships unsigned.

## Not read

About half of the 92 patches that touch C++, Rust or IDL were read. The
fingerprinting and site-style patches, the gtk, Wayland and Windows naming
patches, and four backports were not, nor whether Forget This Site clears
every store, nor `Sval/feedback-collector`. Whether Windows keeps a crash
record of its own after PRV-2 was not checked on a Windows machine.

## Checked and fine

- **Upstream.** The pin is the tag `FIREFOX_153_7_0esr_RELEASE`, the newest
  ESR release, taken on its release day. No ESR advisory is missing, and none
  from 153.1 to 153.7 reports exploitation in the wild.
- **Agent listener and sval-mcp.** Loopback only, a 4 KiB cap before the
  handshake, one proof attempt per connection, and the secret sent only after
  Sval proves the token. The page actor sends the parent nothing. Non-web
  loads and redirects are refused in the content policy. Uploads resolve and
  re-check their path. Unpair closes the agent's connections.
- **Sync.** Nothing from the folder is parsed before authentication but the
  pairing envelope and key copies, both capped. Moving a file to another
  device's, document's or key's path fails its tag. `sval-folder` refuses
  links and `..`, and the key never reaches it. `cargo audit` reports only
  the two advisories `engine/osv-scanner.toml` already names.
- **Chrome UI.** No `innerHTML` in chrome. Every Sval page carries
  `default-src chrome:`. The home, pin, page-rule and picker actors take the
  site and principal from the parent's records. Importers share one scheme
  filter and bind their SQL.
- **Gecko patches.** New WebIDL is chrome-only, no IPDL message is added, and
  Sval's `BrowsingContext` fields are parent-set. Script policy answers a
  null principal as its precursor and fails closed. A hostile filter list's
  `$redirect`, `$csp` and `$removeparam` do nothing.
- **Updates and the supply chain.** MAR verification is on with Sval's own
  certificates, and the updater refuses an older signed build. The release
  compile opens no shared cache. A link from another app cannot become a
  command-line flag. No secret is in the tree or its history.
- **Network and disk.** Telemetry, Normandy, Nimbus, accounts, region lookup
  and the captive portal check are off. Remote Settings syncs only the named
  collections. Sval's log lines carry ids, counts and error names. Every Sval
  file is in the profile but import's 0700 temp copy.

## Sources

- Mozilla, security advisories for Firefox ESR:
  https://www.mozilla.org/en-US/security/known-vulnerabilities/firefox-esr/
- Mozilla, product details: https://product-details.mozilla.org/1.0/firefox_versions.json
- Rajab and others, "CAMP: Content-Agnostic Malware Protection" (NDSS 2013):
  https://www.ndss-symposium.org/ndss2013/camp-content-agnostic-malware-protection
- Mozilla's Remote Settings, the `addons-manager-settings` collection:
  https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/addons-manager-settings/records
- uBlock Origin's `prevent-xhr.js`, at the commit `SvalScriptlets.sys.mjs` pins.
- Mozilla's code at the pinned ESR in `build/firefox`, cited by symbol.
