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
  connector, ad blocking, and site names) for the iPhone and its simulator,
  and writes the Swift bindings to `Generated/`.
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

    mobile/ios/build-engine.sh             # after any change under engine/ or mobile/sval-mobile/
    (cd mobile/ios && xcodegen generate)   # after adding or removing a file

To build and run from Xcode, open `mobile/ios/Sval.xcodeproj`, choose the
iPhone or a simulator, and press Run.

## Install on an iPhone from the command line

Find the iPhone's identifier with `xcrun devicectl list devices`, and set
`DEVICE` to it. Then, in `mobile/ios`:

    xcodebuild -project Sval.xcodeproj -scheme Sval -destination "id=$DEVICE" \
      -derivedDataPath build -allowProvisioningUpdates build
    xcrun devicectl device install app --device "$DEVICE" build/Build/Products/Debug-iphoneos/Sval.app

Installing works over Wi-Fi once the iPhone has been paired with the Mac.

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

## Read the app's log

The app writes its own log to `Library/Caches/diagnostics.log` in its
container (`Diagnostics.swift`). The log never names a page, a site, or a
Workspace. To launch the app and follow its log:

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

CI's `mobile-ios` job runs the same tests on the Mac runners whenever a
pull request changes what the app is built from: `mobile/`, `engine/`,
and the desktop's files the app takes its icons and art from. A change to
Markdown files alone doesn't run it.

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
- `-svalGlassCheck`: opens a test bench for the bar's glass.
