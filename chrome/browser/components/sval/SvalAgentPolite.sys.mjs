/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * "Be polite": a rate limit on the actions an agent takes on a site.
 *
 * Sval does not hide that an agent is at work, and agents are told not to fake
 * human timing, so the limit adds no noise. It spaces an agent's actions on
 * one site, across all its tabs, at least one interval apart, and tells the
 * agent how long it waited (`throttled_ms`) so it paces itself.
 *
 * Whether an agent is held to the limit is the user's alone: the card on the
 * agent's overlay carries the checkbox (`SvalAgentMarking`), which is the only
 * caller of `setPolite`, and no tool reaches this module's setter. Each agent
 * starts ticked, and an unticked agent stays so, in every window that shows
 * its workspace, until Sval quits or the user unpairs it. The record is kept
 * by the paired agent's id (`SvalAgentStore`), which an agent cannot choose and
 * a later pairing never reuses, so another agent that takes the same name
 * starts ticked. It is not written to disk: a courtesy the user waived once
 * is not a standing permission.
 *
 * The rate, in actions per second, is the user's setting (`POLITE_RATE_PREF`).
 */

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

/** Actions an agent may take per second on one site, from Settings. */
export const POLITE_RATE_PREF = "browser.sval.agents.politeRate";

/** The rate when the setting holds nothing usable. */
export const DEFAULT_RATE = 1;

/** Notified, with the agent's id as data, when its tick changes. */
export const POLITE_TOPIC = "sval-agent-polite-changed";

/** The ids of the agents whose user unticked Be polite. */
const waived = new Set();

/**
 * @param {string} agentId A paired agent's id.
 * @returns {boolean} Whether the agent is held to the limit.
 */
export function isPolite(agentId) {
  return !waived.has(agentId);
}

/**
 * @param {string} agentId A paired agent's id.
 * @param {boolean} polite
 */
export function setPolite(agentId, polite) {
  if (polite === isPolite(agentId)) {
    return;
  }
  if (polite) {
    waived.delete(agentId);
  } else {
    waived.add(agentId);
  }
  Services.obs.notifyObservers(null, POLITE_TOPIC, agentId);
}

/**
 * Drops what the user decided for an agent that is unpaired, so nothing of
 * it outlives the pairing.
 *
 * @param {string} agentId
 */
export function forgetPolite(agentId) {
  setPolite(agentId, true);
}

/**
 * @returns {number} The rate the user set, in actions per second: a whole
 *   number, at least one.
 */
export function politeRate() {
  const rate = Services.prefs.getIntPref(POLITE_RATE_PREF, DEFAULT_RATE);
  return rate >= 1 ? rate : DEFAULT_RATE;
}

/**
 * How many actions may wait their turn on one site. One more beyond that is
 * refused (`RateLimited`): an agent with a backlog learns at once that it is
 * going faster than the user allows, and when it may try again.
 */
export const MAX_QUEUED = 4;

/** An action refused because its site already has `MAX_QUEUED` waiting. */
export class RateLimited extends Error {
  /** @param {number} retryAfterMs When a place in the queue frees up. */
  constructor(retryAfterMs) {
    super("too many actions are waiting on this site");
    this.name = "RateLimited";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The rules Be polite holds an agent to, as the agent is told them
 * (`list_tabs`, and its tools' descriptions).
 *
 * @param {string} agentId
 * @returns {{on: boolean, actions_per_second: number, interval_ms: number,
 *   max_queued: number}}
 */
export function politeRules(agentId) {
  const rate = politeRate();
  return {
    on: isPolite(agentId),
    actions_per_second: rate,
    interval_ms: Math.round(1000 / rate),
    max_queued: MAX_QUEUED,
  };
}

/**
 * A limiter that spaces actions on each site. Each action claims the next
 * free slot on its site at once, so actions that arrive together queue in
 * order and none is let through early. At most `MAX_QUEUED` wait on a site;
 * one more is refused with `RateLimited`.
 *
 * @param {object} [clock]
 * @param {() => number} [clock.now] Milliseconds, monotonic.
 * @param {(ms: number) => Promise<void>} [clock.sleep]
 * @returns {{wait: (site: string, rate: number, onQueued?: () => void) =>
 *   Promise<number>}}
 */
export function createLimiter({
  now = () => ChromeUtils.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  /** When each site's next action may go, by site. */
  const free = new Map();
  /** When each action waiting on a site goes, earliest first, by site. */
  const waiting = new Map();
  return {
    /**
     * Waits until an action on `site` may go. The slot is claimed before
     * this returns, so the order of calls is the order actions go in.
     *
     * @param {string} site
     * @param {number} rate Actions per second.
     * @param {() => void} [onQueued] Told, before this returns, when the
     *   action has to wait its turn.
     * @returns {Promise<number>} Whole milliseconds waited; 0 when none.
     *   Rejects with `RateLimited` when the site's queue is full.
     */
    wait(site, rate, onQueued = () => {}) {
      const t = now();
      // A site whose next slot has passed is as free as one never acted on.
      for (const [other, at] of free) {
        if (at <= t) {
          free.delete(other);
        }
      }
      const start = Math.max(t, free.get(site) ?? 0);
      if (start <= t) {
        free.set(site, t + 1000 / rate);
        return Promise.resolve(0);
      }
      const queue = waiting.get(site) ?? [];
      // An entry leaves the queue when its sleep ends, which can be later
      // than its start: one whose start has passed is going, so it holds no
      // place, and the earliest start still ahead is when a place frees up.
      const ahead = queue.filter(at => at > t);
      if (ahead.length >= MAX_QUEUED) {
        return Promise.reject(new RateLimited(Math.ceil(ahead[0] - t)));
      }
      free.set(site, start + 1000 / rate);
      queue.push(start);
      waiting.set(site, queue);
      onQueued();
      return (async () => {
        try {
          await sleep(start - t);
        } finally {
          queue.splice(queue.indexOf(start), 1);
          if (!queue.length && waiting.get(site) === queue) {
            waiting.delete(site);
          }
        }
        return Math.round(start - t);
      })();
    },
  };
}
