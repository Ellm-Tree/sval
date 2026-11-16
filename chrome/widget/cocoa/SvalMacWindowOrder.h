/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#ifndef SvalMacWindowOrder_h
#define SvalMacWindowOrder_h

#include "nsISvalMacWindowOrder.h"

class SvalMacWindowOrder final : public nsISvalMacWindowOrder {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSISVALMACWINDOWORDER

  SvalMacWindowOrder() = default;

  // Called from nsAppShell's applicationDidBecomeActive:, while AppKit posts
  // NSApplicationDidBecomeActiveNotification and before it commits the
  // activation's window transaction.
  static void ActivationStarted();

 private:
  ~SvalMacWindowOrder() = default;
};

#endif  // SvalMacWindowOrder_h
