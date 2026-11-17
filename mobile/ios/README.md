# Sval for iOS (prototype)

A first iOS app: it joins your other devices through the shared folder,
syncs the `workspaces` document with the engine in `engine/`, lists your
Workspaces, groups and tabs, and opens a tab in a web view. It changes
nothing in the document yet.

## Build and run

Needs Xcode, XcodeGen (`brew install xcodegen`) and Rust (rustup).

    mobile/ios/build-engine.sh                  # the engine and its Swift bindings
    (cd mobile/ios && xcodegen generate)        # writes Sval.xcodeproj
    open mobile/ios/Sval.xcodeproj

Then choose your iPhone as the run destination and press Run. The first
time, sign in to Xcode with an Apple ID on Ellm Tree's team, and turn on
Developer Mode on the iPhone (Settings › Privacy & Security).

## On the iPhone

1. **Choose Folder** and pick the folder your computers sync Sval through.
   It has a `sval` folder inside it.
2. On a computer, go to Settings › Sync and devices › "Sync with another
   device" and have it show the code. Enter the code on the iPhone. A
   52-character backup key works too.
3. Sval syncs when it opens, every 30 seconds while it stays open, and when
   you pull down on a list.
