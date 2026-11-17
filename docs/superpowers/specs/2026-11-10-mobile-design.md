# Sval — Mobile: iOS and Android

**Status:** Draft. A prototype is on branch `mobile-ios`.
**Date:** 2026-11-10
**Author:** John Postlethwait
**Builds on:** `2026-09-24-sval-browser-design.md` §6 (sync) and §11
(mobile commitments), `2026-10-12-protections-design.md`.

---

## 1. What this is

Sval on a phone is a full browser. It has the same Workspaces, groups, tabs,
pins and Favorites as the desktop, kept in step through the same shared
folder. It blocks ads, turns JavaScript off per site, and controls what's
playing. It isn't a viewer for the desktop's tabs.

**Success looks like:** a user closes their laptop with a Workspace open. On
the train they open Sval on their iPhone, and that Workspace is there with
the same tabs in the same groups. They read one, close two and add one. Ads
are blocked on every page. Back at the laptop, the closed tabs are gone and
the new one is there.

## 2. Platforms and engines

The main spec's §11 commitments stand.

- **iOS: a native SwiftUI app on WKWebView.** App Store guideline 2.5.6
  requires WebKit outside the EU. Mozilla builds no EU-only Gecko, so
  neither can Sval. The minimum is iOS 18.
- **Android: a native Kotlin app on GeckoView,** built from Sval's own ESR
  tree, so Android gets Sval's Gecko patches, adblock-rust blocking and
  per-site JavaScript as the desktop has them. Mozilla ships no ESR
  GeckoView. Tor Browser builds one from ESR 140, so this is possible, and
  it is a second Gecko build for CI to carry.
- **One engine, three hosts.** The Rust crate in `engine/` builds natively for
  both phones through UniFFI (feature `ffi`), alongside the WASM the desktop
  loads. The phone apps call the same checked operations the desktop's
  worker calls (`wasm.rs`), so a change made on a phone is the change the
  desktop would make.
- **The app's own UI.** Neither app forks Firefox for Android. Fenix carries
  Firefox's identity and its own tab model, and Sval's model is the
  Workspace tree. Android may use Mozilla's Android Components where one
  fits.

## 3. What comes along

| Desktop feature | iOS | Android |
|---|---|---|
| Workspaces, groups, tabs | Yes | Yes |
| Splits | Shown as their tabs; one pane at a time on a phone, side by side on iPad | Same |
| Pins and Favorites | Yes | Yes |
| Archive | Yes | Yes |
| History sync | Yes, once #2206 settles what it costs | Same |
| Settings sync | Settings that mean something on a phone (§3.1) | Same |
| Ad blocking | Content rule lists (§4) | As on desktop |
| JavaScript per site | Yes (§5) | As on desktop |
| Media controls | Yes (§6) | Yes (§6) |
| Site protections | What WebKit allows (§4.2) | As on desktop |
| Extensions | No (§7) | Yes (§7) |
| Passwords | The system's AutoFill | Android's autofill service |
| Agent Workspaces | Shown, not driven | Same |
| Peeks and Quick Peek | A link preview sheet | Same |
| Launcher | The address bar's search | Same |

### 3.1 Settings

A synced setting a phone can't honour is left alone there, and still syncs
through it unchanged: a phone never resets what it doesn't use. The settings
registry gains a platform column, and each phone reads only its own.

## 4. Ad blocking

### 4.1 iOS

- **Rules are WebKit content rule lists.** adblock-rust's `content-blocking`
  feature converts the same filter lists the desktop fetches into WebKit's
  format, on the phone, whenever a list updates. The phone fetches from the
  same publishers, so no new host joins the network-contact list.
- **What doesn't carry over:** scriptlets, procedural cosmetic filters, and
  rules that name both included and excluded domains. adblock-rust reports
  each rule it can't convert, and Settings shows how many of a list's rules
  apply on this iPhone.
- **Limits:** WebKit caps a list at 150,000 rules, and fails a larger one
  quietly. The app splits each filter list into compiled lists under the cap
  and checks that every one compiled.
- **Levels, My filters and allowed domains sync** as they do on the
  desktop. An allowed domain becomes a rule that ignores the rules before
  it, for that domain.
- **Trusted scriptlets don't apply.** WebKit can't run them.

### 4.2 Android

Blocking is the desktop's own: adblock-rust in Gecko's content classifier,
with the same lists, levels and trust rules (main spec §10.3).

## 5. JavaScript per site

- **iOS:** WebKit decides per navigation. The app turns script off for a
  page whose site's rule says so (`WKWebpagePreferences.allowsContentJavaScript`,
  iOS 14 and later). A rule reaches a page at its next load, as on the
  desktop.
- **Android:** Gecko's domain policy, as `SvalJavascript.sys.mjs` sets it.
- **The rules sync** through the settings document's JavaScript branch, so a
  site turned off on one device is off on all of them.

## 6. Media

- **Pause what's playing** from the tab list. A tab playing sound shows a
  pause button, as the desktop's Workspace panel does.
- **Controls** for whatever played last: back and forward 10 seconds,
  play/pause, previous and next track. On iOS these also go to the lock
  screen and Control Center, and on Android to the media notification.
- **Background audio and Picture-in-Picture,** as each system allows.
- iOS, measured on an iPhone with iOS 27.2 on 2026-11-10:
  - **Lock screen and Control Center:** WebKit publishes what a page plays
    there by itself; the app adds nothing.
  - **A tab the user switches away from** keeps playing by staying in the
    window behind the new tab. WebKit pauses a page that leaves the window
    and tells it it is hidden, and YouTube answers that by unloading its
    player. A page kept in the window reports itself `visible`, so a site
    has nothing to detect. It leaves the window once it stops playing.
  - **The app going to the background** hides every page whatever the
    app's views do, so the tab in front is kept playing as Firefox for iOS
    keeps it (`BackgroundAudioHelper`): its playing media is marked, WebKit's
    suspension is lifted, the page is told it is still visible, and the
    media plays again. A site can detect this, and YouTube works against it
    in other browsers.
  - **Picture-in-Picture from full screen:** YouTube calls
    `webkitExitFullscreen` as its video moves into Picture-in-Picture, and
    WebKit takes that as leaving Picture-in-Picture, in Safari too. The app
    ignores that call on a video already in Picture-in-Picture; the calls
    made to end it are untouched.
  - **Tab memory** follows the desktop (main spec §10.7): pages stay until a
    memory warning, or until three hours after the user left their
    workspace, and a page that is playing, holds typed input or uses the
    camera or microphone stays. A page let go keeps its history and scroll
    position.
- **Autoplay:** a setting for whether sound or video may start without a
  tap. On iOS it is fixed when a web view is made, so a change applies to
  tabs opened after it.
- iOS: WKWebView's pause and suspend calls (iOS 15 and later). Android:
  GeckoView's media session API.

## 7. Extensions

- **Android: yes.** GeckoView runs WebExtensions, uBlock Origin among them,
  as Firefox for Android does. Which add-ons can install, and from where, is
  an open question (§11).
- **iOS: no.** Since iOS 18.4, WebKit can run a browser's own Manifest V3
  extensions (`WKWebExtension`). It gives no access to the extensions a user
  installed for Safari, and there's no store to install from. Supporting
  that would mean Sval running its own extension catalogue, for MV3
  extensions only. The main spec's "Ever" becomes "not planned". The product
  says so plainly.

## 8. Sync on a phone

### 8.1 The folder

The user picks the same folder their desktops use, through the system's
folder picker.

- **iOS:** iCloud Drive, or any provider that offers a Files location.
- **Android:** Android has no folder-level equivalent for the big providers.
  Dropbox's app doesn't offer its files to other apps' folder pickers, Google
  Drive's doesn't reliably, and there's no iCloud Drive. So Android talks to
  each provider's API directly, behind the same folder interface the engine's
  passes use: list, read, write, delete. The Storage Access Framework stays for
  folders a provider does offer, such as a local or SMB folder.
  - **Dropbox:** full Dropbox access, because a desktop can pick any folder
    its Dropbox client keeps on disk. After signing in, the user chooses that
    folder from a list of their Dropbox folders, and Sval reads and writes
    only that one. Sign-in is OAuth 2 with PKCE, so the app holds no secret,
    and Dropbox's refresh token is kept with the sync key. The client is
    `dropbox-sdk` (Apache-2.0). It contacts `www.dropbox.com` to sign in, and
    `api.dropboxapi.com`, `content.dropboxapi.com` and
    `notify.dropboxapi.com` to sync.
  - **Google Drive:** the narrow `drive.file` scope can't see files the
    desktop's Drive client wrote, so the client needs the full Drive scope.
    That is a restricted scope, which needs Google's yearly security
    assessment before it can ship.
  - **OneDrive:** the app folder (`approot`) is synced to the desktop.
  - **iCloud Drive:** no API exists. An Android user syncing through iCloud
    can't use Sval on Android.
- **Connectors live in one Rust crate** beside the engine, reached from Swift
  and Kotlin through UniFFI as the engine is. iOS uses them too: one code path
  on both phones, and Dropbox's long-poll call tells a phone of a change
  sooner than a Files location does.
- **SMB, on both phones.** A pure-Rust SMB 2/3 client (`smb` or `smb2`, both
  MIT-licensed, so the App Store permission holds). It reaches the share only
  on the home network or over the user's VPN, which SMB users expect. The
  share's password is kept with the sync key. The iOS Files app's own SMB
  connection isn't relied on: picking a folder on a connected server is
  reported broken since iOS 26.
- **NFS isn't offered.** Neither phone mounts it for apps, its one client
  library is LGPL and GPL, and it trusts the client's address in place of a
  password.

### 8.2 What the prototype found on iOS

Measured on an iPhone 13 Pro, iOS 27.2, with iCloud Drive on 2026-11-10:

- **A file presenter on the picked folder** (`NSFilePresenter`) is told about
  a change about 6 seconds after the Mac writes it. The app starts a pass then.
  This replaces waiting for the next 30-second pass.
- **A metadata query** over external documents returns nothing for a picked
  folder, and isn't used.
- **iCloud Drive on the phone can stall for hours.** The Files app showed the
  folder two hours behind while the Mac had uploaded everything. No app can
  force iCloud to sync. Changes are delayed, never lost, and the app shows
  when it last synced.
- **A file iCloud hasn't downloaded** is listed as a placeholder. The app asks
  for it at once.
- **A pairing offer is sealed under the grouped code** (`XXXX-XXXX-XXXX`),
  so a phone opening one groups the code the user typed first.

### 8.3 When it runs

- **While open:** a pass on opening, on each change the presenter reports,
  and every 30 seconds.
- **Edits:** saved to the phone's own copy at once, and published on the next
  pass. When the app is sent to the background, it asks the system for time to
  finish that pass.
- **In the background:** a background refresh task runs a pass when iOS
  allows. iOS decides when, and how often, from how much the user uses the
  app. It's a bonus, never something the design relies on.

### 8.4 Keys

The sync key, the local key and the device id are kept in the Keychain, on
this device only and readable after first unlock. Android keeps them in the
Android Keystore. A phone joins by a pairing code or the backup key, as a
desktop does (main spec §6.7).

## 9. Layout

This spec leaves the visual design to its own pass, done with the prototype in
hand. The surfaces it needs are:

- the Workspace and its tree, reachable from any page
- the Workspace switcher
- the address bar and search
- the site menu: protections, JavaScript, allowed domain
- media controls
- Settings
- first run: choose the folder, then pair or use the backup key

## 10. Distribution

- **iOS:** the App Store. The App Store permission in Sval's license exists
  for this (decision 0119).
- **Android:** Google Play, and an APK from sval.app.
- Both carry Sval's name and art (`TRADEMARKS.md`).

## 11. Open questions

1. **Which Android connector first,** and whether Google's security
   assessment is worth starting now (§8.1).
2. **Android add-ons.** All of AMO, as Firefox for Android allows, or a list?
3. **History on phones** waits for #2206: a week's file rewritten on every
   pass is too heavy for a phone's data plan.
4. **iPad.** A sidebar and real splits make it closer to the desktop. Does it
   ship with the iPhone app or after?
5. **CI.** An iOS build needs a macOS runner with Xcode, and an Android build
   needs GeckoView from Sval's tree. Both are new jobs.

## 12. Out of scope

- Gecko on iOS.
- Syncing cookies or sessions (main spec §3.3).
- Agent control of a phone.
