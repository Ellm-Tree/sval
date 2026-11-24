# Sval for iPhone

The iPhone app is a SwiftUI browser on WKWebView. It syncs the same
Workspaces, groups, tabs, favorites, history, and settings as the desktop,
through the same shared folder. The sync engine is the Rust crate in
`engine/`, built natively with its `ffi` feature.

## Layout

- `Sval/`: the app's Swift code.
- `SvalTests/`: unit tests. `SvalUITests/`: UI tests that walk through the
  app in the simulator.
- `project.yml`: XcodeGen's description of the project. `Sval.xcodeproj`
  is generated from it.
- `build-engine.sh`: builds `mobile/sval-mobile` (the engine, the SMB
  connector, ad blocking, and site names) for the iPhone, its simulator, or
  both, and writes the Swift bindings to `Generated/`.
- `make-icons.sh`: writes `Generated/Icons.xcassets` and the app icon,
  `Generated/AppIcon.icon`, from the desktop's glyphs and brand art.
  XcodeGen runs it before it writes the project.
- `watch-log.sh`: follows the app's log on a connected iPhone.

`Generated/` is never committed.

## What you need

- Xcode, with the iOS simulator runtime that matches its SDK.
- XcodeGen: `brew install xcodegen`.
- Rust through rustup. `build-engine.sh` adds the iOS targets itself.
- To run on an iPhone: an Apple ID on Ellm Tree's team signed in to Xcode,
  and Developer Mode turned on in the iPhone's Settings › Privacy &
  Security.

## Build

From the repository's root:

    mobile/ios/build-engine.sh simulator   # after any change under engine/ or mobile/sval-mobile/
    (cd mobile/ios && xcodegen generate)   # after adding or removing a file

`build-engine.sh` builds for the slices it's given: `simulator`, `device`
for an iPhone, or both. The app builds only for the slices last built.

To build and run from Xcode, open `mobile/ios/Sval.xcodeproj`, choose the
iPhone or a simulator, and press Run.

## Install on an iPhone from the command line

Find the iPhone's identifier with `xcrun devicectl list devices`, and set
`DEVICE` to it. Then, in `mobile/ios`:

    ./build-engine.sh device
    xcodebuild -project Sval.xcodeproj -scheme Sval -destination "id=$DEVICE" \
      -derivedDataPath build -allowProvisioningUpdates build
    xcrun devicectl device install app --device "$DEVICE" build/Build/Products/Debug-iphoneos/Sval.app

Installing works over Wi-Fi once the iPhone has been paired with the Mac.

To judge how fast the app is, install a Release build in place of the
Debug build above. A Release build is what users get, with the engine built
as the App Store build is and the app's Swift code optimized.

    ./build-engine.sh --ship device
    xcodebuild -project Sval.xcodeproj -scheme Sval -configuration Release \
      -destination "id=$DEVICE" -derivedDataPath build -allowProvisioningUpdates build
    xcrun devicectl device install app --device "$DEVICE" build/Build/Products/Release-iphoneos/Sval.app

Use Debug to read the app's log with `watch-log.sh` or to open the demo
with the launch options, because a Release build writes no log file and
ignores the launch options.

## Upload to TestFlight

From the repository's root, with a build number higher than any uploaded
for the version in `project.yml`:

    mobile/ios/upload-testflight.sh 2

The script builds the engine, archives the app, and uploads it to App
Store Connect, signed with the Apple account signed in to Xcode. With
`ASC_KEY_PATH`, `ASC_KEY_ID` and `ASC_ISSUER_ID` set, it signs with that
App Store Connect API key instead. The build appears in App Store
Connect's TestFlight tab once Apple has processed it.

Release builds come from CI instead: CI builds the app unsigned with
`archive-unsigned.sh`, and the owner's release repository signs and
uploads it.

## Release the iPhone app

The iPhone app has version numbers of its own, starting at 0.1.0. A desktop
`v*` tag never releases the iPhone app. An `ios-v<version>` tag does, and
only maintainers can push one.

1. For every version after the first on the App Store, add the version's
   "What's New" text as `mobile/ios/whats-new/<version>.txt`. Write plain
   text, at most 4,000 characters, following `docs/writing-style.md`'s
   release notes rules, and merge the file. Without the file, type the text
   in App Store Connect before you submit.
2. Push the tag on a commit on `main`, such as `ios-v0.1.1`.
3. Once the release's text says the build is ready to submit, select **Add
   for Review** in App Store Connect, then **Submit to App Review**.
4. Once Apple approves the version, select **Release This Version**.

Between steps 2 and 3, CI's `ios-build.yml` builds the tag's commit,
unsigned, in about twenty minutes once the Mac runner is free. Within five
minutes of the build finishing, the release repository signs the build with
the tag's version and the next build number. The release repository then
uploads the build to App Store Connect and waits for Apple to accept the
build into TestFlight. Then the release repository creates App Store
version `<version>`, or renames the version being prepared. It attaches the
build and sets "What's New" from the file. A release named "Sval for iPhone
`<version>`" on this repository records the upload, and the release's text
says how the upload ended.

If something fails:

- **The build fails in CI.** Re-run the `ios-build.yml` job, or delete the
  tag and push it again on a commit with the fix. No newer `ios-v*` tag
  uploads until then. A tag on a commit off `main` always fails, so delete
  that tag.
- **The upload fails.** The release's text says so, and the release
  repository doesn't try the upload again. Delete the release, and the
  release repository uploads the tag again within five minutes.
- **The version is already in review or on the App Store.** That version
  can't take a new build, so tag a new version.

`MARKETING_VERSION` in `project.yml` is the version of builds made from
`main` without a tag, which the release repository can upload to TestFlight
for testing.

## Read the app's log

The app logs to the system's log under the subsystem `app.sval.ios`. A
Debug build also writes the same lines to `Library/Caches/diagnostics.log`
in its container (`Diagnostics.swift`). The log never names a page, a site,
or a Workspace. The app logs any line that only private browsing causes at
the debug level and leaves that line out of the file, so iOS keeps the line
in memory only. To launch the app and follow its log:

    mobile/ios/watch-log.sh "$DEVICE" phone.log --launch

The script copies the log every 10 seconds and appends what's new to
`phone.log`. It never exits. While the iPhone is locked, the script waits
and tries again. You don't need to restart the script after the phone
sleeps. Without `--launch`, it follows the log of the app already running.

## Test

The unit and UI tests run in the simulator:

    xcrun simctl create sval-test "iPhone 17 Pro"
    xcodebuild test -project Sval.xcodeproj -scheme Sval \
      -destination 'platform=iOS Simulator,name=sval-test'

To save a screenshot at each step of the UI tests, set
`TEST_RUNNER_SVAL_SHOTS` to a folder. Add
`-only-testing:SvalUITests/WalkthroughTests/<test>` to run one test.

The UI tests open the app with `-svalDemo`. A folder inside the app stands
in for the shared folder. The first launch fills that folder with sample
Workspaces, so you don't need an account or a computer.

A test's wait sleeps between its checks, as `AppHarness.until` does,
because a wait that spins on `Task.yield()` holds the main thread and a
core. A page load waits for a web content process to launch, and that
launch needs both, taking longer the busier the Mac is.

CI's `mobile-ios` job runs the same tests on the Mac runners whenever a
pull request changes what the app is built from: `mobile/`, `engine/`,
and the desktop's files the app takes its icons and art from. A change to
Markdown files alone doesn't run it.

## App Store screenshots

`SvalUITests/StoreShots` stages the App Store's six screenshots on sample
Workspaces made for them (`-svalDemoShowroom`). App Store Connect needs
the screenshots from three simulators: iPhone 18 Pro, iPhone 18 Pro Max,
and iPad Pro 13-inch. On each one, set the status bar, then run the test:

    xcrun simctl status_bar <simulator> override --time 2027-01-12T17:41:00.000Z \
      --dataNetwork wifi --wifiMode active --wifiBars 3 --cellularMode active \
      --cellularBars 4 --batteryState charged --batteryLevel 100
    TEST_RUNNER_SVAL_STORE_SHOTS=<folder> xcodebuild test -project Sval.xcodeproj \
      -scheme Sval -destination 'id=<simulator>' -only-testing:SvalUITests/StoreShots

The time is UTC, and the status bar shows it in the Mac's time zone:
17:41 UTC is 9:41 in Pacific time. Each
screenshot is saved as `<device>-<height in pixels>-<shot>.png`. The sample
Workspaces' tabs load live sites, so check every screenshot for a banner
or popup before you upload it.

## Launch options

Pass these after `--` to `xcrun devicectl device process launch`, or in
the scheme's arguments in Xcode.

- `-svalDemo`: opens the demo, with its stand-in folder and sample
  Workspaces. `-svalDemoFresh` starts it over. `-svalDemoJoin` opens on
  setup's pairing code, and `-svalDemoStart` opens on starting a new sync.
- `-svalPageDiagnostics`: logs each page's media, scripts, and Picture in
  Picture.
- `-svalNoBlocking`: turns off ad and tracker blocking. Use it to tell
  whether the blocking rules break a page or the page is broken anyway.
  `-svalNoPageRules` keeps request blocking on and turns off the page
  rules: the lists' element hiding and scripts.
- `-svalPlaybackSession`: sets the audio session to playback at launch.
- `-svalPrivacyCheck`: runs a private session with a random marker in its
  pages and storage, ends it, then searches every file the app can reach
  for the marker. The result goes to the log.
