# Security audit, 2026-10-24

A point-in-time, read-only audit of Sval at `10a08094`. Six area reviews each
researched the known attack classes for their area, traced each candidate
through the code, and checked every finding of the 2026-10-18 audit (at `08fbce8e`) in their area
against HEAD. The last table but one summarizes each of those findings.
The areas were URL schemes and MIME types, privileged pages and the
content↔parent actors, the agent surface, sync and crypto, blocking and
isolation, and the Gecko patches with Sval's native code. CI and supply chain
were not re-audited. Every Medium and most Lows were re-checked against the
code before the decisions below were made. Line numbers are as of `10a08094`.

Every finding below has since been fixed or accepted as a known limitation,
those the second table marks Open included.

Nothing is Critical or High. Sval's own pages cannot be reached from the web,
chrome code has no `innerHTML`, `eval` or similar, restored tabs refuse
`data:`, `javascript:`, `file:`, `chrome:`, `view-source:`, `blob:`, `jar:` and
`resource:` (checked in xpcshell), and the engine took a million fuzzed peer
documents without a panic.

## Findings and decisions

| ID | Severity | Finding | Decision |
|---|---|---|---|
| BL-1 | Medium | Workspace jars share HSTS and site-integrity state: an HSTS supercookie links identities across isolated workspaces | Key every jar by `userContextId`, clear per jar |
| AG-1 | Medium | On Windows another OS user can bind the agent listener's port (`SO_REUSEADDR`, no `SO_EXCLUSIVEADDRUSE`) and relay the handshake | Set `SO_EXCLUSIVEADDRUSE` (Gecko patch) |
| SC-3 | Medium | The update feed can roll users back to an older signed build: the downgrade checks read unsigned `buildID` and a shared `MOZ_APP_VERSION` | Signed `<version>.<buildid>` in the MAR, compared by the updater |
| AG-2 | Low | sval-mcp passes `MOZ_*` variables to the Sval it starts, unfiltered on macOS (`MOZ_MARIONETTE`) | Strip every `MOZ_*` but `MOZ_ENABLE_WAYLAND`, every platform |
| URL-2 | Low | Pins and favorites another device writes open with the system principal and no scheme check | One `syncableAddress` filter for writer and reader; local schemes stay local |
| URL-1 | Low | A link click or `window.open` in an agent's tab reaches an external app past the gate | A per-site, per-scheme `apps` agent permission |
| SY-1 | Low | After "Start over", old key copies in the folder can return a reinstalled device to the revoked key | Known limitation |
| SY-2 | Low | `writePrivateFile` creates its temp file readable before setting 0600 | Create it 0600, under a random name |
| BL-2 | Low | Scriptlets miss a popup's initial `about:blank` | Run the opener's bundle when principals match |
| BL-3 | Low | Cert-error exceptions are shared across private sessions and workspaces | The BL-1 rule for cert overrides |
| AG-3 | Low | "Always allow uploads" covers a folder and every folder inside it | A scope choice in the alert, folder only by default |
| UI-2 | Low | Pin link interception ignores an iframe's sandbox | Skip frames with sandbox flags |
| URL-3 | Info | A page's `javascript:` link can become a favorite through the context menu | Ask first, by menu and by drop; `setPinned` refuses bookmarklets |
| BL-4 | Info | Brave's `trusted_types.js` runs from untrusted lists | Trusted permission |
| GK-1 | Info | A content process naming no window skips the agent clipboard gate | Refuse a content write with no window |
| GK-2 | Info | A content process chooses the workspace a history visit is filed under | Known limitation |
| GK-3 | Info | macOS releases are ad-hoc signed | Known (spec §8.6) |
| SY-4 | Info | RUSTSEC-2026-0385 in `ctutils` 0.4.2 | `cargo update -p ctutils` |
| UI-1 | Info | A synced peer can plant `about:privatebrowsing`, which opens a private window each time it is selected | Covered by URL-2's filter |

The privileged-UI review first reported that any web page could open private
windows without limit by navigating to `about:privatebrowsing`. That is wrong:
the page lacks `MAKE_LINKABLE` (`nsAboutProtocolHandler.cpp`), and xpcshell
confirms a web principal cannot load it.

## The 2026-10-18 findings at HEAD

| ID | Finding in the 2026-10-18 audit | Status |
|---|---|---|
| SC-3 / GP-2 | The same-version rollback check trusted the unsigned `buildID` in the update feed | Open |
| A1 / SC11 / CUI-6 | Synced prefs granted a filter list or My filters trusted-scriptlet power with no confirmation on the receiving device | Fixed: list and My filters trust is per device |
| C2 / CUI-3 / SC10 | Tabs restored from the tree loaded with the system principal and no scheme check | Fixed: `SvalRestore.restorePrincipal` |
| GP-1 | External links opened in the default jar or another workspace's jar | Fixed |
| C1 | Undo close and drag paths could load a tab once in the wrong jar before Sval moved it | Open: undo close tab reaches other windows' tabs. Both `closedTabsFrom*` prefs go false |
| D1, D2, D3 | Crash reports could upload to an unlisted host; the cert-error page contacted `mitmdetection.services.mozilla.com`; geolocation fell back to Google's location service | Fixed |
| D4 | `describeError` scrubbed file paths but not URLs, and the log guard trusted it | The rule is narrowed rather than the code changed: what Sval keeps or sends never says what the user is browsing, and the console is exempt |
| AP-1 to AP-7 | Agent actions in pages: `upload_file` touched a UNC path before asking, the upload and site-tool alerts hid files and arguments that Allow covered, an upload grant reached any readable file, "Always allow" covered tools registered later, frame loads skipped the scheme gate, and agent input gave the page user activation | Fixed (AP-3's residual is AG-3) |
| AB-1 | sval-mcp started Sval with the agent's whole environment, so `MOZ_MARIONETTE` turned on Marionette | Partly fixed; the rest is AG-2 |
| AB-2, AB-3 | A non-string `agent_id` survived Unpair; writing an AI app's config reset the file's mode and replaced symlinks | Fixed |
| AB-4 | The listener answered any well-formed challenge, so a probe learned it was Sval | The spec and comment are wrong about what a probe learns: corrected |
| AB-5 | With a non-ask default, an agent reached loopback and LAN hosts unasked | Agents always ask before a local or private-network address, by name and by `ipAddressSpace` |
| A2 | Scriptlets reached a fresh `about:blank` frame late | Frames fixed; popups are BL-2 |
| A3 | The stored scriptlet library was trusted without re-hashing when the build id matched | Known limitation: only a writer of the profile can change the stored copy |
| A4 | Filter lists were protected by TLS only, and one tracked npm `@latest` | Not a finding: every list is fetched at its latest, by design |
| GP-3 | The classifier reported ready before any engine was built, so early requests went unblocked | Open: hold classification until the engines on disk are built, never waiting on the network |
| B1, B2 | Privacy Pass refill ran inside a private Kagi search, and the issuer key was not checked across batches | Known limitation: Kagi's privacy against Kagi is out of scope |
| B3 | Any 403 on a token-carrying request emptied the token stock | Fixed |
| SC1, SC2, SC7, SC8 / CUI-4 | A corrected fast clock deleted a device's new tabs; a peer file's `seen` and `written_by` were not checked; secret writes were not flushed; the key backup was written with default permissions and a predictable temp path | Fixed |
| SC3, SC4, SC5, SC6 | A writer of the shared folder could stop a device syncing with a planted non-file, block pairing with a forged offer, make each step copy about 1 GB and force a main-thread JSON parse of about 170 MB, or drop history batches with future-dated visits | Partly fixed; the remainder is denial of service by a writer of the folder |
| CUI-1 | A web page could open Sval's private home page in a normal window | Changed: a normal window opens a private one; see UI-1 |
| CUI-2 | Settings sync applied URL prefs without Firefox Sync's `UNSYNCABLE_URL_REGEXP` check | Fixed |
| CUI-5 | Import kept `file:` and `ftp:` URLs | Unchanged: imports keep `file:` and `ftp:`, which stay local under URL-2 |
| WG-1 | The agent write gate missed a write delayed past the action window, and a GET that changes state | Fixed: delayed writes are held. A state-changing GET is a known limitation |
| WG-2, WG-3 | A service worker's own fetches cannot be attributed to a tab; a back or forward into the bfcache skips the site check on load | Known limitations; WG-3 is mitigated by `checkPage` on every read |

## Checked and fine

- Home page actors check every field against the parent's own records, are
  limited to Sval's home pages in `privilegedabout`, and the pages carry
  `default-src chrome:`.
- No `jar.mn` entry is `contentaccessible`, so web content cannot load any of
  Sval's chrome pages or dialogs.
- Grant alerts use `EnableDelayHelper`, default to the safe choice, and set
  all text with `textContent` after stripping controls and `\p{Cf}`.
- The agent handshake uses distinct HMAC prefixes, fresh nonces and
  constant-time comparison; frames are bounded before allocation, and web
  pages cannot speak the protocol.
- The element picker and page rules take the site from the parent's own
  records; saved selectors are plain CSS, and `isSafeStyle` refuses `url(`,
  `image-set(`, `@`, escapes and `expression`.
- Scriptlets run with the page's own principal through `PrecompiledScript`.
- Fingerprinting noise is keyed by the full origin-attribute suffix, so it
  differs per workspace and per private session.
- The engine's AEAD binds header and path, pairing uses a 60-bit code under
  Argon2id, and a fuzz run of a million mutated peer documents found no panic.
- The Gecko patches reviewed add no lifetime hazard; new synced
  `BrowsingContext` fields are set from the parent only.

## Sources

- WebKit, "Protecting Against HSTS Abuse":
  https://webkit.org/blog/8146/protecting-against-hsts-abuse/
- Mozilla wiki, Containers ("Not separated by Containers (On Purpose)"):
  https://wiki.mozilla.org/Security/Contextual_Identity_Project/Containers
- Microsoft, "Using SO_REUSEADDR and SO_EXCLUSIVEADDRUSE":
  https://learn.microsoft.com/en-us/windows/win32/winsock/using-so-reuseaddr-and-so-exclusiveaddruse
- Mozilla Attack & Defense, on JSActor message security:
  https://blog.mozilla.org/attack-and-defense/?p=217
- Mozilla Security Blog, blocking top-level `data:` navigations:
  https://blog.mozilla.org/security/2017/11/27/blocking-top-level-navigations-data-urls-firefox-59/
- CVE-2012-4203, a `javascript:` bookmark run with privileges from the new tab
  page: https://nvd.nist.gov/vuln/detail/CVE-2012-4203
- RUSTSEC-2026-0385: https://rustsec.org/advisories/RUSTSEC-2026-0385.html
- Mozilla's code at the pinned ESR in `build/firefox`, cited by symbol.
