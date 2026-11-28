/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's own additions to the map of trackers' owners: the
 * companies the bundled sources lack, compiled from primary sources and never
 * from a NonCommercial dataset. Each entry is one company:
 *
 *   {
 *     company: "Example Corp",
 *     domains: {
 *       "example.com": [{ kind: "published", url: "https://…", checked: "2026-10-21" }],
 *     },
 *   }
 *
 * `kind` is how the owner was established: "published" (the company's own
 * list of its domains), "certificate" (a certificate naming the organisation),
 * "rdap" (the registrant record) or "policy" (its privacy or help pages
 * naming the domain). test_sval_tracker_owners.js fails on a domain without
 * one.
 */
export const OWNERS = [];
