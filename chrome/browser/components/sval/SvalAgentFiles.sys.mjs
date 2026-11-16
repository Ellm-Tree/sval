/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's answers about the file pickers, downloads and clipboard writes of
 * web pages. Gecko asks them in the parent, where it makes every picker and
 * download a page asks for and writes every clipboard
 * (`sval-agent-files.patch`, `sval-agent-clipboard.patch`, `SvalAgentFiles.h`).
 * The gates answer from the tabs they hold: pickers and clipboard writes
 * through `SvalAgentGate`, downloads through `SvalAgentDownloads`.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  downloadDialogFor:
    "moz-src:///browser/components/sval/SvalAgentDownloads.sys.mjs",
  downloadTransferFor:
    "moz-src:///browser/components/sval/SvalAgentDownloads.sys.mjs",
  refusesClipboardWrite:
    "moz-src:///browser/components/sval/SvalAgentGate.sys.mjs",
  refusesFilePicker: "moz-src:///browser/components/sval/SvalAgentGate.sys.mjs",
});

/** The `@sval/agent-files;1` service (components.conf). */
export class SvalAgentFiles {
  QueryInterface = ChromeUtils.generateQI(["nsISvalAgentFiles"]);

  refusesFilePicker(bc) {
    return lazy.refusesFilePicker(bc);
  }

  refusesClipboardWrite(bc) {
    return lazy.refusesClipboardWrite(bc);
  }

  downloadDialog(bc) {
    return lazy.downloadDialogFor(bc);
  }

  downloadTransfer(bc) {
    return lazy.downloadTransferFor(bc);
  }
}
