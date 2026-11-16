# Firefox's images in Sval

Every image in Firefox's chrome that Sval could show and that is illustration or
a logo rather than a UI glyph, and what Sval does with it. An image that draws
Firefox's fox, Firefox's logo or a Mozilla product's logo is replaced wherever
a user can reach it. Mozilla's generic illustrations stay: they are MPL 2.0
files like the rest of Firefox, and carry no mark of Mozilla's.

Replacements are chrome overrides in `chrome/browser/components/sval/jar.mn`,
so no patch touches the pages that show them. A Lucide glyph stands in where
the image says what the surface is about, and Sval's mark where it said
"Firefox". The Lucide files are in `chrome/browser/components/sval/illustrations/`
and `icons/`, under ISC (`REUSE.toml`). `test_sval_firefox_assets.js` checks
that each overridden URL resolves to Sval's file.

`scripts/branding-inventory.sh` reads the first column of the tables below. It
finds every candidate image in the upstream tree: each raster over 4 KB, each
SVG over 3 KB that is not drawn in the theme's colour (`context-fill`), and
each file named for Firefox, Mozilla or one of their products. Rasters include
Windows and macOS icons, installer bitmaps, and the prebuilt installer stubs,
whose resources hold an icon. It fails on a
candidate no row covers, and on a row that matches nothing. A rebase that adds
or renames one of Mozilla's illustrations therefore fails the gate until the
image is decided here.

The script is a legal gate, run before any release and on every pull
request's first Linux half: Mozilla's trademark policy forbids modified builds
from using its marks. It also fails on any file under `branding/sval/` that
is byte-identical to a file in upstream's `browser/branding/*`, apart from an
allowlist kept in the script with a reason for each entry. `--markdown`
prints the full inventory as a report, generated on demand and never
committed.

## Replaced

| Asset | Where it shows | Disposition |
|---|---|---|
| `browser/themes/shared/addons/extensions-panel-empty-illustration.svg` | Extensions toolbar menu with no extensions listed | Lucide `puzzle` |
| `toolkit/themes/shared/illustrations/no-connection.svg` | Network error pages (offline, DNS, connection refused) | Lucide `unplug` |
| `toolkit/themes/shared/illustrations/security-error.svg` | Certificate and security error pages | Lucide `shield-alert` |
| `browser/themes/shared/identity-block/trustpanel-graphic-enabled.svg` | Site information panel (padlock), tracking protection on | Lucide `shield-check`, in the panel's colour |
| `browser/themes/shared/identity-block/trustpanel-graphic-disabled.svg` | Site information panel, protection off for the site | Lucide `shield-x`, in the panel's colour |
| `browser/themes/shared/identity-block/trustpanel-graphic-warning.svg` | Site information panel, insecure connection | Lucide `shield-alert`, in the panel's colour |
| `toolkit/components/satchel/megalist/content/icons/cpm-fox-illustration.svg` | about:logins with no saved passwords | Lucide `key-round` |
| `browser/base/content/logos/lockwise.svg` | about:protections password card (Firefox Lockwise's logo) | Lucide `key-round` |
| `browser/themes/shared/preferences/fox-ai.svg` | Settings, AI controls | Lucide `sparkles` |
| `toolkit/themes/shared/extensions/line.svg` | about:addons badge on an extension Mozilla built (Firefox's logo) | Lucide `badge-check`; the badge's "built by Mozilla" text is true and stays |
| `browser/components/firefoxview/content/history-empty.svg` | Sval View's empty history and recently closed lists, in about:firefoxview, which Sval keeps closed | Lucide `history` |
| `browser/components/firefoxview/content/synced-tabs-empty.svg` | Sval View's tabs from other devices, in the closed about:firefoxview | Lucide `monitor-smartphone` |
| `browser/components/firefoxview/content/synced-tabs-error.svg` | Sval View's tabs from other devices, in the closed about:firefoxview | Lucide `monitor-smartphone` |
| `toolkit/themes/shared/illustrations/kit-*.svg` | Settings default-browser card, and the promo on about:pdf, which Sval keeps closed (Kit, Firefox's mascot) | Sval's app icon (`chrome://branding/content/about-logo.svg`) |
| `browser/themes/shared/sidebar/firefox.svg` | Settings About and Languages icons | Sval's glyph (`sval-glyph.svg`) |
| `browser/themes/shared/icons/firefox-view.svg` | Sval View's icon | Sval's glyph |
| `browser/themes/shared/icons/window-firefox.svg` | Window icon in menus | Firefox's plain window icon |
| `devtools/client/themes/images/aboutdebugging-firefox-logo.svg` | about:debugging sidebar, "This Sval" | Sval's glyph |
| `devtools/client/themes/images/aboutdebugging-firefox-*.svg` | about:debugging runtime page. The local runtime and a remote desktop Firefox both take it: the icon is chosen by channel alone (`getRuntimeIcon`) | Sval's app icon |
| `devtools/client/themes/images/fox-smiling.svg` | Web console's multi-line editor onboarding | Sval's app icon |
| `other-licenses/7zstub/firefox/7zSD.Win32.sfx`, `other-licenses/7zstub/firefox/7zSD.ARM64.sfx`, `other-licenses/7zstub/firefox/setup.ico` | The full Windows installer's .exe: its icon, and the names in its Properties (Firefox's logo in a box, "Mozilla", "Firefox") | Sval's copies of the stubs in `branding/sval/`, with Sval's app icon and names, which `scripts/generate-branding.sh` writes and `installer-sval-stub.patch` builds the installer from |

## Kept

| Asset | Where it shows | Disposition |
|---|---|---|
| `toolkit/themes/shared/illustrations/about-license.svg` | about:license | Kept: a generic document |
| `toolkit/themes/shared/illustrations/error-malformed-url.svg` | Certificate viewer error | Kept: a generic creature, no mark |
| `toolkit/themes/shared/illustrations/shield-alert.svg`, `toolkit/themes/shared/illustrations/shield-check.svg` | Settings security card | Kept: generic shields |
| `toolkit/components/aboutconfig/content/background.svg` | about:config warning | Kept: a generic warning sign |
| `browser/base/content/aboutRobots-icon.png` | The slow-page notification (`ProcessHangMonitor`), and about:robots, which Sval keeps closed | Kept: a generic robot |
| `browser/themes/shared/customizableui/empty-overflow-panel*.png`, `browser/themes/shared/customizableui/whimsy.png` | Toolbar customization | Kept: generic creatures, no mark |
| `browser/themes/shared/panic-panel/header@2x.png` | Forget button panel | Kept: a generic reset arrow |
| `browser/themes/shared/tabbrowser/connecting*.png`, `toolkit/themes/shared/media/*.png`, `toolkit/themes/shared/icons/pendingpaint.png` | Tab and media loading | Kept: spinners |
| `toolkit/themes/shared/icons/arrow-counterclockwise-16.svg`, `toolkit/components/pdfjs/content/web/images/cursor-editorTextHighlight.svg` | UI glyphs | Kept: glyphs |
| `toolkit/themes/shared/icons/EU-trust-mark*.svg` | Site information panel, for a site with an EU qualified certificate | Kept: the EU's mark, nominative |
| `toolkit/components/pdfjs/content/web/images/altText_disclaimer.svg` | PDF viewer alt text | Kept: generic sparkles |
| `browser/components/preferences/etp-advanced-banner.svg`, `browser/components/preferences/etp-toggle-promo.svg`, `browser/components/preferences/spell-check-promo.svg` | Settings, privacy and languages | Kept: generic UI sketches |
| `browser/themes/addons/alpenglow/preview.svg` | about:addons themes | Kept: a colour preview |
| `browser/themes/*/monitor-base.png`, `browser/themes/*/monitor-border.png`, `browser/themes/*/pageInfo.png` | Set as desktop background, Page Info | Kept: generic |
| `browser/components/migration/content/brands/*.png` | Import from another browser | Kept: the other browsers' logos, nominative. Sval's import shows Chrome's, Edge's and Safari's from here, and adds Arc's and Firefox's own in `chrome/browser/components/sval/import-brands/`, also nominative: Firefox's is `browser/branding/official/default128.png`, copied unchanged, and names Firefox as the browser being imported from |
| `browser/extensions/formautofill/content/third-party/*.svg` | Saved payment cards | Kept: card networks' logos, nominative |
| `browser/extensions/webcompat/shims/*.svg` | Placeholders for blocked third-party embeds | Kept: the embedded sites' logos, nominative |
| `devtools/client/themes/images/browsers/firefox.svg` | DevTools compatibility panel and responsive design mode | Kept: names Firefox as a browser a page targets, nominative |
| `devtools/client/themes/images/aboutdebugging-fenix*.svg` | about:debugging, a connected Firefox for Android | Kept: names that browser, nominative |
| `devtools/client/debugger/images/sources/*.svg` | Debugger source tree | Kept: web frameworks' logos, nominative |
| `toolkit/mozapps/installer/windows/nsis/setup.ico` | The Windows installer's and uninstaller's window and taskbar icon (`MUI_ICON`, `MUI_UNICON`) | Kept: a generic box and disc |
| `toolkit/mozapps/update/updater/updater.ico`, `toolkit/mozapps/update/updater/macbuild/Contents/Resources/updater.icns` | The updater's window while an update installs | Kept: generic arrows |
| `toolkit/crashreporter/client/app/macos_app_bundle/Resources/crashreporter.icns` | The crash reporter on macOS | Kept: a generic bug on a screen |

## Out of scope: unreachable in Sval

| Asset | Where Firefox shows it | Why Sval does not |
|---|---|---|
| `browser/extensions/newtab/**` | New tab and Firefox Home | Sval's home page replaces both (`sval-home-page.patch`) |
| `browser/components/topsites/**` | Default top sites | No default sites, and no Firefox Home (`app-sval-prefs.js`) |
| `browser/components/aboutwelcome/**` | Onboarding and what's new | `browser.aboutwelcome.enabled` off; Sval's first run replaces it |
| `browser/components/asrouter/**`, `browser/themes/shared/app-marketplace-icons/**` | Firefox's messages and mobile promos | Every message provider off (`app-sval-prefs.js`) |
| `browser/components/aboutlogins/content/icons/intro-illustration.svg` | A password-manager message | Messages off |
| `browser/components/privatebrowsing/**`, `browser/themes/shared/privatebrowsing/fox-tail.svg` | about:privatebrowsing | Sval's private page replaces it (`jar.mn` override) |
| `browser/components/ipprotection/**` | Firefox's VPN | Locked off |
| `browser/components/aiwindow/**`, `browser/components/genai/**`, `browser/themes/shared/icons/smart-window*.svg`, `toolkit/components/ml/**` | AI window, chatbot and link previews | Locked off (`browser.ai.control.*`, `browser.ml.*`) |
| `browser/themes/shared/fxa/**`, `browser/base/content/logos/fxa-logo.svg` | Mozilla accounts, sync, send tab to device | `identity.fxaccounts.enabled` locked off |
| `browser/base/content/logos/monitor.svg`, `browser/base/content/logos/relay.svg`, `browser/base/content/logos/vpn*.svg` | about:protections and settings promos | Locked off; the Monitor card is off by Firefox's default |
| `browser/themes/shared/preferences/monitor-logo.svg`, `browser/themes/shared/preferences/relay-logo.svg`, `browser/themes/shared/preferences/vpn-logo.svg`, `browser/themes/shared/preferences/mozilla-16.svg`, `browser/themes/shared/preferences/mozilla-logo.svg`, `browser/themes/shared/preferences/thunderbird-color-16.svg`, `browser/themes/shared/preferences/solo-ai-logo.svg`, `browser/components/preferences/more-from-mozilla-qr-code-simple.svg` | Settings, More from Mozilla and account | `browser.preferences.moreFromMozilla` locked off; the account groups and chatbot providers are hidden (`settings-hide-removed-features.patch`) |
| `browser/components/controlcenter/content/assets/*.svg` | Breach alerts in the site information panel, and its Nova graphics | Breach alerts locked off; `browser.nova.enabled` is off |
| `browser/themes/shared/illustrations/tab-groups.svg` | Tab groups | Locked off |
| `browser/themes/shared/sidebar/foxy.svg` | Vertical tabs pin promo | Vertical tabs locked off |
| `browser/components/firefoxview/content/callout-tab-pickup*.svg` | Sval View's tab pickup, which needs sync | Accounts locked off |
| `browser/themes/shared/profiler-popup-backdrop.png` | Profiler button | Locked off |
| `browser/components/contentsharing/**` | Content sharing | `browser.contentsharing.enabled` off |
| `toolkit/mozapps/defaultagent/**` | Default-browser notification | `default-browser-agent.enabled` locked off |
| `toolkit/components/normandy/**` | Heartbeat surveys | Normandy off |
| `browser/fxr/**` | Firefox Reality | Not part of desktop |
| `browser/installer/linux/app/flatpak/**` | The Flatpak package | Sval ships a tarball, a .deb and an .rpm (`packaging/linux/`) |
| `other-licenses/7zstub/src/**` | 7-Zip's own icons and stubs, in the LZMA SDK source | Never built: the installer uses the prebuilt stub, in Sval's copy |

## Firefox and Mozilla in the text beside these images

Strings next to the images name the brand through `-brand-short-name`, which
is Sval. The rest name Mozilla where Mozilla is the subject, which is accurate
and stays:

| String | Where | Disposition |
|---|---|---|
| "violates Mozilla's policies" | Extensions menu, about:addons | Kept: addons.mozilla.org's policies, which govern Sval's extensions |
| "Official extension built by Mozilla", "Mozilla only recommends…" | about:addons badges | Kept: true of those extensions |
| "the Mozilla CA store" | Certificate error page | Kept: Sval uses Mozilla's CA store |
| `firefox-ai-controls` | Settings, AI controls "Learn more" | A URL slug under sval.app (`docs/outbound-links.md`), never shown |
