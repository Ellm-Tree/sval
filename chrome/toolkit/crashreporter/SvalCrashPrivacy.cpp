/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#include "mozilla/SvalCrashPrivacy.h"

#include "mozilla/Atomics.h"
#include "mozilla/RuntimeExceptionModule.h"
#include "nsExceptionHandler.h"

namespace mozilla::SvalCrashPrivacy {

static Atomic<bool> sPrivate(false);

void Set(bool aPrivate) {
  if (sPrivate.exchange(aPrivate) == aPrivate) {
    return;
  }
  // Windows hands a crash that bypasses the process's exception handler to
  // the registered module, mozwer.dll, which writes the minidump and starts
  // the crash reporter client itself and cannot read the flag. Both calls do
  // nothing on other platforms. XREMain::XRE_mainInit unregisters the module
  // when the crash reporter is off, and it stays unregistered then.
  if (aPrivate) {
    CrashReporter::UnregisterRuntimeExceptionModule();
  } else if (CrashReporter::GetEnabled()) {
    CrashReporter::RegisterRuntimeExceptionModule();
  }
}

bool Get() { return sPrivate; }

}  // namespace mozilla::SvalCrashPrivacy
