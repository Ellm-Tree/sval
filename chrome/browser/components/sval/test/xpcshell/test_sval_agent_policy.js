/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const {
  appPermissionFor,
  appsOf,
  cleanPolicy,
  decideLoad,
  DEFAULT_POLICY,
  defaultLevelOf,
  defaultOf,
  filePermissionFor,
  hostOf,
  agentSiteOf,
  siteOfPrincipal,
  levelFor,
  localPlaceOf,
  uploadFoldersFor,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs"
);
const {
  siteOf,
  siteOfEntry,
  mostSpecificRule,
  scopeChain,
  scopeOf,
  scopeOfHost,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSite.sys.mjs"
);
const { ToolError } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs"
);

add_task(function a_site_is_its_registrable_domain() {
  Assert.equal(agentSiteOf("https://www.ebay.co.uk/itm/1"), "ebay.co.uk");
  Assert.equal(agentSiteOf("http://a.b.example.com:8080/x"), "example.com");
  Assert.equal(agentSiteOf("https://192.0.2.4/"), "192.0.2.4");
  Assert.equal(agentSiteOf("http://localhost:3000/"), "localhost");
  Assert.equal(agentSiteOf("http://intranet/"), "intranet");
  Assert.equal(agentSiteOf("about:blank"), null);
});

// nsIURI.host is bracketless for IPv6, and getBaseDomainFromHost answers
// NS_ERROR_HOST_IS_IP_ADDRESS (netwerk/dns/nsEffectiveTLDService.cpp), so the
// site is the bare address.
add_task(function an_ipv6_literal_is_its_own_site() {
  Assert.equal(agentSiteOf("http://[::1]/"), "::1");
  Assert.equal(agentSiteOf("http://[::1]:8080/x"), "::1");
});

add_task(function a_trailing_dot_does_not_make_a_second_site() {
  Assert.equal(agentSiteOf("https://www.ebay.com./"), "ebay.com");
  Assert.equal(agentSiteOf("http://localhost./"), "localhost");
});

add_task(function other_schemes_are_refused() {
  for (const url of [
    "file:///etc/passwd",
    "about:config",
    "chrome://browser/content/browser.xhtml",
    "data:text/html,x",
    "javascript:alert(1)",
    "not a url",
    "",
  ]) {
    Assert.throws(
      () => agentSiteOf(url),
      e => e instanceof ToolError && e.code === "unsupported_url",
      url
    );
  }
});

/**
 * Every spelling of one site gives that site, and every spelling `siteOf`
 * cannot place is refused. A spelling that gave a new site would let a page
 * dodge the decision made for the site it names.
 */
add_task(function every_spelling_of_a_site_is_that_site() {
  const SITES = [
    // Case.
    ["https://WWW.Example.COM/", "example.com"],
    ["HTTPS://example.com/", "example.com"],
    // Trailing dots: one is the same name, more are no name at all.
    ["https://ebay.com./", "ebay.com"],
    ["https://pay.ebay.co.uk./x", "ebay.co.uk"],
    ["http://localhost./", "localhost"],
    // IP literals, in the spellings the URL parser folds to one.
    ["http://127.0.0.1/", "127.0.0.1"],
    ["http://0x7f.0.0.1/", "127.0.0.1"],
    ["http://2130706433/", "127.0.0.1"],
    ["http://[::1]/", "::1"],
    ["http://[0:0::1]:81/", "::1"],
    // localhost and single labels.
    ["http://localhost:3000/", "localhost"],
    ["http://LOCALHOST/", "localhost"],
    ["http://intranet/", "intranet"],
    // IDN: the Unicode and punycode spellings are one site.
    ["https://www.bücher.de/", "xn--bcher-kva.de"],
    ["https://www.xn--bcher-kva.de/", "xn--bcher-kva.de"],
    ["https://BÜCHER.de/", "xn--bcher-kva.de"],
    // Ports.
    ["https://example.com:8443/", "example.com"],
    ["http://example.com:80/", "example.com"],
    // Userinfo is not the host.
    ["https://user:pw@example.com/", "example.com"],
    ["https://ebay.com@example.org/", "example.org"],
    ["https://ebay.com:443@example.org/", "example.org"],
    // The one page with no site.
    ["about:blank", null],
  ];
  for (const [url, site] of SITES) {
    Assert.strictEqual(agentSiteOf(url), site, url);
  }

  const REFUSED = [
    // Empty labels.
    "https://ebay.com../",
    "https://ebay.com.../",
    "https://ebay..com/",
    "https://.ebay.com/",
    "http://localhost../",
    // Pages with no web site of their own.
    "about:blank#x",
    "about:blank?x",
    "about:srcdoc",
    "about:config",
    "data:text/html,x",
    "file:///etc/passwd",
    "file://host/share",
    "blob:https://example.com/0b1c4f04-5a3e-4f1e-9d4a-2a1c4f0e5b6d",
    "view-source:https://example.com/",
    "javascript:1",
    "ftp://example.com/",
    "ws://example.com/",
    "http://",
  ];
  for (const url of REFUSED) {
    Assert.throws(
      () => agentSiteOf(url),
      e => e instanceof ToolError && e.code === "unsupported_url",
      url
    );
  }
});

add_task(function a_known_site_uses_its_exception_and_others_the_default() {
  const policy = {
    version: 2,
    default: "read-only",
    sites: { "github.com": "full", "bank.example": "blocked" },
  };
  Assert.deepEqual(levelFor(policy, "github.com"), {
    level: "full",
    known: true,
    asks: false,
  });
  Assert.deepEqual(levelFor(policy, "bank.example"), {
    level: "blocked",
    known: true,
    asks: false,
  });
  Assert.deepEqual(levelFor(policy, "ebay.com"), {
    level: "read-only",
    known: false,
    asks: false,
  });
});

/**
 * Under the "ask" default a site with no rule asks on its first visit, and
 * until then has the level that holds its writes.
 */
add_task(function the_ask_default_asks_about_a_site_with_no_rule() {
  const policy = { version: 2, default: "ask", sites: { "a.example": "full" } };
  Assert.deepEqual(levelFor(policy, "b.example"), {
    level: "ask-before-writes",
    known: false,
    asks: true,
  });
  Assert.deepEqual(levelFor(policy, "a.example"), {
    level: "full",
    known: true,
    asks: false,
  });
  Assert.equal(defaultOf(policy), "ask");
  Assert.equal(defaultLevelOf(policy), "ask-before-writes");
  Assert.equal(defaultLevelOf({ default: "blocked" }), "blocked");
  Assert.deepEqual(DEFAULT_POLICY.default, "ask", "a new agent asks first");
});

/**
 * A site whose name or address is this computer's or the local network's is
 * known by the site `siteOf` gives a load of it, and a public one is not.
 */
add_task(function a_local_sites_place_is_known_by_its_name_or_address() {
  for (const [url, place] of [
    ["http://localhost:3000/", "computer"],
    ["http://dev.app.localhost/", "computer"],
    ["http://127.0.0.1/", "computer"],
    ["http://127.4.5.6/", "computer"],
    ["http://[::1]:8080/", "computer"],
    ["http://0.0.0.0/", "computer"],
    ["http://10.1.2.3/", "network"],
    ["http://172.16.0.9/", "network"],
    ["http://192.168.1.1/", "network"],
    ["http://169.254.10.20/", "network"],
    ["http://100.64.0.1/", "network"],
    ["http://[fe80::1]/", "network"],
    ["http://[fd12::1]/", "network"],
    ["http://printer.local/", "network"],
    ["http://nas.home.local/", "network"],
    ["http://router/", "network"],
    ["http://[::ffff:127.0.0.1]:8888/", "computer"],
    ["http://[::ffff:7f00:1]/", "computer"],
    ["http://[::ffff:0.0.0.0]/", "computer"],
    ["http://[::ffff:192.168.1.1]/", "network"],
    ["http://[::ffff:100.100.100.100]/", "network"],
    ["https://example.com/", null],
    ["https://8.8.8.8/", null],
    ["https://[2001:db8::1]/", null],
    ["https://[::ffff:8.8.8.8]/", null],
    ["https://local.example/", null],
    ["https://localhost.example/", null],
  ]) {
    Assert.equal(localPlaceOf(agentSiteOf(url)), place, url);
  }
});

/**
 * A local site with no rule asks on its first visit whatever default lets a
 * new site open, and its rule decides it once there is one. Under a Blocked
 * default it is blocked, as every new site is.
 */
add_task(function a_local_site_with_no_rule_asks_under_any_open_default() {
  for (const value of ["read-only", "ask-before-writes", "full", "ask"]) {
    const policy = { version: 2, default: value, sites: { router: "full" } };
    Assert.deepEqual(
      levelFor(policy, "192.168.1.1"),
      { level: "ask-before-writes", known: false, asks: true },
      value
    );
    Assert.equal(decideLoad(policy, "localhost"), "ask", value);
    Assert.equal(decideLoad(policy, "router"), "allow", value);
  }
  const blocked = { version: 2, default: "blocked", sites: {} };
  Assert.equal(decideLoad(blocked, "192.168.1.1"), "deny");
  Assert.equal(
    decideLoad({ version: 2, default: "full", sites: {} }, "example.com"),
    "allow",
    "a public site with no rule follows the default"
  );
});

/**
 * A rule Sval cannot read is no rule: its site follows the default (spec
 * §5.2). An unknown default, and a sites value that is not a map, ask.
 */
add_task(function an_unreadable_value_follows_the_default() {
  Assert.deepEqual(
    levelFor(
      { default: "read-only", sites: { "a.example": "everything" } },
      "a.example"
    ),
    { level: "read-only", known: false, asks: false },
    "an unknown site level follows the default"
  );
  Assert.deepEqual(
    levelFor(
      { default: "ask", sites: { "a.example": "everything" } },
      "a.example"
    ),
    { level: "ask-before-writes", known: false, asks: true },
    "an unknown site level under the ask default asks, as a new site does"
  );
  Assert.deepEqual(
    levelFor({ default: "Full", sites: {} }, "a.example"),
    { level: "ask-before-writes", known: false, asks: true },
    "an unknown default asks"
  );
  Assert.deepEqual(
    levelFor({ default: "read-only", sites: ["full"] }, "0"),
    { level: "ask-before-writes", known: false, asks: true },
    "a sites value that is not a map holds nothing, and asks"
  );
  Assert.deepEqual(
    levelFor(null, "a.example"),
    { level: "ask-before-writes", known: false, asks: true },
    "no policy at all reads as the default policy"
  );
  Assert.equal(
    filePermissionFor(
      { downloads: { "a.example": "allow" } },
      "downloads",
      "a.example"
    ),
    "allow"
  );
  Assert.equal(
    filePermissionFor(
      { uploads: { "a.example": "deny" } },
      "uploads",
      "a.example"
    ),
    "deny"
  );
  Assert.equal(
    filePermissionFor(
      { console: { "a.example": "allow" } },
      "console",
      "a.example"
    ),
    "allow"
  );
  Assert.equal(
    cleanPolicy({ console: { "a.example": "maybe", "b.example": "deny" } })
      .policy.console["a.example"],
    undefined,
    "a console answer Sval cannot read asks again"
  );
  for (const value of ["yes", true, null, 1]) {
    Assert.equal(
      filePermissionFor(
        { downloads: { "a.example": value } },
        "downloads",
        "a.example"
      ),
      null,
      `${value} asks again`
    );
  }
  Assert.equal(
    filePermissionFor({ downloads: "x" }, "downloads", "a.example"),
    null
  );
  Assert.equal(filePermissionFor({}, "uploads", "__proto__"), null);
  const docs = { path: "/home/u/Docs", subfolders: false };
  const folders = { uploads: { "a.example": { folders: [docs] } } };
  Assert.equal(filePermissionFor(folders, "uploads", "a.example"), "allow");
  Assert.deepEqual(uploadFoldersFor(folders, "a.example"), [docs]);
  for (const value of [
    "allow",
    { folders: [] },
    { folders: [7] },
    { folders: ["/home/u/Docs"] },
    { folders: [{ path: "/home/u/Docs" }] },
    { folders: [{ path: "", subfolders: true }] },
    {},
  ]) {
    const policy = { uploads: { "a.example": value } };
    Assert.equal(
      filePermissionFor(policy, "uploads", "a.example"),
      null,
      `uploads ${JSON.stringify(value)} asks again`
    );
    Assert.deepEqual(uploadFoldersFor(policy, "a.example"), []);
  }
  Assert.equal(defaultOf({ default: 7 }), "ask");
  Assert.equal(defaultLevelOf({ default: 7 }), "ask-before-writes");
});

/** A site named like a prototype member is unknown unless it was set. */
add_task(function inherited_names_are_not_known_sites() {
  // Each name is a single label, a local site, which asks under any other
  // default.
  const policy = { version: 2, default: "blocked", sites: {} };
  for (const site of [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ]) {
    Assert.deepEqual(
      levelFor(policy, site),
      { level: "blocked", known: false, asks: false },
      site
    );
  }
  const set = JSON.parse('{"sites": {"__proto__": "full"}}');
  Assert.deepEqual(
    levelFor({ default: "read-only", sites: set.sites }, "__proto__"),
    { level: "full", known: true, asks: false },
    "an own __proto__ key is known"
  );
});

add_task(function a_later_or_clean_policy_is_left_as_it_is() {
  const later = {
    version: 4,
    default: "full",
    sites: { "a.example": "full" },
    downloads: {},
    uploads: {},
    later: { kept: true },
  };
  Assert.deepEqual(
    cleanPolicy(later),
    { policy: later, changed: false },
    "a later version is left as a later build wrote it"
  );
  const clean = { ...structuredClone(DEFAULT_POLICY) };
  Assert.deepEqual(
    cleanPolicy(clean),
    { policy: clean, changed: false },
    "a clean policy is left as it is"
  );
});

/**
 * Cleaning deletes the entries Sval cannot read. A dropped site follows the
 * default; an unreadable default is Sval's own, "ask".
 */
add_task(function unreadable_rules_are_deleted_and_follow_the_default() {
  const stored = JSON.parse(`{
    "version": 2,
    "default": "full",
    "sites": { "a.example": "everything", "b.example": "read-only",
               "__proto__": 3 },
    "downloads": { "a.example": "maybe", "b.example": "deny" },
    "uploads": { "c.example": { "folders": [
                   { "path": "/home/u/Documents", "subfolders": true },
                   { "path": "/home/u/Old", "subfolders": "yes" },
                   "/home/u/Bare" ] },
                 "d.example": null, "e.example": "allow",
                 "f.example": { "folders": [] } },
    "apps": { "a.example": { "zoommtg": "allow", "Bad": "allow",
                             "mailto": "sometimes" },
              "b.example": "deny", "c.example": "allow",
              "d.example": { "mailto": 1 } }
  }`);
  const { policy, changed } = cleanPolicy(stored);
  Assert.ok(changed);
  Assert.deepEqual(Object.keys(policy.sites), ["b.example"]);
  Assert.deepEqual(policy.downloads, { "b.example": "deny" });
  Assert.deepEqual(
    policy.uploads,
    {
      "c.example": {
        folders: [{ path: "/home/u/Documents", subfolders: true }],
      },
    },
    "an upload is allowed only from the folders an entry names"
  );
  Assert.deepEqual(
    policy.apps,
    { "a.example": { zoommtg: "allow" }, "b.example": "deny" },
    "an app entry keeps the schemes Sval can read"
  );
  Assert.equal(policy.default, "full", "a readable default is kept");
  for (const site of ["a.example", "e.example"]) {
    Assert.deepEqual(
      levelFor(policy, site),
      { level: "full", known: false, asks: false },
      `${site} follows the default`
    );
  }
  Assert.deepEqual(
    levelFor(policy, "__proto__"),
    { level: "ask-before-writes", known: false, asks: true },
    "__proto__, a single label and so a local name, asks as one"
  );
  Assert.ok(
    !cleanPolicy(policy).changed,
    "the cleaned policy is clean the next time"
  );

  Assert.equal(
    cleanPolicy({ version: 2, default: "sometimes" }).policy.default,
    "ask",
    "an unreadable default is Sval's own default"
  );
  const asked = cleanPolicy({ version: 2, default: "sometimes" }).policy;
  Assert.deepEqual(
    levelFor(asked, "a.example"),
    { level: "ask-before-writes", known: false, asks: true },
    "so a site with no rule asks"
  );
  const lost = cleanPolicy({ version: 2, default: "full", sites: "garbage" });
  Assert.deepEqual(lost.policy.sites, {});
  Assert.equal(
    lost.policy.default,
    "ask",
    "a sites value that is not a map makes every site ask"
  );
  Assert.deepEqual(
    cleanPolicy("garbage").policy,
    structuredClone(DEFAULT_POLICY),
    "a policy that is not a map is a new agent's"
  );
});

add_task(function a_typed_site_is_its_registrable_domain() {
  for (const [text, site, host] of [
    ["ebay.co.uk", "ebay.co.uk", "ebay.co.uk"],
    ["https://pay.ocado.com/basket?id=4471", "ocado.com", "pay.ocado.com"],
    ["  shop.amazon.co.uk  ", "amazon.co.uk", "shop.amazon.co.uk"],
    ["http://user:pw@www.example.org:8080/x", "example.org", "www.example.org"],
    ["a.b.github.io", "b.github.io", "a.b.github.io"],
    ["192.0.2.84", "192.0.2.84", "192.0.2.84"],
    ["localhost", "localhost", "localhost"],
    ["Example.COM.", "example.com", "example.com"],
  ]) {
    Assert.deepEqual(siteOfEntry(text), { site, host }, text);
  }
  for (const host of ["github.io", "blogspot.com", "co.uk"]) {
    Assert.deepEqual(
      siteOfEntry(host),
      { site: host, host, suffix: true },
      `${host}, itself a public suffix, is its own site`
    );
  }
  Assert.deepEqual(siteOfEntry("   "), { error: "empty" });
  for (const text of [
    "file:///etc/passwd",
    "not a site",
    "a..b",
    "ftp://x.com",
  ]) {
    Assert.equal(siteOfEntry(text).error, "not-a-site", text);
  }
});

/** A typed site is always the key `siteOf` gives a load of its host. */
add_task(function a_typed_site_is_the_site_a_load_of_it_has() {
  for (const text of [
    "github.io",
    "pages.github.io",
    "a.pages.github.io",
    "blogspot.com",
    "co.uk",
    "ebay.co.uk",
    "www.ebay.co.uk",
    "localhost",
    "192.0.2.84",
    "Example.COM.",
  ]) {
    const { site, host } = siteOfEntry(text);
    Assert.equal(site, agentSiteOf(`https://${host}/`), text);
  }
  Assert.equal(siteOfEntry("pages.github.io").site, "pages.github.io");
});

add_task(function a_documents_site_is_its_principals_and_fails_closed() {
  const ssm = Services.scriptSecurityManager;
  const uri = spec => Services.io.newURI(spec);
  const refused = (fn, why) =>
    Assert.throws(
      fn,
      e => e instanceof ToolError && e.code === "unsupported_url",
      why
    );

  const page = ssm.createContentPrincipal(uri("https://www.example.com/a"), {});
  Assert.equal(
    siteOfPrincipal(page, uri("https://www.example.com/a")),
    "example.com"
  );
  refused(
    () =>
      siteOfPrincipal(
        ssm.createContentPrincipal(uri("file:///tmp/x.html"), {}),
        uri("file:///tmp/x.html")
      ),
    "a content principal must be http or https"
  );

  const blank = ssm.createNullPrincipal({});
  Assert.ok(!blank.precursorPrincipal, "a fresh null principal has none");
  Assert.strictEqual(
    siteOfPrincipal(blank, uri("about:blank")),
    null,
    "a blank page with no precursor has no site"
  );
  refused(
    () => siteOfPrincipal(blank, uri("https://example.org/")),
    "a null principal with no precursor anywhere else is refused"
  );
  refused(
    () => siteOfPrincipal(blank, uri("data:text/html,x")),
    "a data: document with no precursor is refused"
  );
  refused(
    () => siteOfPrincipal(blank, null),
    "and so is one whose address is unknown"
  );

  const pdf = ssm.createContentPrincipal(
    uri("resource://pdf.js/web/viewer.html"),
    {}
  );
  Assert.equal(pdf.originNoSuffix, "resource://pdf.js");
  Assert.equal(
    siteOfPrincipal(pdf, uri("https://docs.example.net/a.pdf")),
    "example.net",
    "PDF.js is the site of the PDF it shows"
  );
  refused(
    () => siteOfPrincipal(pdf, uri("file:///tmp/a.pdf")),
    "a local PDF is refused"
  );
  refused(
    () => siteOfPrincipal(pdf, uri("about:blank")),
    "PDF.js with no PDF address is refused"
  );

  // An error page is the site of the load that failed, so a blocked site's
  // error page is as closed to the agent as the site.
  const errorPage = ssm.createContentPrincipal(
    uri("about:neterror?e=connectionFailure"),
    {}
  );
  Assert.equal(errorPage.originNoSuffix, "about:neterror");
  Assert.equal(
    siteOfPrincipal(
      errorPage,
      uri("about:neterror?e=connectionFailure"),
      uri("https://shop.example.net/cart")
    ),
    "example.net",
    "an error page is the site of the load that failed"
  );
  refused(
    () => siteOfPrincipal(errorPage, uri("about:neterror"), null),
    "an error page with no failed load is refused"
  );

  refused(
    () => siteOfPrincipal(ssm.getSystemPrincipal(), uri("about:blank")),
    "the system principal is refused"
  );
  const expanded = Cu.getObjectPrincipal(
    Cu.Sandbox([page, "https://example.org"])
  );
  Assert.ok(expanded.isExpandedPrincipal);
  refused(
    () => siteOfPrincipal(expanded, uri("https://example.com/")),
    "an expanded principal is refused"
  );
  refused(() => siteOfPrincipal(null, uri("about:blank")), "no principal");

  refused(
    () => siteOfPrincipal(page, uri("blob:https://www.example.com/1234")),
    "a page at a blob: address is refused, whoever made it"
  );
  const dataFromPage = Cu.getObjectPrincipal(
    Cu.Sandbox(ssm.createNullPrincipal({}))
  );
  refused(
    () => siteOfPrincipal(dataFromPage, uri("data:text/html,x")),
    "and so is one at a data: address"
  );
});

/**
 * A site's apps are decided per scheme, and a site-wide "deny" opens none
 * (agent-control spec §5.2). Anything else is no decision, and asks.
 */
add_task(function apps_are_decided_per_site_and_scheme() {
  const policy = {
    apps: {
      "zoom.us": { zoommtg: "allow", zoomus: "deny" },
      "shop.example": "deny",
    },
  };
  Assert.equal(appPermissionFor(policy, "zoom.us", "zoommtg"), "allow");
  Assert.equal(appPermissionFor(policy, "zoom.us", "zoomus"), "deny");
  Assert.equal(appPermissionFor(policy, "zoom.us", "mailto"), null);
  Assert.equal(appPermissionFor(policy, "shop.example", "mailto"), "deny");
  Assert.equal(appPermissionFor(policy, "other.example", "mailto"), null);
  Assert.equal(appPermissionFor(policy, "__proto__", "mailto"), null);
  Assert.equal(appPermissionFor({}, "zoom.us", "zoommtg"), null);
  Assert.equal(appsOf("allow"), null, "only Deny covers a whole site");
  Assert.equal(appsOf({}), null, "an entry with no schemes asks");
  Assert.equal(appsOf({ "MAILTO:": "allow" }), null);
});

add_task(function a_host_under_its_site_offers_a_choice_of_scope() {
  Assert.deepEqual(scopeOf("https://nas.example.org/dash"), {
    site: "example.org",
    host: "nas.example.org",
    choice: true,
  });
  Assert.deepEqual(scopeOfHost("a.me.github.io"), {
    site: "me.github.io",
    host: "a.me.github.io",
    choice: true,
  });
  for (const [host, site] of [
    ["example.com", "example.com"],
    ["www.example.com", "example.com"],
    ["me.github.io", "me.github.io"],
    ["github.io", "github.io"],
    ["192.0.2.84", "192.0.2.84"],
    ["localhost", "localhost"],
  ]) {
    Assert.deepEqual(
      scopeOfHost(host),
      { site, host: site, choice: false },
      `${host} has nothing to choose`
    );
  }
  Assert.equal(scopeOf("file:///etc/passwd"), null);
});

add_task(function the_most_specific_name_holding_a_rule_decides() {
  Assert.deepEqual(scopeChain("photos.home.example.org"), [
    "photos.home.example.org",
    "home.example.org",
    "example.org",
  ]);
  Assert.deepEqual(scopeChain("example.org"), ["example.org"]);
  const rules = { "example.org": "block", "home.example.org": "allow" };
  Assert.deepEqual(
    mostSpecificRule("photos.home.example.org", name => rules[name]),
    { name: "home.example.org", rule: "allow" }
  );
  Assert.deepEqual(
    mostSpecificRule("git.example.org", name => rules[name]),
    { name: "example.org", rule: "block" }
  );
  Assert.equal(
    mostSpecificRule("example.com", name => rules[name]),
    null
  );
});

add_task(function a_host_rule_decides_for_its_host_and_the_site_for_the_rest() {
  const policy = {
    default: "ask",
    sites: {
      "example.org": "blocked",
      "nas.example.org": "full",
    },
    downloads: { "example.org": "deny", "nas.example.org": "allow" },
    uploads: {
      "nas.example.org": "deny",
      "example.org": { folders: [{ path: "/tmp/a", subfolders: false }] },
    },
    console: { "example.org": "allow" },
    apps: {
      "nas.example.org": { mailto: "allow" },
      "example.org": "deny",
    },
  };
  const host = hostOf("https://nas.example.org/dash");
  Assert.equal(host, "nas.example.org");
  Assert.equal(decideLoad(policy, host), "allow", "the host's own rule wins");
  Assert.equal(levelFor(policy, "media.nas.example.org").level, "full");
  Assert.equal(
    decideLoad(policy, hostOf("https://git.example.org/")),
    "deny",
    "a sibling host follows the site"
  );
  Assert.equal(filePermissionFor(policy, "downloads", host), "allow");
  Assert.equal(
    filePermissionFor(policy, "downloads", "git.example.org"),
    "deny"
  );
  Assert.equal(
    filePermissionFor(policy, "console", host),
    "allow",
    "a control the host has not set follows the site"
  );
  Assert.deepEqual(uploadFoldersFor(policy, host), [], "the host denies");
  Assert.deepEqual(uploadFoldersFor(policy, "git.example.org"), [
    { path: "/tmp/a", subfolders: false },
  ]);
  Assert.equal(appPermissionFor(policy, host, "mailto"), "allow");
  Assert.equal(
    appPermissionFor(policy, host, "tel"),
    "deny",
    "a scheme the host has not decided follows the site"
  );
});

add_task(function a_host_with_no_choice_is_looked_up_as_its_site() {
  Assert.equal(hostOf("https://www.example.com/"), "example.com");
  Assert.equal(hostOf("http://192.0.2.4/"), "192.0.2.4");
  Assert.equal(hostOf("about:blank"), null);
  Assert.throws(() => hostOf("file:///etc/passwd"), ToolError);
});

add_task(function clean_policy_keeps_rules_named_by_a_host() {
  const stored = {
    version: 3,
    default: "ask",
    sites: {
      "example.org": "blocked",
      "nas.example.org": "full",
      "www.example.com": "full",
    },
    downloads: { "nas.example.org": "allow" },
    uploads: {},
    console: {},
    apps: {},
    pageToolSites: { "nas.example.org": "allow", "github.io.": "deny" },
  };
  const { policy } = cleanPolicy(stored);
  Assert.deepEqual(policy.sites, {
    "example.org": "blocked",
    "nas.example.org": "full",
  });
  Assert.deepEqual(policy.downloads, { "nas.example.org": "allow" });
  Assert.deepEqual(policy.pageToolSites, { "nas.example.org": "allow" });
});

add_task(function a_page_with_no_site_has_none() {
  Assert.equal(siteOf("https://www.ebay.co.uk/itm/1"), "ebay.co.uk");
  for (const url of [
    "about:blank",
    "file:///tmp/a.html",
    "not a url",
    "https://a..example.com/",
  ]) {
    Assert.strictEqual(siteOf(url), null, url);
  }
});
