/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * An HTTPS-Only exception a private window makes is that window's session's
 * alone (https-only-private-exception.patch). Gecko keeps the exception with
 * no origin attributes, so it held in normal windows and in every other
 * private window until quit.
 */

const TYPE = "https-only-load-insecure";
const { LOAD_INSECURE_ALLOW, LOAD_INSECURE_ALLOW_SESSION } =
  Ci.nsIHttpsOnlyModePermission;
const { UNKNOWN_ACTION, EXPIRE_SESSION } = Ci.nsIPermissionManager;

// eslint-disable-next-line sdl/no-insecure-url
const uri = Services.io.newURI("http://svalhttpsonly.example");

function principal(attrs = {}) {
  return Services.scriptSecurityManager.createContentPrincipal(uri, attrs);
}

const normal = principal();
// A private window's session is its userContextId.
const session = principal({ privateBrowsingId: 1, userContextId: 7 });
const otherSession = principal({ privateBrowsingId: 1, userContextId: 8 });

function exception(who) {
  return Services.perms.testExactPermissionFromPrincipal(who, TYPE);
}

add_task(function a_private_sessions_exception_is_its_own() {
  do_get_profile();
  Services.perms.addFromPrincipal(
    session,
    TYPE,
    LOAD_INSECURE_ALLOW_SESSION,
    EXPIRE_SESSION
  );
  Assert.equal(
    exception(session),
    LOAD_INSECURE_ALLOW_SESSION,
    "the session that made the exception has it"
  );
  Assert.equal(exception(normal), UNKNOWN_ACTION, "a normal window has none");
  Assert.equal(
    exception(otherSession),
    UNKNOWN_ACTION,
    "and neither has another private session"
  );
  Assert.deepEqual(
    Services.perms.getAllByTypes([TYPE]),
    [],
    "nothing is kept under the type every window reads"
  );

  Services.perms.removePermissionsWithAttributes(
    JSON.stringify({ privateBrowsingId: 1, userContextId: 7 }),
    [],
    []
  );
  Assert.equal(
    exception(session),
    UNKNOWN_ACTION,
    "the exception goes when the session's permissions are cleared"
  );
});

add_task(function a_private_session_reads_and_keeps_a_normal_exception() {
  Services.perms.addFromPrincipal(normal, TYPE, LOAD_INSECURE_ALLOW);
  Assert.equal(
    exception(session),
    LOAD_INSECURE_ALLOW,
    "a private session reads a normal window's exception"
  );

  Services.perms.addFromPrincipal(
    session,
    TYPE,
    LOAD_INSECURE_ALLOW_SESSION,
    EXPIRE_SESSION
  );
  Assert.equal(
    exception(session),
    LOAD_INSECURE_ALLOW_SESSION,
    "and its own first"
  );
  Services.perms.removeFromPrincipal(session, TYPE);
  Assert.equal(
    exception(session),
    LOAD_INSECURE_ALLOW,
    "removing its own leaves the normal one"
  );
  Assert.equal(exception(normal), LOAD_INSECURE_ALLOW, "for both");

  Services.perms.removeFromPrincipal(normal, TYPE);
  Assert.equal(exception(session), UNKNOWN_ACTION, "until that one goes too");
});
