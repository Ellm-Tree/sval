/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event =>
  event.waitUntil(self.clients.claim())
);
self.addEventListener("fetch", event => {
  event.respondWith(
    new Response("<title>from sw</title>", {
      headers: { "Content-Type": "text/html" },
    })
  );
});
