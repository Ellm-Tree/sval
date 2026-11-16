/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// Answers whoever asks with the core count this worker reads: a dedicated
// worker's owner, a shared worker's port, or a service worker's client.
self.onmessage = e =>
  (e.source ?? self).postMessage(navigator.hardwareConcurrency);
self.onconnect = e => e.ports[0].postMessage(navigator.hardwareConcurrency);
