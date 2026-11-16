/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A permission denied only by a global default reads as "prompt"; a site the
 * user blocked still reads as "denied"
 * (RFPTarget::PermissionsDefaultDenyPrompt). Notification.permission agrees,
 * and so does a worker and a cross-origin frame.
 */

/** Evaluated in the page's own global, so it must stand alone. */
async function permissionProbe() {
  const page = (await navigator.permissions.query({ name: "notifications" }))
    .state;
  const notification = Notification.permission;
  const worker = new Worker(
    URL.createObjectURL(
      new Blob([
        `navigator.permissions.query({ name: "notifications" })
          .then(s => postMessage([s.state, Notification.permission]))`,
      ])
    )
  );
  const inWorker = await new Promise(resolve => {
    worker.onmessage = e => resolve(e.data);
  });
  worker.terminate();
  return JSON.stringify({ page, notification, inWorker });
}

async function readPermission(browser) {
  return within(
    SpecialPowers.spawn(browser, [permissionProbe.toString()], async src =>
      JSON.parse(await content.wrappedJSObject.eval(`(${src})()`))
    ),
    10_000,
    "the page's permission"
  );
}

add_setup(async function () {
  // Block every site's notification requests, the global default.
  await SpecialPowers.pushPrefEnv({
    set: [["permissions.default.desktop-notification", 2]],
  });
});

add_task(async function a_default_deny_reads_as_prompt() {
  await BrowserTestUtils.withNewTab(PAGE2, async browser => {
    Assert.deepEqual(
      await readPermission(browser),
      {
        page: "prompt",
        notification: "default",
        inWorker: ["prompt", "default"],
      },
      "normal window: the global default is not visible"
    );
  });
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a new window opening"
  );
  try {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE2),
      10_000,
      "a new tab's load"
    );
    Assert.deepEqual(
      await readPermission(tab.linkedBrowser),
      {
        page: "prompt",
        notification: "default",
        inWorker: ["prompt", "default"],
      },
      "private window: the same"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
  }
});

add_task(async function a_site_the_user_blocked_reads_as_denied() {
  const principal =
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      "https://example.com"
    );
  Services.perms.addFromPrincipal(
    principal,
    "desktop-notification",
    Services.perms.DENY_ACTION
  );
  try {
    await BrowserTestUtils.withNewTab(PAGE2, async browser => {
      Assert.deepEqual(
        await readPermission(browser),
        {
          page: "denied",
          notification: "denied",
          inWorker: ["denied", "denied"],
        },
        "the site's own block stays visible"
      );
    });
  } finally {
    Services.perms.removeFromPrincipal(principal, "desktop-notification");
  }
});

const FRAMED = ROOT.replace("https://example.com", "https://example.org");

/** Evaluated in a frame's own global, so it must stand alone. */
async function geolocationProbe() {
  return (await navigator.permissions.query({ name: "geolocation" })).state;
}

/**
 * What the top page and a cross-origin frame it lets use geolocation read.
 *
 * @param {Browser} browser The tab's browser, showing PAGE2.
 * @returns {Promise<object>} `{top, frame}`.
 */
async function readGeolocation(browser) {
  await SpecialPowers.spawn(
    browser,
    [FRAMED + "sval_agent_page2.html"],
    src => {
      const frame = content.document.createElement("iframe");
      frame.allow = "geolocation";
      frame.src = src;
      const loaded = new Promise(r => (frame.onload = r));
      content.document.body.append(frame);
      return loaded.then(() => null);
    }
  );
  const probe = bc =>
    SpecialPowers.spawn(bc, [geolocationProbe.toString()], src =>
      content.wrappedJSObject.eval(`(${src})()`)
    );
  return {
    top: await probe(browser),
    frame: await probe(browser.browsingContext.children[0]),
  };
}

add_task(async function a_cross_origin_frame_reads_as_its_top_does() {
  await SpecialPowers.pushPrefEnv({ set: [["permissions.default.geo", 2]] });
  try {
    await BrowserTestUtils.withNewTab(PAGE2, async browser => {
      Assert.deepEqual(
        await readGeolocation(browser),
        { top: "prompt", frame: "prompt" },
        "a frame under a global default reads as the top page does"
      );
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }

  const principal =
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      "https://example.com"
    );
  Services.perms.addFromPrincipal(principal, "geo", Services.perms.DENY_ACTION);
  try {
    await BrowserTestUtils.withNewTab(PAGE2, async browser => {
      Assert.deepEqual(
        await readGeolocation(browser),
        { top: "denied", frame: "denied" },
        "a frame under a top site the user blocked reads denied"
      );
    });
  } finally {
    Services.perms.removeFromPrincipal(principal, "geo");
  }
});
