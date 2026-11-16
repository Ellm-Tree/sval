/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Keeps Sval's windows behind the app a link came from, so a link from
// another app opens over that app, and keeps them there when the quick
// window over that app closes.
//
// macOS activates an app before handing it the link: LaunchServices makes
// Sval the active app, and only then delivers the GetURL event that
// MacApplicationDelegate's openURLs: turns into a command line. AppKit
// handles the activation (-[NSApplication _handleActivatedEvent:]) by
// queueing its key and main windows to come in front of every other app's.
// The window server gets that queue at the end of the event's pass through
// the run loop, when AppKit commits its window transaction, so by the time
// Sval sees the link its window has been drawn over the app the user clicked
// in.
//
// So the activation itself is read while AppKit posts
// NSApplicationDidBecomeActiveNotification, inside that pass and before the
// commit. When LaunchServices activated Sval to open something, the windows
// AppKit is about to raise are ordered to just behind the window of the app
// the user was in. Both orders reach the window server in one transaction,
// so no frame shows Sval's window in front of that app. Sval is not yet in
// front, so that app's window is the frontmost window of an ordinary app
// (NSApplicationActivationPolicyRegular) that is not Sval's: overlay and
// menu-bar apps, whose windows can sit in between, are skipped. Nothing is
// remembered: a quick window opened afterwards comes to the front as any new
// window does, and a page that opens in one of the windows kept behind
// brings that window forward (BringForward).
//
// An activation by the user, through Cmd-Tab, the Dock or a click in a
// window, or by another app's activateWithOptions:, raises Sval's windows as
// macOS always does. So does a link that arrives while Sval is already the
// active app, which comes with no activation at all.
//
// Window numbers and owners come from CGWindowListCopyWindowInfo, which
// answers them without the screen-recording permission a window's title
// needs.

#import <Cocoa/Cocoa.h>
#include <unistd.h>

#include "SvalMacWindowOrder.h"

#include "nsCOMPtr.h"
#include "nsCocoaFeatures.h"
#include "nsIBaseWindow.h"
#include "nsIWidget.h"
#include "nsObjCExceptions.h"
#include "nsTArray.h"

NS_IMPL_ISUPPORTS(SvalMacWindowOrder, nsISvalMacWindowOrder)

namespace {

// The bit of an activation event's data2 that LaunchServices sets when it
// activates the app to open something in it, a URL or a document, whether
// `open` or another app's NSWorkspace asked. Apple does not document data2
// for this event, so the bit is read only on the macOS release it was
// observed on, kOpeningActivationMacOS. There a link or a file sets it
// (0x440); Cmd-Tab and a Dock click (0x50), `open -a` with nothing to open, a
// click in a window and activateWithOptions: (0x40) do not.
constexpr NSInteger kOpeningActivation = 0x400;
constexpr int32_t kOpeningActivationMacOS = 26;

struct OnScreenWindow {
  NSInteger mNumber;
  pid_t mOwner;
};

constexpr size_t kNoWindow = SIZE_MAX;

// The on-screen windows of the ordinary window level, frontmost first.
nsTArray<OnScreenWindow> WindowsFrontToBack() {
  nsTArray<OnScreenWindow> windows;
  CFArrayRef list = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (!list) {
    return windows;
  }
  for (NSDictionary* info in (NSArray*)list) {
    if ([info[(id)kCGWindowLayer] integerValue] != 0) {
      continue;
    }
    windows.AppendElement(
        OnScreenWindow{[info[(id)kCGWindowNumber] integerValue],
                       [info[(id)kCGWindowOwnerPID] intValue]});
  }
  CFRelease(list);
  return windows;
}

size_t IndexOfWindow(const nsTArray<OnScreenWindow>& aWindows,
                     NSInteger aNumber) {
  for (size_t i = 0; i < aWindows.Length(); i++) {
    if (aWindows[i].mNumber == aNumber) {
      return i;
    }
  }
  return kNoWindow;
}

// Whether the process `aPid` is an ordinary app, with a Dock icon and a menu
// bar, as the app a user clicks a link in is.
bool IsOrdinaryApp(pid_t aPid) {
  NSRunningApplication* app =
      [NSRunningApplication runningApplicationWithProcessIdentifier:aPid];
  return app && app.activationPolicy == NSApplicationActivationPolicyRegular;
}

// The frontmost window of an ordinary app other than Sval.
size_t FrontOtherAppWindow(const nsTArray<OnScreenWindow>& aWindows) {
  pid_t self = getpid();
  for (size_t i = 0; i < aWindows.Length(); i++) {
    if (aWindows[i].mOwner != self && IsOrdinaryApp(aWindows[i].mOwner)) {
      return i;
    }
  }
  return kNoWindow;
}

// Whether the event AppKit is handling is LaunchServices activating Sval to
// open something in it.
bool IsOpeningActivation() {
  if (nsCocoaFeatures::macOSVersionMajor() != kOpeningActivationMacOS) {
    return false;
  }
  NSEvent* event = [NSApp currentEvent];
  return event && event.type == NSEventTypeAppKitDefined &&
         event.subtype == NSEventSubtypeApplicationActivated &&
         (event.data2 & kOpeningActivation) != 0;
}

}  // namespace

// When LaunchServices activated Sval to open something, orders the windows
// AppKit's activation is about to raise, the key and main windows, to just
// behind the front window of the app the user was in, keeping their order.
/* static */
void SvalMacWindowOrder::ActivationStarted() {
  NS_OBJC_BEGIN_TRY_IGNORE_BLOCK;

  if (!IsOpeningActivation()) {
    return;
  }
  nsTArray<OnScreenWindow> windows = WindowsFrontToBack();
  size_t anchor = FrontOtherAppWindow(windows);
  if (anchor == kNoWindow) {
    return;
  }
  // Where each raised window is on screen now. One already in front of the
  // anchor is in view as it is. One not on screen yet but visible to AppKit
  // is coming back with the app, which LaunchServices unhid as it activated
  // it (Cmd-H), in the same transaction, so it goes behind too, furthest
  // back. A minimized window, or one on another Space, is not raised.
  struct Raised {
    size_t mAt;  // kNoWindow for a window coming back with the app.
    NSWindow* mWindow;
  };
  AutoTArray<Raised, 2> raised;
  for (NSWindow* window : {NSApp.keyWindow, NSApp.mainWindow}) {
    if (!window) {
      continue;
    }
    bool seen = false;
    for (const Raised& r : raised) {
      seen = seen || r.mWindow == window;
    }
    if (seen) {
      continue;
    }
    size_t at = IndexOfWindow(windows, window.windowNumber);
    if (at != kNoWindow && at > anchor) {
      raised.AppendElement(Raised{at, window});
    } else if (at == kNoWindow && window.isVisible && window.isOnActiveSpace &&
               !window.isMiniaturized) {
      raised.AppendElement(Raised{kNoWindow, window});
    }
  }
  // Back to front, each directly behind the anchor, so the first ordered
  // ends furthest back and the order is kept.
  raised.Sort([](const Raised& aA, const Raised& aB) {
    return aA.mAt > aB.mAt ? -1 : aA.mAt < aB.mAt ? 1 : 0;
  });
  for (const Raised& r : raised) {
    [r.mWindow orderWindow:NSWindowBelow relativeTo:windows[anchor].mNumber];
  }

  NS_OBJC_END_TRY_IGNORE_BLOCK;
}

// A page that opens in one of the windows kept behind, rather than in a
// quick window, brings it forward through focus(), which raises nothing when
// the window is already the active one (nsFocusManager::RaiseWindow), and a
// window kept behind is still Sval's key window.
NS_IMETHODIMP
SvalMacWindowOrder::BringForward(nsIBaseWindow* aWindow) {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  NS_ENSURE_ARG(aWindow);
  if (!NSApp.isActive) {
    return NS_OK;
  }
  nsCOMPtr<nsIWidget> widget = aWindow->GetMainWidget();
  NSWindow* window =
      widget ? (NSWindow*)widget->GetNativeData(NS_NATIVE_WINDOW) : nil;
  if (!window) {
    return NS_OK;
  }
  nsTArray<OnScreenWindow> windows = WindowsFrontToBack();
  size_t at = IndexOfWindow(windows, window.windowNumber);
  size_t cover = FrontOtherAppWindow(windows);
  if (at != kNoWindow && cover != kNoWindow && at > cover) {
    [window orderFront:nil];
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}

// AppKit makes the active app's next window key when its key window goes,
// which brings that window in front of every other app's; Sval's window from
// further back would jump over the window the user sees next. Once the other
// app is active, the closing window leaves the stack as it is.
NS_IMETHODIMP
SvalMacWindowOrder::PassActivationBehind() {
  NS_OBJC_BEGIN_TRY_BLOCK_RETURN;

  NSWindow* key = NSApp.keyWindow;
  if (!key) {
    return NS_OK;
  }
  nsTArray<OnScreenWindow> windows = WindowsFrontToBack();
  size_t at = IndexOfWindow(windows, key.windowNumber);
  if (at == kNoWindow) {
    return NS_OK;
  }
  // The ordinary window just behind the key window: the next window of
  // Sval's or of an ordinary app, skipping overlay and menu-bar apps.
  pid_t self = getpid();
  for (size_t i = at + 1; i < windows.Length(); i++) {
    pid_t owner = windows[i].mOwner;
    if (owner == self) {
      return NS_OK;
    }
    if (IsOrdinaryApp(owner)) {
      [[NSRunningApplication runningApplicationWithProcessIdentifier:owner]
          activateWithOptions:0];
      return NS_OK;
    }
  }
  return NS_OK;

  NS_OBJC_END_TRY_BLOCK_RETURN(NS_ERROR_FAILURE);
}
