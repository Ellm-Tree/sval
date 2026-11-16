/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// The map of trackers' owners (decision 1051).

const {
  MAX_FIRST_PARTIES_BYTES,
  ownerGroups,
  ownSites,
  parseFirstParties,
  rules,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTrackerOwners.sys.mjs"
);
const { OWNERS: SVAL } = ChromeUtils.importESModule(
  "chrome://browser/content/sval/tracker-owners/sval.mjs"
);

const KINDS = new Set(["published", "certificate", "rdap", "policy"]);

add_task(function a_groups_own_sites_are_registrable_domains() {
  const groups = ownerGroups();
  Assert.greater(groups.length, 100, "the bundled sources load");
  for (const group of groups) {
    Assert.greater(group.length, 1, `${group[0]}'s group names another host`);
    for (const site of ownSites(group)) {
      Assert.equal(
        Services.eTLD.getBaseDomainFromHost(site),
        site,
        `${site} is a site of its own`
      );
    }
  }
});

add_task(function svals_own_entries_each_name_their_evidence() {
  for (const entry of SVAL) {
    Assert.equal(typeof entry.company, "string", "an entry names its company");
    for (const [domain, evidence] of Object.entries(entry.domains)) {
      Assert.greater(evidence.length, 0, `${domain} has evidence`);
      for (const { kind, url, checked } of evidence) {
        Assert.ok(KINDS.has(kind), `${domain}: ${kind} is a known kind`);
        Assert.ok(
          url.startsWith("https://"),
          `${domain}: its source is an address`
        );
        Assert.stringMatches(
          checked,
          /^\d{4}-\d{2}-\d{2}$/,
          `${domain}: dated`
        );
      }
    }
  }
});

add_task(function an_exception_covers_only_what_a_list_names() {
  const text = rules(["||doubleclick.net^\n@@||facebook.net^\n##.ad\n"]);
  const lines = text.split("\n");
  Assert.ok(
    lines.some(line => line.startsWith("@@||doubleclick.net^$domain=")),
    "a blocked tracker with an owner gets an exception"
  );
  Assert.ok(
    !lines.some(line => line.startsWith("@@||facebook.net^")),
    "an exception or a cosmetic rule in a list names no tracker"
  );
});

add_task(function shared_hosting_is_never_excepted_whole() {
  const text = rules([
    "||abc123.cloudfront.net^\n||cloudfront.net^\n||amazonaws.com^\n",
  ]);
  for (const shared of ["cloudfront.net", "amazonaws.com"]) {
    Assert.ok(
      !text.split("\n").some(line => line.startsWith(`@@||${shared}^`)),
      `${shared} is excepted as a whole for no company`
    );
  }
  for (const line of text.split("\n").filter(Boolean)) {
    for (const site of line.split("$domain=")[1].split("|")) {
      Assert.equal(
        Services.eTLD.getBaseDomainFromHost(site),
        site,
        `${site}, a page an exception applies on, is a site of its own`
      );
    }
  }
});

/** Privacy Badger's module as it publishes it, cut down. */
const FIRST_PARTIES = `/**
 * 2d array of related domains (etld+1)
 */
let multiDomainFirstPartiesArray = [
  ["1800contacts.com", "800contacts.com"],
  [
    "action.group",

    "action360.ru", // a comment
    "fd.ru",
  ],
  [ "actonsoftware.com", "actonservice.com"],
];

function makeDomainLookup(mdfpArray) {
  return eval(mdfpArray);
}
`;

add_task(function privacy_badgers_groups_are_read_as_data() {
  Assert.deepEqual(parseFirstParties(FIRST_PARTIES), [
    ["1800contacts.com", "800contacts.com"],
    ["action.group", "action360.ru", "fd.ru"],
    ["actonsoftware.com", "actonservice.com"],
  ]);
});

add_task(function anything_but_host_strings_is_refused() {
  const array = body => `let multiDomainFirstPartiesArray = [\n${body}\n];\n`;
  const refused = {
    "a call": array(`["a.com", "b.com"],\nfetch("https://x.example/"),`),
    "a spread": array(`[..."a.com"],`),
    "single quotes": array(`['a.com', 'b.com'],`),
    "a block comment": array(`/* x */ ["a.com", "b.com"],`),
    "a host with a path": array(`["a.com/x", "b.com"],`),
    "upper case": array(`["A.com", "b.com"],`),
    "an escape": array(`["a\\u0063om", "b.com"],`),
    "a single label": array(`["localhost", "b.com"],`),
    "an empty group": array(`[],`),
    "no groups": array(""),
    "a doubled comma": array(`["a.com",, "b.com"],`),
    "a nested array": array(`[["a.com"]],`),
    "no array": "export default [];",
    "two arrays": array(`["a.com", "b.com"]`) + array(`["c.com", "d.com"]`),
    "no end": `let multiDomainFirstPartiesArray = [\n["a.com", "b.com"],\n`,
    "too large": array(
      `["a.com", "b.com"],\n// ${"x".repeat(MAX_FIRST_PARTIES_BYTES)}\n`
    ),
  };
  for (const [what, text] of Object.entries(refused)) {
    Assert.throws(() => parseFirstParties(text), /./, `${what} is refused`);
  }
});

add_task(function downloaded_groups_join_the_bundled_ones() {
  const tracked = ["||owner-cdn.example^\n||windows.net^\n"];
  Assert.ok(
    !rules(tracked).includes("owner-cdn.example"),
    "without Privacy Badger's copy, its groups are not used"
  );
  const text = rules(tracked, [
    ["owner-cdn.example", "owner-one.example", "windows.net"],
  ]);
  Assert.ok(
    text
      .split("\n")
      .includes(
        "@@||owner-cdn.example^$domain=owner-cdn.example|owner-one.example"
      ),
    "a downloaded group excepts its tracker on its own sites"
  );
  Assert.ok(
    !text.includes("windows.net"),
    "a host above shared hosting is dropped from a downloaded group"
  );
});
