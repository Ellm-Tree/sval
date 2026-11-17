/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalScope } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalScope.sys.mjs"
);

const TOPIC = "sval-test-scope";
const PREF = "browser.sval.test.scope";

add_task(function an_ended_scope_hears_nothing() {
  const heard = [];
  const target = new EventTarget();
  const scope = new SvalScope();
  scope.topic(TOPIC, () => heard.push("topic"));
  scope.pref(PREF, () => heard.push("pref"));
  scope.listen(target, "ping", () => heard.push("event"));
  scope.add(() => heard.push("ended"));

  Services.obs.notifyObservers(null, TOPIC);
  Services.prefs.setBoolPref(PREF, true);
  target.dispatchEvent(new Event("ping"));
  Assert.deepEqual(heard, ["topic", "pref", "event"], "each add hears its own");

  scope.end();
  Assert.deepEqual(heard.splice(0).at(-1), "ended", "its own end ran");

  Services.obs.notifyObservers(null, TOPIC);
  Services.prefs.setBoolPref(PREF, false);
  target.dispatchEvent(new Event("ping"));
  Assert.deepEqual(heard, [], "nothing is heard once it has ended");

  scope.end();
  Assert.deepEqual(heard, [], "ending it again does nothing");
  Services.prefs.clearUserPref(PREF);
});
