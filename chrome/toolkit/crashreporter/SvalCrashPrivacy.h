/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#ifndef mozilla_SvalCrashPrivacy_h
#define mozilla_SvalCrashPrivacy_h

namespace mozilla::SvalCrashPrivacy {

// Whether a minidump of this process could hold a private window's pages, in
// which case its crash keeps none. The parent process sets it while a private
// browsing context exists or browser.privatebrowsing.autostart is on, and a
// content process sets it once its remote type is a private one.
//
// Set runs on the main thread. Get is one atomic load, so an exception
// handler can call it on any thread and inside a signal handler.
void Set(bool aPrivate);
bool Get();

}  // namespace mozilla::SvalCrashPrivacy

#endif  // mozilla_SvalCrashPrivacy_h
