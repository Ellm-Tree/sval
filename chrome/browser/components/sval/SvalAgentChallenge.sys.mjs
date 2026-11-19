/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Human-verification checks in an agent's tab: a CAPTCHA, a "verify you are
 * human" page, a challenge a site puts in front of a visitor it suspects is
 * a bot (agent-control spec §6). An agent never attempts one. While a check
 * shows in a tab, the tools refuse every input and read on that tab with
 * `human_verification_required` (`SvalAgentToolCall`), the overlay's card tells
 * the user (`SvalAgentMarking`), and the user takes control, completes it and
 * gives the tab back.
 *
 * Detection is passive. Sval fetches nothing from any vendor, and nothing here
 * runs in the page's own script:
 *
 * - The parent sees the response headers of every top-level document load
 *   in an agent's tab (`SvalAgentGate`'s stop-request observer hands them to
 *   `recordResponse`). Cloudflare marks every challenge page with
 *   `cf-mitigated: challenge`; AWS WAF marks a CAPTCHA with
 *   `x-amzn-waf-action: captcha`, and its silent `challenge` action is left
 *   alone.
 * - The page actor reports the page's markers of a challenge interstitial
 *   and the visible frames it embeds (`SvalAgentPageChild`'s `challenge`),
 *   which `classify` matches against the vendors' frame origins
 *   (`ORIGINS_PREF`). A frame counts only when a person could see and use
 *   it: at least `MIN_FRAME_PX` square, in the viewport, and not hidden. So
 *   a vendor's invisible modes, reCAPTCHA v3, invisible hCaptcha, a
 *   zero-size Turnstile, never count.
 *
 * An interstitial counts at once. An embedded widget counts only if it is
 * still showing `WIDGET_GRACE_MS` after Sval first saw it, since a managed
 * widget often clears itself within a second or two; and not once the page
 * holds the widget's answer (`markers.responded`), since a solved widget
 * stays on the page showing its tick.
 *
 * What is found is kept per tab, by `browserId`, for the document it was
 * found in, so a later page in the tab carries none of it. `list_tabs` reads
 * it, and the overlay draws from it (`CHALLENGE_TOPIC`). When the user gives
 * a flagged tab back, the page is checked again at once, without the grace.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  CONTROL_TOPIC,
  isUserInControl,
} from "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs";
import { pageActor } from "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs";
import { onTabGone } from "moz-src:///browser/components/sval/SvalAgentTabLife.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

/** Notified with the `browserId` as data when a tab's check comes or goes. */
export const CHALLENGE_TOPIC = "sval-agent-challenge-changed";

/**
 * The frame origins of the vendors' interactive widgets, as
 * `vendor=origin` entries separated by commas or white space. An origin's
 * host may start with `*.`, which matches any subdomain. Tests point it at a
 * local host, so no test ever loads a vendor's frame (hard rule 11).
 */
export const ORIGINS_PREF = "browser.sval.agents.challengeOrigins";

/**
 * The vendors' documented widget origins:
 * - Cloudflare Turnstile, `challenges.cloudflare.com` (Turnstile CSP
 *   reference);
 * - DataDome, `*.captcha-delivery.com`, whose frame loads only after a
 *   request was blocked;
 * - reCAPTCHA v2, on `www.google.com`, `recaptcha.google.com` and
 *   `www.recaptcha.net`, counted only for its anchor and challenge frames
 *   (`RECAPTCHA_FRAME`);
 * - hCaptcha, `*.hcaptcha.com`;
 * - Arkose Labs, `*.arkoselabs.com`.
 */
export const DEFAULT_ORIGINS = [
  "cloudflare=https://challenges.cloudflare.com",
  "datadome=https://*.captcha-delivery.com",
  "recaptcha=https://www.google.com",
  "recaptcha=https://recaptcha.google.com",
  "recaptcha=https://www.recaptcha.net",
  "hcaptcha=https://*.hcaptcha.com",
  "arkose=https://*.arkoselabs.com",
].join(",");

/** How long an embedded widget must keep showing before it counts. */
export const WIDGET_GRACE_MS = 3000;

/** The smallest side, in CSS pixels, of a frame a person could use. */
export const MIN_FRAME_PX = 30;

/**
 * reCAPTCHA's checkbox and its picture challenge. The same origin serves
 * maps and every other Google frame, so only these paths are reCAPTCHA's.
 */
const RECAPTCHA_FRAME = /^\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/;

/**
 * Whether a frame from a vendor's origin is that vendor's visible widget, by
 * what its address says beyond the origin. A vendor with no rule here counts
 * for any frame from its origins.
 */
const FRAME_RULES = {
  recaptcha: url =>
    RECAPTCHA_FRAME.test(url.pathname) &&
    url.searchParams.get("size") !== "invisible",
  hcaptcha: url => !url.href.includes("invisible"),
};

/**
 * @param {string} text An `ORIGINS_PREF` value.
 * @returns {Array<{vendor: string, scheme: string, host: string, port: string, wildcard: boolean}>}
 *   Its entries; one that does not parse is skipped.
 */
export function parseOrigins(text) {
  const out = [];
  for (const entry of String(text ?? "").split(/[\s,]+/)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const vendor = entry.slice(0, eq);
    let origin = entry.slice(eq + 1);
    const wildcard = origin.includes("://*.");
    if (wildcard) {
      origin = origin.replace("://*.", "://");
    }
    try {
      const url = new URL(origin);
      out.push({
        vendor,
        scheme: url.protocol,
        host: url.hostname,
        port: url.port,
        wildcard,
      });
    } catch {}
  }
  return out;
}

/**
 * @returns {Array<object>}
 */
function currentOrigins() {
  return parseOrigins(
    Services.prefs.getStringPref(ORIGINS_PREF, DEFAULT_ORIGINS)
  );
}

/**
 * @param {URL} url
 * @param {object} origin One of `parseOrigins`'s entries.
 * @returns {boolean}
 */
function fromOrigin(url, origin) {
  if (url.protocol !== origin.scheme || url.port !== origin.port) {
    return false;
  }
  return origin.wildcard
    ? url.hostname.endsWith(`.${origin.host}`)
    : url.hostname === origin.host;
}

/**
 * Says whether what Sval saw of a page is a human-verification check.
 *
 * @param {object} seen
 * @param {{[name: string]: string}} [seen.headers] The top-level response's
 *   headers, by lower-case name.
 * @param {Array<{src: string, width: number, height: number, visible: boolean}>} [seen.frames]
 *   The page's frames as the page actor measured them.
 * @param {{cloudflare?: boolean, perimeterx?: boolean, responded?: boolean}} [seen.markers]
 *   The page's own markers: Cloudflare's challenge options object, HUMAN
 *   (PerimeterX)'s block page, and a widget's answer already in the page.
 * @param {string} [seen.page] The page's own address. A widget's frame
 *   loaded as the whole page is the widget all the same, which keeps an
 *   agent from opening one on its own to complete it.
 * @param {Array<object>} [origins] `parseOrigins`'s entries.
 * @returns {{kind: "interstitial"|"widget", vendor: string}|null}
 */
export function classify(
  { headers = {}, frames = [], markers = {}, page = "" },
  origins = currentOrigins()
) {
  if (headers["cf-mitigated"]?.trim().toLowerCase() === "challenge") {
    return { kind: "interstitial", vendor: "cloudflare" };
  }
  if (headers["x-amzn-waf-action"]?.trim().toLowerCase() === "captcha") {
    return { kind: "interstitial", vendor: "aws" };
  }
  if (markers.cloudflare) {
    return { kind: "interstitial", vendor: "cloudflare" };
  }
  if (markers.perimeterx) {
    return { kind: "interstitial", vendor: "perimeterx" };
  }
  const own = widgetVendor(page, origins);
  if (own) {
    return { kind: "interstitial", vendor: own };
  }
  if (markers.responded) {
    return null;
  }
  for (const frame of frames) {
    if (
      !frame?.visible ||
      !(frame.width >= MIN_FRAME_PX) ||
      !(frame.height >= MIN_FRAME_PX)
    ) {
      continue;
    }
    const vendor = widgetVendor(frame.src, origins);
    if (vendor) {
      return { kind: "widget", vendor };
    }
  }
  return null;
}

/**
 * @param {string} address
 * @param {Array<object>} origins `parseOrigins`'s entries.
 * @returns {string|null} The vendor whose widget `address` loads, or null.
 */
function widgetVendor(address, origins) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  for (const origin of origins) {
    if (!fromOrigin(url, origin)) {
      continue;
    }
    const rule = FRAME_RULES[origin.vendor];
    if (!rule || rule(url)) {
      return origin.vendor;
    }
  }
  return null;
}

const HEADERS = ["cf-mitigated", "x-amzn-waf-action"];

/**
 * The last top-level response in each agent tab whose headers marked a
 * check, by `browserId`: the address it was for, the headers, and the inner
 * window id of the document it became once a check binds it.
 *
 * @type {Map<number, {uri: string, headers: object, windowId: number|null}>}
 */
const responses = new Map();

/**
 * The check found in each tab, by `browserId`, for one document.
 *
 * @type {Map<number, {windowId: number, kind: string, vendor: string}>}
 */
const found = new Map();

/**
 * When Sval first saw a widget in each tab's document, by `browserId`.
 *
 * @type {Map<number, {windowId: number, at: number}>}
 */
const widgetSeen = new Map();

/**
 * Notes the headers of a top-level document response in an agent's tab.
 * Called by the gate for each such channel as it stops.
 *
 * @param {number} browserId
 * @param {nsIChannel} channel
 */
export function recordResponse(browserId, channel) {
  observeControl();
  const headers = {};
  try {
    const http = channel.QueryInterface(Ci.nsIHttpChannel);
    for (const name of HEADERS) {
      try {
        headers[name] = http.getResponseHeader(name);
      } catch {}
    }
  } catch {}
  if (!classify({ headers }, [])) {
    responses.delete(browserId);
    return;
  }
  responses.set(browserId, {
    uri: channel.URI.specIgnoringRef,
    headers,
    windowId: null,
  });
}

/**
 * The recorded headers that belong to the document `windowGlobal` is. A
 * record not yet bound to a document binds to the first one checked with
 * its address, which is the one its response became: a check runs after a
 * load has finished.
 *
 * @param {number} browserId
 * @param {WindowGlobalParent} windowGlobal
 * @returns {object}
 */
function headersFor(browserId, windowGlobal) {
  const record = responses.get(browserId);
  if (!record) {
    return {};
  }
  if (
    record.windowId === null &&
    windowGlobal.documentURI?.specIgnoringRef === record.uri
  ) {
    record.windowId = windowGlobal.innerWindowId;
  }
  return record.windowId === windowGlobal.innerWindowId ? record.headers : {};
}

/**
 * @param {number} browserId
 * @param {number|null} windowId
 * @param {{kind: string, vendor: string}|null} check
 */
function setFound(browserId, windowId, check) {
  const before = found.get(browserId);
  if (check) {
    found.set(browserId, { windowId, ...check });
  } else {
    found.delete(browserId);
  }
  const changed =
    !!before !== !!check ||
    (before &&
      (before.windowId !== windowId ||
        before.kind !== check.kind ||
        before.vendor !== check.vendor));
  if (!changed) {
    return;
  }
  if (check) {
    SvalLog.info(
      `a ${check.vendor} ${check.kind} check shows in tab content ${browserId}`
    );
  } else {
    SvalLog.info(`no check shows in tab content ${browserId}`);
  }
  Services.obs.notifyObservers(null, CHALLENGE_TOPIC, String(browserId));
}

/**
 * The check `browser`'s page shows now, if any, asked of the page. A widget
 * seen for the first time is asked about again once `WIDGET_GRACE_MS` has
 * passed, and counts only if it is still there; with `grace` false it counts
 * at once. A page the actor cannot reach, a privileged one or one going
 * away, is judged by its headers alone. A page that does not answer is not
 * judged, so a tool asking it fails at once rather than waiting on the page
 * a second time.
 *
 * @param {Element} browser A `<browser>`.
 * @param {object} [options]
 * @param {boolean} [options.grace]
 * @returns {Promise<{kind: string, vendor: string}|null>}
 * @throws {ToolError} `user_in_control` once the user holds the tab,
 *   `stopped_by_user` once they stop its agent, and `page_unresponsive`
 *   when the page does not answer.
 */
export async function detect(browser, { grace = true } = {}) {
  observeControl();
  let seen = { frames: [], markers: {} };
  try {
    seen = (await pageActor(browser).challenge()) ?? seen;
  } catch (err) {
    if (
      err?.code === "user_in_control" ||
      err?.code === "stopped_by_user" ||
      err?.code === "page_unresponsive"
    ) {
      throw err;
    }
  }
  const bc = browser.browsingContext;
  const browserId = bc?.browserId;
  const windowGlobal = bc?.currentWindowGlobal;
  if (!browserId || !windowGlobal) {
    return null;
  }
  const windowId = windowGlobal.innerWindowId;
  const check = classify({
    headers: headersFor(browserId, windowGlobal),
    frames: Array.isArray(seen.frames) ? seen.frames : [],
    markers: seen.markers ?? {},
    page: windowGlobal.documentURI?.spec ?? "",
  });
  if (check?.kind !== "widget") {
    widgetSeen.delete(browserId);
  } else if (grace && found.get(browserId)?.windowId !== windowId) {
    let first = widgetSeen.get(browserId);
    if (first?.windowId !== windowId) {
      first = { windowId, at: ChromeUtils.now() };
      widgetSeen.set(browserId, first);
    }
    const left = first.at + WIDGET_GRACE_MS - ChromeUtils.now();
    if (left > 0) {
      await new Promise(resolve => setTimeout(resolve, left));
      return detect(browser, { grace: false });
    }
  }
  setFound(browserId, windowId, check);
  return check;
}

/**
 * The check last found in `browser`'s tab, if the tab still shows the
 * document it was found in.
 *
 * @param {Element} browser
 * @returns {{kind: string, vendor: string}|null}
 */
export function foundIn(browser) {
  const bc = browser?.browsingContext;
  const record = bc && found.get(bc.browserId);
  if (!record || record.windowId !== bc.currentWindowGlobal?.innerWindowId) {
    return null;
  }
  return { kind: record.kind, vendor: record.vendor };
}

/**
 * @param {number} browserId
 * @returns {boolean} Whether a check was last found in that tab's content,
 *   for the document it shows now.
 */
export function hasCheck(browserId) {
  const record = found.get(browserId);
  if (!record) {
    return false;
  }
  const windowGlobal =
    BrowsingContext.getCurrentTopByBrowserId(browserId)?.currentWindowGlobal;
  return record.windowId === windowGlobal?.innerWindowId;
}

let observing = false;

/**
 * Checks a flagged tab again the moment the user gives it back, so the
 * agent's next call, `list_tabs` included, and the overlay see whether the
 * user completed it. Observed for the life of the process from the first
 * record or check on.
 */
function observeControl() {
  if (observing) {
    return;
  }
  observing = true;
  Services.obs.addObserver((_subject, _topic, data) => {
    const browserId = Number(data);
    if (!found.has(browserId) || isUserInControl(browserId)) {
      return;
    }
    widgetSeen.delete(browserId);
    const browser =
      BrowsingContext.getCurrentTopByBrowserId(browserId)?.embedderElement;
    if (!browser) {
      setFound(browserId, null, null);
      return;
    }
    detect(browser, { grace: false }).catch(err =>
      SvalLog.warn(
        `a tab given back was not checked again: ${SvalLog.errorName(err)}`
      )
    );
  }, CONTROL_TOPIC);
}

onTabGone(browserId => {
  responses.delete(browserId);
  found.delete(browserId);
  widgetSeen.delete(browserId);
});

export function resetForTests() {
  responses.clear();
  found.clear();
  widgetSeen.clear();
}
