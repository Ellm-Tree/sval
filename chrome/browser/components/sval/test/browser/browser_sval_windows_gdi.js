/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A closed window gives back its GDI objects. On Windows 11 the Windows App
 * SDK collapses each browser window's title bar
 * (`WindowsUIUtils::SetIsTitlebarCollapsed`), and keeps that title bar's
 * objects after the window is destroyed unless the default title bar is
 * restored first. A process has 10,000 GDI objects; past them a new window's
 * title bar fails inside the SDK, which ends the process.
 */

const { ctypes } = ChromeUtils.importESModule(
  "resource://gre/modules/ctypes.sys.mjs"
);

const WINDOWS = 20;
// Each window the SDK keeps costs about twenty objects, so a leak of every
// window lands far above this. What remains is the process's own churn.
const ALLOWED = WINDOWS;

function gdiObjects() {
  const user32 = ctypes.open("user32.dll");
  const kernel32 = ctypes.open("kernel32.dll");
  try {
    const GetGuiResources = user32.declare(
      "GetGuiResources",
      ctypes.winapi_abi,
      ctypes.uint32_t,
      ctypes.voidptr_t,
      ctypes.uint32_t
    );
    const GetCurrentProcess = kernel32.declare(
      "GetCurrentProcess",
      ctypes.winapi_abi,
      ctypes.voidptr_t
    );
    // GR_GDIOBJECTS
    return GetGuiResources(GetCurrentProcess(), 0);
  } finally {
    user32.close();
    kernel32.close();
  }
}

async function openAndClose() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "a window opening"
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "a window closing");
}

add_task(async function closed_windows_give_back_their_gdi_objects() {
  // The first window loads what every later one shares.
  await openAndClose();
  const before = gdiObjects();
  for (let i = 0; i < WINDOWS; i++) {
    await openAndClose();
  }
  const grown = gdiObjects() - before;
  Assert.lessOrEqual(
    grown,
    ALLOWED,
    `${WINDOWS} windows opened and closed leave at most ${ALLOWED} GDI objects (left ${grown})`
  );
});
