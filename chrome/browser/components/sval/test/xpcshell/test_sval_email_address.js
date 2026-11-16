/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// Which selections the page menu's "Email" item reads as one email address,
// and the `mailto:` URL it opens for one.

const { emailAddressIn, mailtoFor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmailMenu.sys.mjs"
);

add_task(function a_selected_address_is_read_as_one() {
  for (const [text, address] of [
    ["contactus@example.com", "contactus@example.com"],
    ["  contactus@example.com\n", "contactus@example.com"],
    ["contactus@example.com.", "contactus@example.com"],
    ["(contactus@example.com),", "contactus@example.com"],
    [
      "<first.last+tag@mail.example.co.uk>",
      "first.last+tag@mail.example.co.uk",
    ],
    ["“help@example.org”", "help@example.org"],
    ["mailto:help@example.org", "help@example.org"],
    ["josé@exämple.de", "josé@exämple.de"],
  ]) {
    Assert.equal(emailAddressIn(text), address, `${JSON.stringify(text)}`);
  }
});

add_task(function anything_else_is_not() {
  for (const text of [
    "",
    "contact us",
    "contactus@gruv",
    "user@localhost",
    "user@192.0.2.7",
    "@example.com",
    "contactus@",
    "contactus@@example.com",
    "contact us@example.com",
    "first..last@example.com",
    ".first@example.com",
    "user@-example.com",
    "user@example.c0m",
    "write to contactus@example.com today",
    "a@example.com, b@example.com",
    `${"a".repeat(250)}@example.com`,
  ]) {
    Assert.equal(emailAddressIn(text), null, `${JSON.stringify(text)}`);
  }
});

add_task(function the_url_keeps_the_address_whole() {
  Assert.equal(
    mailtoFor("contactus@example.com"),
    "mailto:contactus@example.com"
  );
  Assert.equal(
    mailtoFor("a?subject=x&b#c%d@example.com"),
    "mailto:a%3Fsubject%3Dx%26b%23c%25d@example.com",
    "the local part's own ?, &, # and % are escaped"
  );
  Assert.equal(mailtoFor("tag+me@example.com"), "mailto:tag%2Bme@example.com");
});
