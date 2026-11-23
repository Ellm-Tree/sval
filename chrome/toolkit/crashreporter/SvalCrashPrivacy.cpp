/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#include "mozilla/SvalCrashPrivacy.h"

#include "mozilla/Atomics.h"
#include "mozilla/OriginAttributes.h"
#include "mozilla/RuntimeExceptionModule.h"
#include "nsExceptionHandler.h"
#include "nsIPrincipal.h"
#include "nsTHashSet.h"

namespace mozilla::SvalCrashPrivacy {

static Atomic<bool> sPrivate(false);

// What Set was last given, and the private content processes alive, which
// is null while there are none. Both are the main thread's.
static bool sSet = false;
static nsTHashSet<uint64_t>* sContentProcesses = nullptr;

static void Update() {
  const bool isPrivate = sSet || sContentProcesses;
  if (sPrivate.exchange(isPrivate) == isPrivate) {
    return;
  }
  // Windows hands a crash that bypasses the process's exception handler to
  // the registered module, mozwer.dll, which writes the minidump and starts
  // the crash reporter client itself and cannot read the flag. Both calls do
  // nothing on other platforms. XREMain::XRE_mainInit unregisters the module
  // when the crash reporter is off, and it stays unregistered then.
  if (isPrivate) {
    CrashReporter::UnregisterRuntimeExceptionModule();
  } else if (CrashReporter::GetEnabled()) {
    CrashReporter::RegisterRuntimeExceptionModule();
  }
  // The crash helper writes each child process's minidump before this
  // process hears of the crash, so it decides with a copy of the flag. Only
  // the parent process has a connection to it.
  CrashReporter::SetCrashHelperPrivate(isPrivate);
}

void Set(bool aPrivate) {
  sSet = aPrivate;
  Update();
}

void ContentProcessStarted(nsIPrincipal* aIsolationPrincipal,
                           uint64_t aChildId) {
  if (aIsolationPrincipal &&
      aIsolationPrincipal->OriginAttributesRef().IsPrivateBrowsing()) {
    if (!sContentProcesses) {
      sContentProcesses = new nsTHashSet<uint64_t>();
    }
    sContentProcesses->Insert(aChildId);
    Update();
  }
}

void ContentProcessExited(uint64_t aChildId) {
  if (!sContentProcesses || !sContentProcesses->EnsureRemoved(aChildId)) {
    return;
  }
  if (sContentProcesses->IsEmpty()) {
    delete sContentProcesses;
    sContentProcesses = nullptr;
  }
  Update();
}

bool Get() { return sPrivate; }

}  // namespace mozilla::SvalCrashPrivacy
