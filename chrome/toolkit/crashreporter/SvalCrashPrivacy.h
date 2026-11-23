/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#ifndef mozilla_SvalCrashPrivacy_h
#define mozilla_SvalCrashPrivacy_h

#include <cstdint>

class nsIPrincipal;

namespace mozilla::SvalCrashPrivacy {

// Whether a minidump of this process could hold a private window's pages, in
// which case its crash keeps none. A content process sets it once its remote
// type is a private one. In the parent process it is set while a private
// browsing context exists, browser.privatebrowsing.autostart is on, or a
// content process for a private window's sites is alive: such a process
// outlives its window's last browsing context, and the processes every
// window shares still serve it.
//
// Set and the two ContentProcess functions run on the main thread. Get is
// one atomic load, so an exception handler can call it on any thread and
// inside a signal handler.
void Set(bool aPrivate);
bool Get();

// The parent process counts the content processes whose remote type is a
// private one, each by its child id. ContentProcessStarted takes the
// principal ContentParent::CreateRemoteTypeIsolationPrincipal gave for the
// process's remote type and counts the process when that principal is in
// private browsing. ContentProcessExited takes any process's id, counted or
// not, any number of times.
void ContentProcessStarted(nsIPrincipal* aIsolationPrincipal,
                           uint64_t aChildId);
void ContentProcessExited(uint64_t aChildId);

}  // namespace mozilla::SvalCrashPrivacy

#endif  // mozilla_SvalCrashPrivacy_h
