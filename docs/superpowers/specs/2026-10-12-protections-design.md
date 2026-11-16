# Protections: blocking, the protection button, fingerprinting, the media gate and page rules

Date: 2026-10-12. Status: built: `SvalBlocking` and `SvalBlockingLists` (§1),
`SvalProtectionButton` (§2), `SvalFingerprinting` (§3), `SvalSiteProtections`
and `SvalSiteControls` (§4), `SvalPageRules` (§5).

One spec in five parts. The blocking engine (§1) and the fingerprinting
defaults (§3) are independent of each other. The protection button (§2) needs
both. Page rules (§5) need §1 and §2.

## 1. Blocking runs on Gecko's adblock-rust engine, with lists Sval chooses

### Rules

- **Sval unifies blocking in the engine.** Firefox's Enhanced Tracking
  Protection (ETP) and uBlock Origin overlap: ETP blocks a conservative subset
  of what uBlock Origin blocks. Sval builds one blocking feature on Gecko's own
  engine, with its own lists and defaults, and has no uBlock Origin
  integration (§1.3).
- **The engine is Brave's adblock-rust**, MPL-2.0 like Firefox and already
  vendored in Gecko. GPL-3.0 code may enter Sval, though not anything shipped
  through an app store (decisions 0111, 0119).
- **Defaults are Brave-like, with stronger lists than ETP's.** The lists are
  decision 0102 (§1.4).

### What Gecko already has

Facts from the tree pinned in `sval/upstream.txt` (153.5.0esr, `0bfb786f`).

- **adblock-rust 0.12.1** is vendored at `third_party/rust/adblock` (MPL-2.0).
- **The content classifier** (`toolkit/components/content-classifier/`) wraps
  it. `ContentClassifierService.cpp` builds one engine per feature from filter
  lists and classifies each channel in `AsyncUrlChannelClassifier.cpp`, the
  same path the URL classifier uses for ETP.
- **It is off by default.** `privacy.trackingprotection.content.protection.enabled`
  is false, and `.engines` names only `test_block`.
- **Features are compiled in.** `kFeatures` in `ContentClassifierService.cpp`
  names `trackers`, `trackers-content`, `social-trackers`, `fingerprinters`,
  `email-trackers`, `cryptominers`, `minor-exceptions` and `major-exceptions`,
  each with a fixed list of list ids, plus two test features.
- **Lists come from Remote Settings.**
  `ContentClassifierRemoteSettingsClient.sys.mjs` syncs the
  `content-classifier-lists` collection and serves each list's bytes through
  `getListBytes`. The lists are Disconnect's and Mozilla's in filter syntax.
- **The site exception already applies.** `AsyncUrlChannelClassifier`
  skips a channel that `ChannelClassifierUtils::IsAllowListed` reports, which
  is Firefox's per-site ETP exception (`ContentBlockingAllowList`).
- **It blocks network requests only.** Page rules (element hiding and
  scriptlets) are not wired up. adblock-rust has them (§5).

### 1.1 The engine

- Sval turns the content classifier on for blocking in normal and private
  windows.
- The content classifier replaces the URL classifier for ETP's blocking
  categories, so two matchers never run the same lists. The URL classifier
  keeps Safe Browsing.
- Sval runs none of Mozilla's content-classifier features, whose lists are
  Disconnect's, and fetches none of Disconnect's data (decision 1051).
- **CNAME uncloaking.** At every level but Off, a request no rule blocked is
  held before it connects while its host is resolved, and classified again
  under the host's canonical name when DNS gives the host a CNAME on another
  site (`SvalCnameUncloaking`). The uncloaked
  request is the scheme and the canonical host, third party unless the
  canonical name is on the requesting document's site. It follows uBlock
  Origin's defaults for Firefox: an exception for the request's own address,
  the allowed domains included, lets it through, and a CNAME on the request's
  own site, a top-level document and a request to its own document's host are
  left alone. The lookup uses Gecko's resolver with the channel's origin
  attributes and TRR mode, so the connection's own resolution answers from
  the same cache entry, and it contacts no host the page did not name. Under
  any proxy configuration Sval skips the lookup and matches the request's own
  host, because a proxy may hide from the local resolver the hosts it
  fetches. A channel's proxy is chosen after classification, so the check is
  whether the proxy settings send every request direct
  (`nsIProtocolProxyService2::IsEffectivelyDirect`). Measured on 2026-10-31
  across ten busy sites on macOS at Balanced, the lookup slows page loads by
  4 to 6% in total, mostly on pages with many third-party hosts. Uncloaking
  stays on at Balanced with that cost.

### 1.2 Sval's lists

- **Two blocking features by list category** (decision 1051). `trackers` runs
  the active lists whose category is trackers, and `ads` runs the rest. Both
  run the active fixes lists, so an unbreak rule reaches what it unbreaks,
  and the allowed domains come last. `trackers-content` only tags requests as
  trackers, which Firefox's cookie blocking reads, with the tracker lists, the
  fixes and Sval's tracker owners (`SvalTrackerOwners`).
- **The list ids come from data.** A feature takes its list ids from a pref
  rather than from `kFeatures`. The change is to Gecko, so it ships through
  Sval's Gecko pipeline (decisions 0063 and 0097).
- **Sval fetches its lists from each publisher.** No Sval server is in the path.
  The bytes are served through the existing `getListBytes` interface
  (`content-classifier-sval-lists.patch`, for list ids that start with
  `sval-`), so the engine loads Sval's lists the way it loads Mozilla's. A list
  that fails to download keeps its last good copy. A list never downloaded is
  skipped and logged.
- **Every publisher host is named** in `scripts/network-contact/allowed-hosts.txt`
  with its reason (decision 0060).
- **Users can add list URLs in Custom** (§1.3). A host a user adds is theirs,
  like a page they open, and the nightly host check does not apply to it.
- **An allowed-domains list.** The user can name domains that are never
  blocked, anywhere: a request to them is let through on every site, at every
  level. This differs from the protection button's site exception, which
  turns protections off for the site being visited.
- **My filters.** The user's own rules, `browser.sval.adblock.myFilters`, are
  one more list beside the level's at every level but Off.

### 1.3 Ad-blocking levels

- First run's privacy step and settings offer Off, Balanced and Strict
  (`browser.sval.adblock.level`, first-run spec §4). Each is a set of lists
  Sval curates, and the user cannot edit those sets.
- Settings adds a fourth level, **Custom**. Any edit to the lists, from any
  level, switches to Custom, starting from the lists the previous level had.
  In Custom the user has full control: switch each list on or off, add list
  URLs and remove them. Choosing a curated level again replaces the custom
  set, after a confirmation.
- Sval does not install or manage uBlock Origin. A uBlock Origin the user
  installs is their own extension.
- The level leaves ETP's category alone, because blocking has its own
  controls.
- Strict also turns on Firefox's query stripping, in place of the lists'
  query parameter rules, which the classifier cannot apply (decision 0104).
  Custom strips when it started from Strict.

### 1.4 The lists

Decision 0102 records the curated lists for Balanced, Strict and Custom, and
decision 0104 the filter syntax Sval supports.

### 1.5 Settings

A blocking section in Sval's settings (decision 0082, `settings-blocking.js`):

- the level: Off, Balanced, Strict or Custom;
- the lists in it, read-only under a curated level and editable under Custom,
  with a field for list URLs;
- the allowed domains, editable at every level.

The sites with protections off are in the Sites list, with every other
per-site choice (§2.3).

All of it syncs like other Sval settings (settings-sync spec), each entry of
a list or domain branch as a setting of its own.

### 1.6 Trusted scriptlets

uBlock Origin's trusted scriptlets can set cookies, click and rewrite
responses, so they run only from lists that hold adblock-rust's trusted
permission: Sval's copies of uBlock Origin's own lists, the added lists the
user trusts, and My filters once the user trusts them.
`browser.sval.adblock.trustedScriptlets` off trusts none. Trust is given on
each device and never syncs as a grant (Sval spec §10.3).

### 1.7 Tests

- xpcshell: a list served through `getListBytes` blocks a matching request.
- xpcshell: the site exception lets the same request through.
- xpcshell: a failed download keeps the last good copy.
- The nightly host check fails when a default list's host is not named.
- browser: changing the level changes which lists the engine loads.
- browser: editing a list under Balanced switches to Custom with Balanced's
  lists as the start.
- xpcshell: a request to an allowed domain passes on every site, even when a
  list blocks it.

## 2. One protection button in the address bar

### Rules

- **One button shows whether Sval protects the site**, and is the easy way to
  turn protection off for a site that misbehaves.
- **It replaces Firefox's shield**, and its padlock (decision 0131). Sval has
  one protection concept: blocking, cookie isolation and fingerprinting
  protection together.
- **Per site means one main switch.** Per-API switches per site were rejected:
  a user cannot tell which API broke a page, and each custom combination makes
  them more identifiable on that site. Fine-grained choices are global (§3).
  One finer switch, fingerprinting only, is kept, because fingerprinting
  protection breaks pages differently from blocking.
- **What a site may do is the site controls'** (decision 0132). Media sits
  there (§4.2), beside JavaScript and the site's permissions.
- **Per-site choices apply on every device** (§2.3).

### What Firefox already has

Facts from the tree pinned in `sval/upstream.txt` (153.5.0esr, `0bfb786f`).

- **The shield** is `#tracking-protection-icon-container` in
  `navigator-toolbox.inc.xhtml`, driven by `gProtectionsHandler` in
  `browser-siteProtections.js`.
- **A per-tab log** of what was blocked or detected:
  `browser.getContentBlockingLog()`, which the shield's panel reads.
- **Fingerprinting detection.** `nsRFPService::MaybeReportCanvasFingerprinter`
  and `MaybeReportFontFingerprinter` recognise canvas and font probing and
  report `STATE_ALLOWED_CANVAS_FINGERPRINTING` and
  `STATE_ALLOWED_FONT_FINGERPRINTING` (`nsIWebProgressListener.idl`) into the
  same log.
- **The site exception.** `ContentBlockingAllowList.sys.mjs` keeps one
  permission per site, with a separate one for private windows. Gecko skips
  both blocking (`AsyncUrlChannelClassifier.cpp`, `IsAllowListed`) and
  fingerprinting protection (`nsContentUtils`,
  `ETPSaysShouldNotResistFingerprinting`) for a site that has it.
- **Fingerprinting-only exceptions.**
  `privacy.fingerprintingProtection.granularOverrides` and
  `privacy.baselineFingerprintingProtection.granularOverrides` take JSON
  entries `{firstPartyDomain, overrides}`, keyed by eTLD+1, read by
  `FingerprintingWebCompatService.sys.mjs` and applied on the next load. Local
  entries win over the Remote Settings webcompat entries.

### 2.1 The icon

- A Sval button in the address bar's identity area. Firefox's shield and
  padlock are hidden (`sval-protection.css`).
- **Three states:** protected; protections off for this site; not
  applicable, for pages that are not http or https. The icon takes a colour
  only when the connection is wrong (decision 0131).
- **A mark** when the page's log shows something blocked or fingerprinting
  detected.

### 2.2 The panel

Clicking opens a panel. It never toggles on click, because a change needs a
reload and an accidental click would cost one.

- **What happened on this page:** trackers blocked, ads blocked,
  fingerprinting attempts detected, read from `getContentBlockingLog()`.
- **Compatibility fixes.** When one of Mozilla's compatibility exceptions
  relaxed protection on this page, the panel says so (§3.3), and the
  fingerprinting switch shows off. In a private window the switch cannot
  change it, and says why: Gecko applies the site's own entries in normal
  windows alone.
- **"Protections for this site"**, the main switch. It writes
  `ContentBlockingAllowList`'s permission, which lifts blocking and
  fingerprinting protection together. Private windows keep their own
  exception, as Firefox does.
- **"Fingerprinting protection"**, the secondary switch. Off writes a
  `-AllTargets` entry for the site, keyed by the eTLD+1 Gecko looks up
  (`siteOf`). Blocking stays on. On, where Mozilla has a fix for the site,
  stores the choice `"full"`, whose entry takes the place of Mozilla's and
  resolves to the global target set, so the site gets what the user's own
  settings give every site. The choice syncs and shows in Settings › Sites.
- **Either switch reloads the tab.**
- The padlock's panel moves in: the connection, the certificate, the
  breach alert and "Clear cookies and site data" (decision 0131).

### 2.3 Sync and settings

Per-site choices apply on every device: the protection exception, the
fingerprinting exception, the per-site settings of §3 and the media choice of
§4. Each site's choices are one pref, `browser.sval.protection.site.` and the
site, holding `{protections, media, exceptions}` as JSON, which settings sync
carries as a setting of its own. `SvalSiteProtections` writes each choice into
the store Gecko reads as session permissions and default-branch prefs, so
nothing it writes into Gecko outlives the choice. The fingerprinting entries
go in `browser.sval.protection.fingerprintingOverrides` and its baseline
counterpart, which `FingerprintingWebCompatService` reads after Gecko's
granular-overrides prefs, so a person's own entries there stay as they are.
Private-window choices stay in the private session and never sync.

Settings lists every site with a choice of its own, protections and
fingerprinting protection off included, editable and removable.

### 2.4 Code

- `SvalProtectionButton.sys.mjs` and its panel markup in Sval's component
  directory (decision 0046), with the site's choices in
  `SvalSiteProtections.sys.mjs`.
- It reads the content-blocking log with the blockers `gProtectionsHandler`
  classifies it with, rather than observing content-blocking events a second
  way.

### 2.5 Tests

- browser: the icon shows each state for an http page, an exempt site and an
  `about:` page.
- browser: the main switch writes `ContentBlockingAllowList` and reloads.
- browser: the fingerprinting switch writes the site's overrides entry, and
  canvas readback on that site is not randomized.
- browser: a private window's exception does not touch the normal window's.
- Manual: an online fingerprint test service, before and after each switch.
  CI never contacts it.

## 3. Fingerprinting protection: Sval's defaults and settings

**The decisions live in `docs/fingerprinting-catalogue.md`.** It covers every
API fingerprinters use, area by area, with a default and a control for each.
Each area opens with a decisions table, and this part says how Sval applies
them. Where the two disagree, the catalogue wins.

### Rules

- **Brave-like.** Defaults keep a user looking ordinary with low breakage.
  Blending into a uniform crowd at the cost of broken sites, as Tor Browser
  does, was rejected.
- **Holistic.** Every API was assessed. None was cherry-picked.
- **Engine-level protection only.** Spoofing extensions were rejected: page
  script patches leak through fresh iframes, workers and CSS, and are
  detectable.
- **Controls people can find.** Most choices are global settings. Per-site
  controls exist only where a user would notice the problem and know to look:
  canvas, installed fonts, speech voices, languages and the media gate. A
  per-site override nobody would discover was rejected (core count).
- **A strict option** collects the protections that cost breakage.
- **Sval looks exactly like Firefox ESR** wherever it can: user agent, API
  surface, headers, TLS and HTTP/2.
- **No default may make anti-adblock walls work better.**
- **Native Gecko changes are fine** (decision 0097).

### 3.1 Mode

- FPP on in all windows (`privacy.fingerprintingProtection`), with Sval's
  target set in `privacy.fingerprintingProtection.overrides`.
- RFP stays off. It ignores per-site exceptions and forces UTC, en-US and
  letterboxing.
- Normal and private windows get the same protections, so private mode has no
  tells (catalogue §3 line 16).

### 3.2 Default protections

#### From prefs and existing targets

| Area | Targets and prefs |
|---|---|
| Canvas | `+CanvasRandomization`, `-EfficientCanvasRandomization`. `EfficientCanvasRandomization` only tags PNG exports and shadows real pixel noise (`CanvasUtils::ImageExtractionResult`). |
| WebGL, WebGPU | `+WebGLVendorSanitize`, `+WebGPUIsFallbackAdapter` |
| Fonts | `+FontVisibilityLangPack` |
| Colours | `widget.non-native-theme.use-theme-accent=false` |
| Media | `+VideoElementMozFrames`, `+VideoElementMozFrameDelay`, `+VideoElementPlaybackQuality`, `+MediaError`, `+WebVTT` |
| Navigator | `+NavigatorHWConcurrencyTiered`, `+MaxTouchPointsCollapse`, `+PdfjsSpoof`, `+JSMathFdlibm` |
| Privacy signals | GPC on in all windows (`privacy.globalprivacycontrol.enabled`). DNT off. |
| Screen | `+ScreenAvailToResolution`, `+ScreenPixelDepth`, `+WindowScreenXY`, `+WindowInnerScreenXY`, `+MouseEventScreenPoint`, `+CSSColorInfo`, `+CSSVideoDynamicRange`, `+CSSPrefersReducedTransparency`, `+CSSInvertedColors`, `+TouchEvents` |
| Network | `media.peerconnection.ice.proxy_only_if_behind_proxy=true`. Partition proxied connections. |

`NetworkConnection` stays off: it also pins `navigator.onLine` to true, which
the catalogue keeps truthful. `DiskStorageLimit` stays off: it enforces its
quota as well as reporting it (catalogue §3 line 11).

#### Native changes

Each follows its catalogue entry.

- Screen size reported as a common resolution at or above the real one, with
  available screen and `device-width` derived from it.
- Outer window size as inner plus a typical toolbar height.
- `navigator.languages`, `Accept-Language` and the JS default locale sent as
  the primary language only, as a per-site target.
- Speech voices limited to the OS's default voices.
- Camera, mic and speaker list with a constant shape before permission.
- Gamepad ids made generic.
- Permission states reported as "prompt" where a denial is a global default.
- WebGPU `timestamp-query` hidden, liftable per site.
- OPFS working in private windows.
- Every value identical in workers, worklets and iframes. This is a
  requirement on every change above.

### 3.3 Settings

A fingerprinting section in Sval's settings (decision 0082,
`settings-fingerprinting.js`). **Every protection in §3.2 and every strict
item is a setting the user can change.** It is their browser. Advanced
settings are tucked away for clarity and never removed.

**Layout.**
- The section opens with the **Strict** switch, which turns on every strict
  item, and "Restore Sval's defaults", which resets the section.
- Settings are grouped by kind. Each group shows its main settings and its
  per-site list.
- The card ends in a collapsed **Advanced** disclosure holding each group's
  advanced switches, under the group's name (Sval spec §10.8). Advanced
  switches are Sval's defaults, on and switchable off, and strict items, off
  and switchable on alone.
- Every advanced switch carries one line on what it protects and what it can
  break, taken from its catalogue entry. For example: "Spoofs your timezone.
  Calendars and booking sites may show wrong times."

**Groups.**

| Group | Shown | Per site | Advanced: Sval's defaults | Advanced: strict items |
|---|---|---|---|---|
| Graphics | | Allow canvas (the `canvas` permission, also lifts WebGL readback noise) | Canvas noise, WebGL vendor bucketing, WebGPU fallback flag hidden | Third-party canvas extraction blocked, fixed WebGL strings, clamped WebGL and WebGPU limits, WebGL readback noise |
| Fonts and text | | Allow installed fonts | Language-pack fonts only, standard Math results | Bundled emoji font, restricted font generics |
| Appearance | Website appearance (dark mode and related queries) | | OS accent colour hidden, reduced transparency and inverted colours hidden, sRGB and standard range | Stand-in system colours, reduced motion and contrast hidden (with an accessibility warning) |
| Screen and window | | | Screen size bucketed, available screen, outer size, window position 0,0, colour depth | Tighter screen buckets, letterboxing, device pixel ratio rounded to 1 or 2 |
| Audio, video and media | | Audio sample rate, latency and channel count (real by default, normalized per site); full speech voice list | OS default voices only, constant device list before permission, video frame stats, media error text, caption loading, preload | Normalized hardware decoding, hidden hardware DRM |
| Language and region | Tell sites all my languages | Send all languages | Primary language only, matching JS locale | Spoofed timezone |
| Hardware and devices | Report my real CPU core count | | Core count bucketed, touch points collapsed, touch radius and force zeroed, generic gamepad ids, PDF viewer flag, permission states | Gamepads blocked, pen pressure and tilt normalized, spoofed keyboard layout |
| Timing | | | | Coarser timers, 60 Hz frame cap |
| Network | WebRTC: default, proxy only, or off; DNS-over-HTTPS resolver | | WebRTC never bypasses a proxy, proxied connections partitioned | Prefetch off |
| Privacy signals | Global Privacy Control | | Same protections in private windows | |
| Compatibility | | | Mozilla's compatibility fixes, off by default (decision 1685): the `fingerprinting-protection-overrides` collection and the content classifier's exception lists. Switched on, the fixes apply to every site without a choice of its own; a site's fingerprinting switch keeps them out of it (§2.2). The protection button says when a fix applied. | |

The media gate's per-site choices are §4.

A setting backed by prefs is those prefs, read and written as they are. A
setting backed by RFP targets is its own pref under
`browser.sval.fingerprinting.switch.`, and each device composes
`privacy.fingerprintingProtection.overrides` from its own build's default
string and those choices (decision 0114). The prefs sync like other Sval
settings (`SvalSettingsRegistry.sys.mjs`), apart from WebRTC's proxy-only and
the frame rate, which belong to a device. Per-site choices apply on every
device (§2.3). Firefox's own Enhanced Tracking Protection controls in
`about:preferences` are hidden, and Sval's sections replace them.

### 3.4 Out of scope here

- The DNS-over-HTTPS resolver choice (decision 0105).
- Extension UUID leaks (extension work) and agent-mode detectability (the
  agent design).

### 3.5 Tests

- xpcshell: the defaults produce the expected
  `Services.rfp.enabledFingerprintingProtections` set.
- xpcshell: each setting writes exactly its targets or prefs, and strict adds
  its list.
- browser: a page in a normal and a private window reads the same values for
  every protected API, in the page, a worker and an iframe.
- browser: each per-site setting changes only that site.
- Manual: the online fingerprint test service, before and after. CI never
  contacts it, so it is not in the named-hosts list (decision 0060).

## 4. Media plays only on sites the user allowed

Decided in the fingerprinting catalogue (`docs/fingerprinting-catalogue.md`
§2, lines 1 and 2).

### Rules

- **No site plays video or audio on its own until the user okays it.** That
  includes Web Audio.
- **The controls are the site controls** in the address pill (decision 0132):
  a media button for this visit, and the site's saved choice in the site
  menu.
- **Choices apply on every device** through settings sync.
- **Per-site choices are editable in settings.**

### What Gecko does

Facts from the tree pinned in `sval/upstream.txt` (153.5.0esr, `0bfb786f`).

- `media.autoplay.default` blocks audible media (1) or all media (5), with a
  per-site `autoplay-media` permission (`AutoplayPolicy::GetSiteAutoplayPermission`).
- **A gesture unblocks in every mode.** `IsAllowedToPlayInternal` allows play
  whenever `IsAllowedToPlayByBlockingModel` is true, which any click or key
  press on the page satisfies.
- **`OfflineAudioContext` is never gated.** `IsAllowedToPlay(const AudioContext&)`
  returns true for offline contexts.
- Realtime `AudioContext` is gated only until a gesture.

So the rule needs a native change (§4.1).

### 4.1 The gate

`media-autoplay-site-permission.patch` adds the pref
`media.autoplay.site-permission-only`. On, `AutoplayPolicy::IsAllowedToPlay`
answers for media elements and realtime `AudioContext`s from the top-level
site's `autoplay-media` permission.

- **One vocabulary, one meaning.** A site's choice and the choice for every
  site without one are the same three, named the same and listed in the same
  order everywhere: **Always allow**, **Ask first**, **Always deny**.
  - Always allow (ALLOW) plays everything, Web Audio included.
  - Ask first (`BLOCKED_ALL`) blocks all media, muted included, whatever
    the user pressed on the page, until the user allows it from the media
    button (decision 0132). A blocked attempt lights the media button.
  - Always deny (DENY) blocks the same, and the media button stays quiet.
  - A site with no choice of its own gets the default's, as if it were its
    own. The gate reads the default from
    `media.autoplay.site-permission-only.default`: 0 Ask first, 1 Always
    allow, 2 Always deny. The gate stays on under each.
- `OfflineAudioContext` keeps Gecko's exemption: it renders to a buffer and
  cannot make a sound, and a page that waits on a render that never finishes
  stands out. It renders with noise, as the fingerprinting catalogue decides.
- "Allow now" is a permission scoped to the tab, which Gecko reads ahead of
  the site's own, so it also works on a site stored as DENY.
- Media keeps working where it already has stronger consent: an active or
  granted camera, microphone or screen capture, a top-level video document,
  extension pages, and Gecko's fingerprinting-protection principal.
- `navigator.getAutoplayPolicy()` stays truthful and reports "disallowed" for
  sites that aren't allowed, so players show a play button. This is a small
  Sval tell, accepted.

### 4.2 In the site controls

- The media button is a plain on and off for this visit. It shows whether
  media plays on the page now, and lights up when the page tried to play and
  the site is on Ask first. Off, a click allows media for this visit and
  reloads. On, a click stops what plays and blocks media for the rest of the
  visit. It saves nothing.
- The site menu holds the site's saved choice, in the same three words as
  the default in Settings.
- Nothing opens on its own: the media button alone tells of a blocked play.

### 4.3 Settings

The site list in settings shows every site with a stored choice, editable and
removable, with "Use default" to put one back on the default. Above it,
"Allow sites to play video and audio" sets the default for sites with no
choice, from the same three choices. Choices and the default sync (§2.3).

### 4.4 Tests

- browser: a video and an `AudioContext` on an unapproved site stay blocked
  until the site is allowed.
- browser: allow now plays until the visit ends. Always allow plays on every
  load. Always deny stays blocked with no prompt.
- browser: the media button lights up only when something was blocked.
- browser: a choice made on one profile reaches a second through settings
  sync.
- browser: settings lists and edits the stored choices.

## 5. Page rules: element hiding and scriptlets on adblock-rust

### Rules

- **Sval's own engine does page rules too**, as there is no uBlock Origin
  integration (§1.3).
- **Licenses.** adblock-rust is MPL-2.0. Brave's browser
  glue for cosmetic filtering (`brave-core`, `components/cosmetic_filters`) is
  MPL-2.0 and is the reference design. GPL-3.0 code may enter Sval, though
  not anything shipped through an app store (decisions 0111, 0119).
- **Native changes are fine** (decision 0097).

### What exists in Gecko

- adblock-rust 0.12.1 in `third_party/rust/adblock` has the page-side API in
  `src/engine.rs`:
  - `url_cosmetic_resources(url)` returns a page's hiding selectors, style
    rules, procedural actions and scriptlet script;
  - `hidden_class_id_selectors` returns generic selectors for class and id
    names seen on a page;
  - `use_resources` loads the scriptlet library.
- Gecko's content-classifier engine crate
  (`toolkit/components/content-classifier/content_classifier_engine`) exposes
  network matching only.

### 5.1 Engine access

- `nsIContentClassifierService.pageRules` and `hiddenClassIdSelectors` expose
  them (`content-classifier-page-rules.patch`).
- One engine and one set of lists serve network and page rules, so one
  blocking level serves both.

### 5.2 Per page

A `SvalPageRules` JSWindowActor pair in Sval's component directory.

- **As the document's root element is inserted,** the child asks the parent
  for the page's rules and holds the parser with `document.blockParsing` until
  they are in, as WebExtension `document_start` content scripts are.
- **The child applies them:**
  - Hiding selectors and style rules go in as a user-level stylesheet through
    `windowUtils.loadSheetUsingURIString`, which page CSP does not govern.
  - Procedural actions run in the actor's privileged scope, reading the page
    through Xrays.
  - Scriptlets run in the page's world before the page's own scripts, as a
    `ChromeUtils.compileScript` script executed in the page's global, the way
    WebExtension `MAIN` world scripts run.
- **Generic rules.** The child watches the page for new class and id names,
  asks the parent for matching generic selectors, and adds them.
- `browser.sval.adblock.pageRules` turns page rules off while leaving request
  blocking on.

### 5.3 Scriptlet library

- uBlock Origin's GPL-3.0 scriptlets are fetched at runtime from their
  publisher as data, at a pinned commit and checked by hash, and loaded
  through `use_resources`, with the host named under decision 0060. They are
  the whole library: Sval ships no scriptlets (decision 0103).
- A rule that names a scriptlet the library lacks injects nothing.

### 5.4 Exceptions

- The protection button's site exception turns page rules off.
- Exception rules inside the lists (`#@#` and the like) are handled by the
  engine.

### 5.5 Tests

- browser, against a local test list:
  - a page element is hidden;
  - a generic rule applies after the page adds a matching class;
  - a scriptlet runs before the page's first script;
  - the site exception turns page rules off;
  - private windows behave the same.
