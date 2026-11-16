/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The user's card: a keepsake that counts the years they have browsed with
 * Sval, and with Arc before it when they brought their Arc card across.
 * Nothing checks it and it unlocks nothing. It is one JSON pref, synced, so
 * every device the user syncs shows the same card:
 *
 *     {
 *       title: "VAGUE ARCHIVIST", // adjective, then the noun (one or more words)
 *       seed: 3518466173,        // a 32-bit integer the card's art draws from
 *       since: "2024-05-17",     // the first day: Arc's join date, or Sval's
 *       svalSince: "2026-11-07", // the first day on Sval
 *       arc: { shape: 3, palette: 4 } | null,
 *     }
 *
 * A year completed before `svalSince` is an Arc year, and every later one a
 * Sval year.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ProfileAge: "resource://gre/modules/ProfileAge.sys.mjs",
});

export const CARD_PREF = "browser.sval.card";

/**
 * The words of a Sval card's title. None is one of Arc's, so a Sval title
 * never reads as Arc's, and none is over 12 letters, the most the card's
 * title line holds at its largest size.
 */
export const ADJECTIVES = Object.freeze([
  "STEADY",
  "BRIGHT",
  "QUIET",
  "LUMINOUS",
  "STARLIT",
  "MOONLIT",
  "RADIANT",
  "PATIENT",
  "SWIFT",
  "CALM",
  "KEEN",
  "ROAMING",
  "DISTANT",
  "SILVER",
  "GOLDEN",
  "FEARLESS",
  "GENTLE",
  "CLEVER",
  "BOLD",
  "RESTLESS",
  "TIRELESS",
  "WATCHFUL",
  "STEADFAST",
  "GLEAMING",
  "COSMIC",
  "LUNAR",
  "POLAR",
  "UNCHARTED",
  "MIDNIGHT",
  "TWILIGHT",
  "ELECTRIC",
  "HUSHED",
  "NOCTURNAL",
  "CELESTIAL",
  "ORBITING",
  "WIDE-EYED",
  "AURORAL",
  "DAUNTLESS",
  "WILY",
  "SPARKLING",
]);

export const NOUNS = Object.freeze([
  "NAVIGATOR",
  "STARGAZER",
  "VOYAGER",
  "SURVEYOR",
  "MAPMAKER",
  "LAMPLIGHTER",
  "PATHFINDER",
  "SCOUT",
  "ASTRONOMER",
  "SKIPPER",
  "DRIFTER",
  "ROVER",
  "TRAILBLAZER",
  "COLLECTOR",
  "CURATOR",
  "OBSERVER",
  "SENTINEL",
  "LOOKOUT",
  "ORBITER",
  "SKYWATCHER",
  "NOMAD",
  "ALCHEMIST",
  "HERALD",
  "RANGER",
  "TRACKER",
  "CHRONICLER",
  "CAPTAIN",
  "COMET",
  "BEACON",
  "LANTERN",
  "EXPLORER",
  "FORAGER",
  "TIMEKEEPER",
  "SEEKER",
  "SAILOR",
  "CARTOGRAPHER",
  "STARCHASER",
  "PIONEER",
  "ASTRONAUT",
  "COMPASS",
]);

/** Arc's times count seconds from 2001-01-01, Apple's reference date. */
const ARC_EPOCH_MS = Date.UTC(2001, 0, 1);

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TITLE = /^[A-Z][A-Z-]*( [A-Z][A-Z-]*)+$/;

/**
 * @param {Date} date
 * @returns {string} the date's local calendar day, as `YYYY-MM-DD`.
 */
export function dayOf(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * @param {string} day A `YYYY-MM-DD` string.
 * @returns {Date|null} its local midnight, or null for anything else.
 */
export function parseDay(day) {
  const m = typeof day === "string" && DAY.exec(day);
  if (!m) {
    return null;
  }
  const date = new Date(+m[1], +m[2] - 1, +m[3]);
  return dayOf(date) === day ? date : null;
}

/**
 * @param {*} value
 * @returns {object|null} `value` as a card, or null when it is not one.
 */
export function validCard(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { title, seed, since, svalSince, arc } = value;
  if (
    typeof title !== "string" ||
    !TITLE.test(title) ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !parseDay(since) ||
    !parseDay(svalSince) ||
    since > svalSince
  ) {
    return null;
  }
  if (
    arc !== null &&
    !(
      arc &&
      Number.isInteger(arc.shape) &&
      arc.shape >= 1 &&
      arc.shape <= 4 &&
      Number.isInteger(arc.palette) &&
      arc.palette >= 1 &&
      arc.palette <= 8
    )
  ) {
    return null;
  }
  return {
    title,
    seed,
    since,
    svalSince,
    arc: arc && { shape: arc.shape, palette: arc.palette },
  };
}

/**
 * @param {string} json
 * @returns {object|null}
 */
function parse(json) {
  try {
    return validCard(JSON.parse(json));
  } catch {
    return null;
  }
}

/** What `SvalSettingsSync` lets a synced card be. */
export const SYNC_RULES = Object.freeze({
  [CARD_PREF]: Object.freeze({
    accepts: value => typeof value === "string" && parse(value) !== null,
  }),
});

/** @returns {object|null} the user's card, or null before they have one. */
export function readCard() {
  return parse(Services.prefs.getStringPref(CARD_PREF, ""));
}

/** @param {object} card */
function writeCard(card) {
  Services.prefs.setStringPref(CARD_PREF, JSON.stringify(validCard(card)));
}

/**
 * @param {number} seed
 * @returns {string} the Sval title `seed` picks.
 */
export function titleFor(seed) {
  return `${ADJECTIVES[seed % ADJECTIVES.length]} ${
    NOUNS[Math.floor(seed / ADJECTIVES.length) % NOUNS.length]
  }`;
}

/**
 * The user's card, made when the profile has none: a Sval card whose first
 * day is the day this profile was made. Startup calls this before settings
 * sync starts, so another device's card, once synced, takes its place.
 *
 * @returns {Promise<object>}
 */
export async function ensureCard() {
  const card = readCard();
  if (card) {
    return card;
  }
  const age = await lazy.ProfileAge();
  const created = await age.created;
  const today = dayOf(new Date());
  const first = Number.isFinite(created) ? dayOf(new Date(created)) : today;
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const made = {
    title: titleFor(seed),
    seed,
    since: first < today ? first : today,
    svalSince: first < today ? first : today,
    arc: null,
  };
  // Another window may have made one while this one waited for the profile's
  // age, and the first card made is the one kept.
  const now = readCard();
  if (now) {
    return now;
  }
  writeCard(made);
  return made;
}

/**
 * @param {number[]} ints
 * @returns {number} the FNV-1a hash of `ints`, a 32-bit unsigned integer.
 */
function hashInts(ints) {
  let h = 0x811c9dc5;
  for (const n of ints) {
    h = Math.imul(h ^ (n & 0xff), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The card Arc gave its user, from Arc's `StorableMembershipCard.json` and
 * the account's `createdAt` in `StorableAuthState.json`, or null when either
 * is not what Arc writes.
 *
 * @param {*} membership The parsed membership card file.
 * @param {*} auth The parsed auth state file.
 * @returns {object|null} `{ title, seed, since, shape, palette }`.
 */
export function arcCardOf(membership, auth) {
  const shape = /^Shape([1-4])$/.exec(membership?.shapeName ?? "");
  const palette = membership?.paletteNumber;
  const blob = membership?.backgroundBlobInfo;
  const title =
    typeof membership?.title === "string"
      ? membership.title.trim().replace(/\s+/g, " ").toUpperCase()
      : "";
  const created = auth?.session?.user?.createdAt;
  if (
    !shape ||
    !Number.isInteger(palette) ||
    palette < 1 ||
    palette > 8 ||
    !Array.isArray(blob) ||
    !blob.every(Number.isInteger) ||
    !TITLE.test(title) ||
    !Number.isFinite(created)
  ) {
    return null;
  }
  const joined = new Date(ARC_EPOCH_MS + created * 1000);
  if (joined > new Date()) {
    return null;
  }
  return {
    title,
    seed: hashInts(blob),
    since: dayOf(joined),
    shape: +shape[1],
    palette,
  };
}

/**
 * Makes the user's card the Arc card they brought: Arc's title and art and
 * its first day. The day they came to Sval is kept from the card they had,
 * so importing again changes nothing.
 *
 * @param {object} arc One of {@link arcCardOf}'s.
 * @param {Date} [now]
 * @returns {object} the card.
 */
export function takeArcCard(arc, now = new Date()) {
  const today = dayOf(now);
  const had = readCard();
  const svalSince = had?.arc ? had.svalSince : today;
  const card = {
    title: arc.title,
    seed: arc.seed,
    since: arc.since < svalSince ? arc.since : svalSince,
    svalSince,
    arc: { shape: arc.shape, palette: arc.palette },
  };
  writeCard(card);
  return card;
}

/**
 * The card's years: one per anniversary of its first day up to `now`, then
 * the next one, still to come.
 *
 * @param {object} card
 * @param {Date} [now]
 * @returns {{year: number, arc: boolean, next: boolean}[]}
 */
export function cardYears(card, now = new Date()) {
  const start = parseDay(card.since);
  const svalStart = parseDay(card.svalSince);
  const years = [];
  for (let k = 1; ; k++) {
    const day = new Date(
      start.getFullYear() + k,
      start.getMonth(),
      start.getDate()
    );
    if (day > now) {
      years.push({ year: day.getFullYear(), arc: false, next: true });
      return years;
    }
    years.push({
      year: day.getFullYear(),
      arc: !!card.arc && day < svalStart,
      next: false,
    });
  }
}
