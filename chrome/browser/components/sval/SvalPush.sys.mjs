/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Web Push connects only while some site may notify the user (spec §10.9).
 *
 * Firefox opens a WebSocket to Mozilla's push server at every launch, on every
 * profile, whether or not any site has ever been allowed to send a
 * notification. That gives Mozilla each install's IP address and a stable
 * identifier for as long as the browser runs.
 *
 * A push subscription needs the "desktop-notification" permission, and Firefox
 * drops a site's subscriptions when that permission goes, so "some site holds
 * the permission" is exactly "the connection has a use". app-sval-prefs.js ships
 * `dom.push.connection.enabled` off; this turns it on and off on the default
 * branch as permissions change, so a value the user set themselves still wins.
 * PushService already watches that pref and connects or disconnects when it
 * changes. Firefox's "Block new requests asking to allow notifications",
 * which refuses every site, is how a user says never.
 */

const PERMISSION = "desktop-notification";
const CONNECTION_PREF = "dom.push.connection.enabled";

let watching = false;

/** @returns {boolean} */
function anySiteMayNotify() {
  return Services.perms
    .getAllByTypes([PERMISSION])
    .some(p => p.capability == Services.perms.ALLOW_ACTION);
}

function update() {
  Services.prefs
    .getDefaultBranch("")
    .setBoolPref(CONNECTION_PREF, anySiteMayNotify());
}

const observer = {
  observe(subject, topic, data) {
    // "cleared" carries no permission: every permission went at once.
    if (
      data == "cleared" ||
      subject?.QueryInterface(Ci.nsIPermission).type == PERMISSION
    ) {
      update();
    }
  },
};

export const SvalPush = {
  /**
   * Sets the connection from the permissions the profile holds, and keeps
   * it in step from then on. Once per launch; later calls do nothing.
   */
  start() {
    if (watching) {
      return;
    }
    watching = true;
    Services.obs.addObserver(observer, "perm-changed");
    update();
  },
};
