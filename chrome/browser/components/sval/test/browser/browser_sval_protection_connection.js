/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The Privacy and Security button's connection: the colour
 * and word a wrong connection gives the button, the panel's connection line
 * and warning, the certificate view it opens, a site's breach from Have I
 * Been Pwned's list with its source named, and clearing a site's data.
 */

const { RemoteSettings } = ChromeUtils.importESModule(
  "resource://services-settings/remote-settings.sys.mjs"
);
const { BreachAlertStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/BreachAlertStore.sys.mjs"
);
const { SvalProtectionButton, breachFor, forgetBreaches } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs"
  );

const SECURE_PAGE = "https://example.com/";
// eslint-disable-next-line sdl/no-insecure-url
const PLAIN_PAGE = "http://mochi.test:8888/";
const EXPIRED_PAGE = "https://expired.example.com/";

const BREACH = {
  id: "8b6f2a52-6b51-4d6e-9f0e-1d6f0c2b7a11",
  Name: "ExampleBreach",
  Domain: "example.com",
  BreachDate: Temporal.Now.plainDateISO().toString(),
  AddedDate: Temporal.Now.plainDateTimeISO().toString(),
  PwnCount: 4_100_000,
  DataClasses: ["Email addresses", "Passwords"],
};

function buttonIn(win = window) {
  return win.document.getElementById("sval-protection-button");
}

function panelIn(win = window) {
  return win.document.getElementById("sval-protection-panel");
}

function byId(id) {
  return document.getElementById(id);
}

async function openPanel() {
  const shown = BrowserTestUtils.waitForEvent(panelIn(), "popupshown");
  buttonIn().click();
  await within(shown, 5_000, "the panel's popupshown");
}

async function closePanel() {
  if (panelIn().state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(panelIn(), "popuphidden");
  panelIn().hidePopup();
  await within(hidden, 5_000, "the panel's popuphidden");
}

/**
 * Opens `url` in a new tab and waits for its error page.
 *
 * @param {string} url
 * @returns {Promise<MozTabbrowserTab>}
 */
async function openErrorPage(url) {
  const tab = BrowserTestUtils.addTab(gBrowser, url);
  const shown = BrowserTestUtils.waitForErrorPage(tab.linkedBrowser);
  await selectTab(tab);
  await within(shown, 10_000, "the error page");
  return tab;
}

async function setBreaches(records) {
  const { db } = RemoteSettings("fxmonitor-breaches");
  await db.clear();
  for (const record of records) {
    await db.create(record, { useRecordId: true });
  }
  await db.importChanges({}, Date.now());
  forgetBreaches();
}

add_setup(async function () {
  registerCleanupFunction(async () => {
    await setBreaches([]);
    const storage = new BreachAlertStorage();
    await storage.initialize();
    await storage.clearAllBreachAlertDismissals();
  });
});

add_task(async function a_secure_page_shows_its_certificate() {
  await BrowserTestUtils.withNewTab(SECURE_PAGE, async () => {
    Assert.equal(buttonIn().dataset.tone, "", "no connection colour");
    Assert.ok(!buttonIn().hasAttribute("sval-label"), "and no word beside it");
    await openPanel();
    try {
      Assert.equal(
        panelIn().querySelector(".sval-prot-body").dataset.connection,
        "secure",
        "the panel says the connection is secure"
      );
      Assert.ok(!panelIn().querySelector(".sval-prot-card"), "with no warning");
      byId("sval-prot-conn").click();
      Assert.equal(
        document.activeElement,
        byId("sval-prot-back"),
        "the certificate view puts the focus on Back"
      );
      const detail = name => panelIn().querySelector(`[data-detail="${name}"]`);
      Assert.equal(
        detail("verified").textContent,
        "example.com",
        "it says the site is verified"
      );
      Assert.ok(
        detail("encryption").textContent &&
          !detail("encryption").hasAttribute("data-warn"),
        "and how the connection is encrypted"
      );
      EventUtils.synthesizeKey("KEY_Escape", {}, window);
      Assert.ok(byId("sval-prot-conn"), "Esc goes back to the main view");
      Assert.equal(panelIn().state, "open", "and leaves the panel open");
      const hidden = BrowserTestUtils.waitForEvent(panelIn(), "popuphidden");
      EventUtils.synthesizeKey("KEY_Escape", {}, window);
      await within(hidden, 5_000, "a second Esc closing the panel");
    } finally {
      await closePanel();
    }
  });
});

add_task(async function a_page_with_no_encryption_says_not_secure() {
  await BrowserTestUtils.withNewTab(PLAIN_PAGE, async () => {
    Assert.equal(buttonIn().dataset.tone, "http", "the button turns amber");
    Assert.equal(buttonIn().dataset.connection, "http", "for plain HTTP");
    Assert.ok(
      buttonIn().hasAttribute("sval-label") &&
        buttonIn().querySelector(".sval-prot-label-word").textContent,
      "and says so beside the shield"
    );
    await openPanel();
    try {
      Assert.equal(
        panelIn().querySelector(".sval-prot-body").dataset.connection,
        "http"
      );
      Assert.ok(
        panelIn().querySelector(".sval-prot-card"),
        "the panel warns first"
      );
      Assert.ok(
        panelIn().querySelector(".sval-prot-rows"),
        "and still counts what protections blocked"
      );
      byId("sval-prot-conn").click();
      const details = [
        ...panelIn().querySelectorAll(".sval-prot-detail-value"),
      ].map(node => [
        node.dataset.detail,
        node.classList.contains("sval-prot-tone"),
      ]);
      Assert.deepEqual(
        details,
        [
          ["verified", true],
          ["encryption", true],
        ],
        "the certificate view says nothing is verified or encrypted"
      );
    } finally {
      await closePanel();
    }
  });
});

add_task(async function a_certificate_error_shows_only_the_connection() {
  const tab = await openErrorPage(EXPIRED_PAGE);
  try {
    Assert.equal(buttonIn().dataset.tone, "err", "the button turns red");
    Assert.equal(buttonIn().dataset.connection, "cert-error");
    Assert.ok(buttonIn().hasAttribute("sval-label"), "with a word beside it");
    await openPanel();
    Assert.equal(
      panelIn().querySelector(".sval-prot-body").dataset.connection,
      "cert-error",
      "the panel names the certificate error"
    );
    Assert.ok(
      panelIn().querySelector(".sval-prot-card"),
      "and warns the page did not load"
    );
    Assert.ok(
      !panelIn().querySelector(
        ".sval-prot-rows, .sval-prot-site, .sval-prot-footer"
      ),
      "nothing loaded, so there is nothing to count or switch"
    );
  } finally {
    await closePanel();
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function an_internal_page_says_what_it_is() {
  await BrowserTestUtils.withNewTab("about:preferences", async () => {
    await openPanel();
    try {
      Assert.equal(
        panelIn().querySelector(".sval-prot-body").dataset.page,
        "sval",
        "a page of Sval's own is named as Sval's"
      );
      const line = byId("sval-prot-conn");
      Assert.equal(line.localName, "div", "and opens no certificate view");
      Assert.ok(
        panelIn().querySelector(".sval-prot-internal"),
        "the panel says protections don't apply"
      );
      Assert.ok(
        !panelIn().querySelector(".sval-prot-site"),
        "with no switches"
      );
    } finally {
      await closePanel();
    }
  });
});

add_task(async function a_page_cannot_pass_itself_off_as_svals() {
  await BrowserTestUtils.withNewTab(
    "data:text/html,<title>sval Settings</title>sval Settings",
    async () => {
      Assert.equal(
        buttonIn().dataset.page,
        "other",
        "the button vouches for nothing"
      );
      await openPanel();
      try {
        Assert.equal(
          panelIn().querySelector(".sval-prot-domain").textContent,
          "data:",
          "the panel names the page by its scheme, never its title"
        );
        Assert.equal(
          panelIn().querySelector(".sval-prot-body").dataset.page,
          "other",
          "and never calls it Sval's"
        );
      } finally {
        await closePanel();
      }
    }
  );
});

add_task(async function a_recent_breach_shows_with_its_source() {
  await setBreaches([BREACH]);
  await BrowserTestUtils.withNewTab(SECURE_PAGE, async () => {
    await TestUtils.waitForCondition(
      () => buttonIn().hasAttribute("sval-breach"),
      "the button marks the breach"
    );
    const browser = gBrowser.selectedBrowser;
    browser.getContentBlockingLog = () =>
      JSON.stringify({
        "https://tracker-a.test": [
          [Ci.nsIWebProgressListener.STATE_BLOCKED_TRACKING_CONTENT, true, 1],
        ],
      });
    try {
      SvalProtectionButton.forWindow(window).update();
      Assert.equal(buttonIn().dataset.look, "active", "Sval blocked something");
      Assert.ok(
        !buttonIn().hasAttribute("sval-count"),
        "the breach's dot takes the count's corner"
      );
    } finally {
      delete browser.getContentBlockingLog;
      SvalProtectionButton.forWindow(window).update();
    }
    Assert.ok(
      buttonIn()
        .getAttribute("aria-label")
        .includes(String(Temporal.Now.plainDateISO().year)),
      "and its name says when"
    );
    await openPanel();
    try {
      const card = panelIn().querySelector(".sval-prot-breach");
      Assert.ok(card, "the panel shows the breach");
      Assert.ok(
        BREACH.DataClasses.every(name =>
          card.textContent.toLowerCase().includes(name.toLowerCase())
        ),
        "with what was exposed"
      );
      const source = byId("sval-prot-hibp");
      Assert.equal(
        source.href,
        "https://haveibeenpwned.com/",
        "and links its source"
      );
      byId("sval-prot-breach-dismiss").click();
      await TestUtils.waitForCondition(
        () => !panelIn().querySelector(".sval-prot-breach"),
        "dismissing removes the card"
      );
      Assert.ok(
        !buttonIn().hasAttribute("sval-breach"),
        "and the button's mark"
      );
    } finally {
      await closePanel();
    }
  });
  forgetBreaches();
  await BrowserTestUtils.withNewTab(SECURE_PAGE, async () => {
    await openPanel();
    try {
      await TestUtils.waitForCondition(
        () => panelIn().querySelector(".sval-prot-conn"),
        "the panel drawn"
      );
      Assert.ok(
        !panelIn().querySelector(".sval-prot-breach"),
        "a dismissed breach stays dismissed"
      );
    } finally {
      await closePanel();
    }
  });
});

add_task(async function breach_warnings_turned_off_show_nothing() {
  await setBreaches([BREACH]);
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.breachWarnings", false]],
  });
  await BrowserTestUtils.withNewTab(SECURE_PAGE, async () => {
    await openPanel();
    try {
      Assert.ok(
        !panelIn().querySelector(".sval-prot-breach"),
        "no breach card while warnings are off"
      );
      Assert.ok(!buttonIn().hasAttribute("sval-breach"), "nor a dot");
    } finally {
      await closePanel();
    }
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function an_old_breach_does_not_show() {
  await setBreaches([
    {
      ...BREACH,
      Name: "OldBreach",
      BreachDate: Temporal.Now.plainDateISO().subtract({ years: 2 }).toString(),
    },
  ]);
  await BrowserTestUtils.withNewTab(SECURE_PAGE, async () => {
    await openPanel();
    try {
      Assert.ok(
        !panelIn().querySelector(".sval-prot-breach"),
        "a breach over a year old shows nothing"
      );
    } finally {
      await closePanel();
    }
  });
});

/**
 * @param {string} site
 * @returns {Promise<object|null>} The site's breach, once its lookup has
 *   answered.
 */
async function lookedUp(site) {
  const now = breachFor(site, () => {});
  if (now !== undefined) {
    return now;
  }
  await within(
    new Promise(resolve => breachFor(site, resolve)),
    10_000,
    "the breach lookup"
  );
  return breachFor(site, () => {});
}

// A breach no earlier task dismissed.
const UNDISMISSED = {
  ...BREACH,
  id: "5d1e7c2a-9b34-4f0e-a6d8-3c71b2e09f45",
  Name: "UndismissedBreach",
};

add_task(async function an_entry_with_a_bad_date_leaves_the_others() {
  await setBreaches([
    {
      ...BREACH,
      id: "c3b0e2f4-1f7a-4a52-8f43-2a8e7d3c9b10",
      Name: "Bad",
      BreachDate: "not a date",
    },
    UNDISMISSED,
  ]);
  const found = await lookedUp("example.com");
  Assert.equal(found?.Name, UNDISMISSED.Name, "the well-formed entry is found");
  forgetBreaches();
});

add_task(async function every_caller_is_told_when_a_lookup_answers() {
  await setBreaches([UNDISMISSED]);
  let first;
  let second;
  const answered = Promise.all([
    new Promise(resolve => {
      first = breachFor("example.com", resolve);
    }),
    new Promise(resolve => {
      second = breachFor("example.com", resolve);
    }),
  ]);
  Assert.equal(first, undefined, "the first call starts the lookup");
  Assert.equal(second, undefined, "the second waits on the same one");
  await within(answered, 10_000, "both callers told");
  Assert.equal(breachFor("example.com", () => {})?.Name, UNDISMISSED.Name);
  forgetBreaches();
});

add_task(async function a_failed_lookup_waits_for_the_next_sync() {
  forgetBreaches();
  const client = RemoteSettings("fxmonitor-breaches");
  const get = client.get;
  let reads = 0;
  client.get = async () => {
    reads++;
    throw new Error("unreadable");
  };
  try {
    Assert.equal(await lookedUp("example.com"), null, "no breach shown");
    Assert.equal(
      breachFor("example.com", () => {}),
      null,
      "kept as none"
    );
    Assert.equal(reads, 1, "the list is not read again");
    await client.emit("sync", { data: {} });
    Assert.equal(
      breachFor("example.com", () => {}),
      undefined,
      "the next sync lets the lookup run again"
    );
    await lookedUp("example.com");
    Assert.equal(reads, 2, "and read the list once more");
  } finally {
    client.get = get;
    forgetBreaches();
  }
});
