/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file The test files not yet migrated to the helpers in the browser tests'
 * head.js: for each, by path from the top of the tree, how many hits of each
 * baselined rule it still has.
 *
 * It only shrinks. A file migrated loses its entry in the same pull request.
 * A rule fails a file with more hits than its entry allows, naming them all;
 * `sval/stale-baseline` warns about an entry that allows more than the file
 * has, naming the count to lower it to. That is a warning rather than an
 * error because a pull request branched before the entry was written can
 * remove hits without this check in its own CI, and its merge must not turn
 * main red.
 *
 * An entry reads:
 *
 *   "browser/components/sval/test/browser/browser_sval_example.js": {
 *     "unbounded-wait": 2,
 *   },
 */

export default {};
