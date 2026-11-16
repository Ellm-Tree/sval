/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const {
  ADJECTIVES,
  CARD_PREF,
  NOUNS,
  SYNC_RULES,
  arcCardOf,
  cardYears,
  ensureCard,
  readCard,
  takeArcCard,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalCard.sys.mjs"
);
const { cardSVG } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalCardArt.sys.mjs"
);

do_get_profile();

/** Arc's two files as Arc writes them, for a user who joined on 17 May 2024. */
const MEMBERSHIP = {
  version: 1,
  shapeName: "Shape3",
  paletteNumber: 4,
  backgroundBlobInfo: [2, 10, 5, 5, 12, 11, 2, 12, 3, 2, 11, 3, 6, 14, 3],
  title: "VAGUE ARCHIVIST",
};
// Seconds from 2001-01-01 UTC to noon UTC on 17 May 2024, a day in every
// time zone the run might be in.
const JOINED = (Date.UTC(2024, 4, 17, 12) - Date.UTC(2001, 0, 1)) / 1000;
const AUTH = { session: { user: { createdAt: JOINED, name: "A" } } };

/** Icon and wordmark stand-ins with the shape the art reads. */
const ASSETS = {
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><radialGradient id="svali0limb"/></defs><polygon points="300,300 400,300 350,400" fill="#4f7cbc"/><polygon points="500,500 600,500 550,600" fill="#f2fdff"/><circle r="10" fill="#0a0f24"/><circle r="401" fill="url(#svali0limb)"/></svg>',
  wordmark:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 372 99"><defs><linearGradient id="wm1"/></defs><path d="M0 0" fill="url(#wm1)"/></svg>',
};

function clearCard() {
  Services.prefs.clearUserPref(CARD_PREF);
}
registerCleanupFunction(clearCard);

add_task(function arc_files_give_the_users_arc_card() {
  const arc = arcCardOf(MEMBERSHIP, AUTH);
  Assert.equal(arc.title, "VAGUE ARCHIVIST");
  Assert.equal(arc.since, "2024-05-17");
  Assert.equal(arc.shape, 3);
  Assert.equal(arc.palette, 4);
  Assert.equal(
    arcCardOf(MEMBERSHIP, AUTH).seed,
    arc.seed,
    "the same Arc card always draws the same"
  );
});

add_task(function a_file_arc_did_not_write_gives_no_card() {
  for (const [membership, auth] of [
    [{ ...MEMBERSHIP, shapeName: "Shape9" }, AUTH],
    [{ ...MEMBERSHIP, paletteNumber: 0 }, AUTH],
    [{ ...MEMBERSHIP, title: "" }, AUTH],
    [{ ...MEMBERSHIP, backgroundBlobInfo: "x" }, AUTH],
    [MEMBERSHIP, { session: {} }],
    [MEMBERSHIP, null],
  ]) {
    Assert.equal(arcCardOf(membership, auth), null);
  }
});

add_task(function arc_years_end_the_day_the_user_came_to_sval() {
  clearCard();
  const arc = arcCardOf(MEMBERSHIP, AUTH);
  const card = takeArcCard(arc, new Date(2026, 10, 7));
  Assert.deepEqual(readCard(), card, "the card is kept");
  Assert.equal(card.svalSince, "2026-11-07");

  const years = cardYears(card, new Date(2027, 2, 1));
  Assert.deepEqual(
    years.map(y => [y.year, y.arc, y.next]),
    [
      [2025, true, false],
      [2026, true, false],
      [2027, false, true],
    ],
    "two Arc years, then the next one still to come"
  );
  Assert.ok(
    !cardYears(card, new Date(2027, 4, 17))[2].arc,
    "a year completed on Sval is a Sval year"
  );
});

add_task(function importing_arc_again_keeps_the_first_day_on_sval() {
  clearCard();
  const arc = arcCardOf(MEMBERSHIP, AUTH);
  takeArcCard(arc, new Date(2026, 10, 7));
  const again = takeArcCard(arc, new Date(2027, 2, 1));
  Assert.equal(again.svalSince, "2026-11-07");
});

add_task(async function a_sval_user_gets_a_card_that_stays_the_same() {
  clearCard();
  const card = await ensureCard();
  const [adjective, noun] = card.title.split(" ");
  Assert.ok(ADJECTIVES.includes(adjective), `${adjective} is a Sval word`);
  Assert.ok(NOUNS.includes(noun), `${noun} is a Sval word`);
  Assert.equal(card.arc, null);
  Assert.deepEqual(
    await ensureCard(),
    card,
    "asking again gives the same card"
  );
  Assert.ok(
    cardYears(card).every(y => !y.arc),
    "a Sval card has no Arc years"
  );
});

add_task(function an_arc_card_replaces_a_sval_card() {
  clearCard();
  Services.prefs.setStringPref(
    CARD_PREF,
    JSON.stringify({
      title: "STEADY NAVIGATOR",
      seed: 7,
      since: "2026-01-02",
      svalSince: "2026-01-02",
      arc: null,
    })
  );
  const card = takeArcCard(arcCardOf(MEMBERSHIP, AUTH), new Date(2026, 10, 7));
  Assert.equal(card.title, "VAGUE ARCHIVIST");
  Assert.equal(card.since, "2024-05-17");
  Assert.equal(card.svalSince, "2026-11-07");
});

add_task(function another_device_may_send_only_a_card() {
  const { accepts } = SYNC_RULES[CARD_PREF];
  Assert.ok(
    accepts(
      JSON.stringify({
        title: "STEADY NAVIGATOR",
        seed: 7,
        since: "2026-01-02",
        svalSince: "2026-01-02",
        arc: null,
      })
    )
  );
  for (const value of [
    "",
    "{}",
    "not json",
    JSON.stringify({
      title: "STEADY NAVIGATOR",
      seed: 7,
      since: "2026-01-02",
      svalSince: "2025-01-02",
      arc: null,
    }),
  ]) {
    Assert.ok(!accepts(value), `refuses ${value}`);
  }
});

add_task(function the_card_draws_each_year_and_its_title() {
  clearCard();
  const card = takeArcCard(arcCardOf(MEMBERSHIP, AUTH), new Date(2026, 10, 7));
  const now = new Date(2027, 2, 1);
  const svg = cardSVG(card, ASSETS, { now });
  Assert.equal(
    svg.match(/class="sval-mcard-year"/g).length,
    3,
    "two Arc years and the next one"
  );
  Assert.ok(svg.includes(">VAGUE</text>") && svg.includes(">ARCHIVIST</text>"));
  Assert.ok(svg.includes(">II</text>"), "the count of years");
  const tint = svg.slice(svg.indexOf('class="sval-mcard-tint"'));
  Assert.ok(
    tint.includes("<polygon") && !tint.includes('fill="#4f7cbc"'),
    "the moon's Arc layer takes the Arc palette's colours"
  );
});
