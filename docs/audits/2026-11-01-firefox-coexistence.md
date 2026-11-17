# Firefox coexistence audit, 2026-11-01

This audit covers every name, path, identifier, and operating-system service Sval uses that an
installed Firefox for the same user might also use (decision 1738). It was done
at `ba6230b4` by reading `build/firefox/` with the series applied and
`application.ini` from a development build. Runtime checks run in
`browser_sval_coexistence.js`. The installers and the Linux desktop
integration were judged from source.

Sval's identity going in:

- `MOZ_APP_VENDOR`, `MOZ_APP_PROFILE`, and `MOZ_APP_BASENAME` are `Sval`.
- The remoting name is `sval`.
- The macOS bundle id is `app.sval.sval`.
- `MOZ_APP_NAME` is `firefox`.
- The application id is Firefox's `{ec8030f7-c20a-464f-9b0e-13a3a9e97384}`.

Any name derived from the first three is Sval's own. Any name that is hard-coded, or derived from the last two, needed a check.

Verdicts: **Fixed** means a collision this audit fixes. **Open** means a
collision still to be decided. **Elsewhere** means another
change covers it. **Harmless** means names coincide but no state is
shared. **Own** means the name is already Sval's.

## Every platform

| Item | Where Gecko decides it | Verdict |
|---|---|---|
| Data directory, profile, cache, Crash Reports, Pending Pings, background-task profiles | `nsXREDirProvider`, `one-data-directory.patch`, from `MOZ_APP_PROFILE` | Own |
| System and user extension folders (`Mozilla/Extensions/{app id}`, `~/.mozilla/extensions`, `/usr/{lib,share}/mozilla/extensions`) | `nsXREDirProvider::GetFile`, `XPIProvider` keyed by the app id | Fixed: `--disable-system-extension-dirs` |
| Native messaging, ManagedStorage, PKCS#11 manifest folders and registry key | `XRE_{USER,SYS}_NATIVE_MANIFESTS`, `NativeManifests.sys.mjs` `REGPATH` | Fixed: `native-messaging-manifests.patch` reads `~/Library/Application Support/Sval` and `/Library/Application Support/Sval`, `~/.sval` and `/etc/sval`, `Software\Sval`. On macOS, `apple-passwords-manifest.patch` also reads `com.apple.passwordmanager.json`, a file macOS installs, from `/Library/Application Support/Mozilla`, and nothing else in that folder. |
| Certificates policy's search folders (Windows: the Mozilla directories in AppData) | `Policies.sys.mjs` `Certificates` | Fixed: the application data directory |
| Enterprise policies | `SysConfD` = `/etc/sval`, `SOFTWARE\Policies\Mozilla\Sval`, the `app.sval.sval` defaults domain | Own |
| Remote control and single instance (D-Bus `org.mozilla.sval.*`, Windows `Mozilla_sval_*_RemoteWindow`, macOS message port, startup lock) | `nsRemoteService`, from the remoting name | Own |
| OS key store labels | `OSKeyStore.STORE_LABEL`, from `MOZ_APP_BASENAME` | Own (Linux libsecret shares the schema name `mozilla.firefox`, but items are keyed by label) |
| Crash reporter client's data folder | `config.rs`, from the crash's Vendor and ProductName | Own |
| Profile migration at startup | `nsAppRunner` runs it only for `-migration` or a reset | Harmless |
| Import from Firefox | `SvalImportFirefox.sys.mjs` reads `profiles.ini` when the user opens Import | Harmless: the user starts it (decision 1738) |
| Firefox Bridge native host `org.mozilla.firefox_bridge_nmh` | `FirefoxBridgeExtensionUtils`, behind `browser.firefoxbridge.enabled` (false) | Harmless while off |
| Firefox Accounts and Sync | `identity.fxaccounts.enabled` locked false | Harmless |
| Marionette, Remote Agent, and DevTools server ports | Off unless started | Harmless |
| `MOZ_APP_NAME` as process name | `--with-app-name=sval` | Fixed: `sval`, `sval.exe` |
| Child process executable `plugin-container` (every child process on macOS, media plugins on Windows) | `MOZ_CHILD_PROCESS_NAME`, `toolkit/moz.configure` | Fixed: `sval-child`, `helper-names.patch` |
| Crash helper `crashhelper` and crash reporter `crashreporter` | `toolkit/crashreporter` | Fixed: `sval-crash-helper`, `sval-crash-reporter` |
| Updater `updater`, `updater.exe`, and `org.mozilla.updater` in `updater.app` | `toolkit/mozapps/update/updater` | Fixed: `sval-update` |
| `pingsender` | `toolkit/components/telemetry/pingsender` | Harmless: Sval never starts it, since telemetry upload is locked off |
| Fallback product directory `MOZ_USER_DIR` | `nsAppFileLocationProvider` | Fixed: `--with-user-appdir=.sval` |

## macOS

| Item | Verdict |
|---|---|
| Application Support, Caches, and update folders (`~/Library/Application Support/Sval`, `~/Library/Caches/Sval`) | Own |
| Defaults domain, notifications, Launch Services, TCC, and saved state, keyed by the bundle id | Own |
| Development builds against the installed Sval (bundle id, helpers, keychain service) | Elsewhere: dev builds carry their own identity, and helpers act on their own bundle |
| Helper bundle ids (`org.mozilla.updater`, privileged helper, `dmgInstallHelper`, `crashreporter`, `nmhproxy`) | Elsewhere: helpers act on their own bundle, under Sval's ids |
| `os_log` subsystem `org.mozilla.firefox` (`MacRunFromDmgUtils.mm`) | Harmless: log category only |

## Windows

| Item | Verdict |
|---|---|
| Installer `AppName` "Firefox": `Software\Mozilla\Firefox\{TaskBarIDs,32to64DidMigrate,Installer}` and the default agent's `Firefox.lnk` cleanup | Fixed: `windows-own-names.patch` |
| `Uninstalled-<channel>` in `Software\Mozilla\Firefox`, read and deleted by `BrowserGlue` | Fixed |
| Launcher process key written to `Software\Mozilla\Firefox\Launcher` | Fixed |
| `Software\mozilla.org\Mozilla` `CurrentVersion` | Fixed: removed |
| `%LOCALAPPDATA%\Mozilla\Firefox\postSigningData` moved or deleted | Fixed: removed |
| `App Paths\firefox.exe` | Fixed: taken only when free, removed only when Sval's |
| `HKCR\Applications\firefox.exe`, ShimInclusionList, xpinstall MIME key, installer `FindWindow` check, `maintenanceservice.exe` wait, `FirefoxHTML` prefix checks | Fixed: keyed by `sval.exe`, `windows-own-progids.patch` |
| Update service, its key, folder, and ProgramData root | Own (`update-service-name.patch`) |
| `StartMenuInternet`, `RegisteredApplications`, ProgIDs, taskbar and toast AUMIDs, jump lists, BITS job, WER module | Harmless: each ends in the install-path hash, or is the install path |
| Window classes (`MozillaWindowClass` and others) | Harmless: registered per process |
| Scheduled tasks, default agent mutex, event log sources, skeleton UI key, registry add-on locations, Credential Manager labels | Own |
| `desktop-launcher.exe` (looks for Firefox) | Harmless: not installed |
| `maintenanceservice.exe`, `maintenanceservice_tmp.exe`, and `maintenanceservice_installer.exe` | Fixed: `sval-update-service.exe` and `sval-update-service-installer.exe`, `helper-names.patch` |
| `private_browsing.exe` and its tile manifest | Fixed: `sval-private-browsing.exe` |
| `default-browser-agent.exe`, the scheduled task's program | Fixed: `sval-default-agent.exe` |
| `nmhproxy.exe`, and `nmhproxy` on macOS | Harmless: Sval never registers it, since the Firefox Bridge is off |
| Media Player `ShimInclusionList` entry for the child process | Fixed: Sval's is `sval-child.exe`, and the uninstaller removes it |
| DDE `ddeexec` Application "Firefox" | Harmless: Gecko runs no DDE server |

## Linux

| Item | Verdict |
|---|---|
| Data directory `~/.sval`. Without a dotted user directory, Gecko made an empty `~/Sval` on the way | Fixed: `--with-user-appdir=.sval` |
| Crash helper log in `~/.mozilla/firefox/Crash Reports` (`crash_helper_server` `guess_user_app_data_dir`) | Fixed: `linux-own-names.patch` |
| MPRIS bus name `org.mpris.MediaPlayer2.firefox.*` | Fixed |
| Wayland picture-in-picture app id `org.mozilla.firefox` | Fixed |
| Graphics and video probes `glxtest`, `vaapitest`, `v4l2test`, `vulkantest` | Fixed: `sval-glx-test`, `sval-vaapi-test`, `sval-v4l2-test`, `sval-vulkan-test`, `helper-names.patch` |
| GNOME search provider result icon `firefox` | Fixed |
| Desktop portal host app id `org.mozilla.firefox` (`DoRegisterHostApp`) | Fixed: `linux-desktop-id.patch` registers `app.sval.sval` |
| Desktop entry name, and the notifications' and MPRIS's `desktop-entry` | Fixed: `app.sval.sval.desktop`, named by the same id; `StartupWMClass=sval` ties it to the windows |
| `x-www-browser` and `gnome-www-browser` alternatives at Mozilla's priority 100 | Fixed: 40 |
| prgname, WM_CLASS, Wayland app id, inhibitors, D-Bus remote, search provider bus name | Own |
| Install path `/usr/lib/sval`, `/usr/bin/sval`, AppArmor profile, RPM spec | Own |
| Snap default-browser call with `firefox.desktop` | Harmless: Sval ships no snap |
| Environment variables Firefox also reads (`MOZ_LEGACY_HOME`, `MOZ_APP_LAUNCHER`, and others) | Harmless: set by the user |
