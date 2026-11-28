/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A look for a pairing code (`SvalPairingLook`), as the settings page and
 * first run run one: a look the user stopped may still have a claim in
 * flight when the next look starts, and that claim's answer is about a look
 * the user ended. It must not reach the page, or a right code would be told
 * it "didn't work", or a key would be joined twice.
 *
 * Each claim here is one the test answers when it chooses, as a folder that
 * answers late does.
 */

const { SvalPairingLook } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPairing.sys.mjs"
);
const { waitForCondition } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

/**
 * Claims that each wait for the test to answer them.
 *
 * @returns {{claim: Function, held: object[]}} `claim` is a look's claim;
 *   `held` lists each claim made, with `answer(result)` to settle it.
 */
function heldClaims() {
  const held = [];
  return {
    held,
    claim() {
      const { promise, resolve } = Promise.withResolvers();
      held.push({ answer: resolve });
      return promise;
    },
  };
}

add_task(async function a_stopped_looks_late_answer_reaches_nobody() {
  const look = new SvalPairingLook();
  const heard = [];
  const wrong = heldClaims();
  look.start(wrong.claim, answer => heard.push(["wrong", answer.status]));
  Assert.equal(wrong.held.length, 1, "the mistyped code was put to the offer");
  look.stop();

  const right = heldClaims();
  look.start(right.claim, answer => heard.push(["right", answer.status]));
  await Promise.resolve();
  Assert.equal(
    right.held.length,
    0,
    "the corrected look waits for the claim still in flight"
  );

  wrong.held[0].answer({ status: "no-match" });
  await waitForCondition(
    () => right.held.length === 1,
    "the corrected code is put to the offer once that claim is in"
  );
  Assert.deepEqual(heard, [], "the stopped look's answer reached nobody");
  Assert.ok(look.looking, "and the corrected look is still looking");

  right.held[0].answer({ status: "claimed", keyBytes: new Uint8Array(32) });
  await waitForCondition(() => heard.length, "the look's answer");
  Assert.deepEqual(heard, [["right", "claimed"]], "only its own answer");
  Assert.ok(!look.looking, "and the look has ended");
});

add_task(async function a_code_looked_for_again_is_claimed_once() {
  const look = new SvalPairingLook();
  const heard = [];
  const claims = heldClaims();
  const listen = answer => heard.push(answer.status);
  look.start(claims.claim, listen);
  look.stop();
  look.start(claims.claim, listen);
  // The stopped look's claim opens the offer too.
  claims.held[0].answer({ status: "claimed", keyBytes: new Uint8Array(32) });
  await waitForCondition(
    () => claims.held.length === 2,
    "the new look put the code to the offer"
  );
  claims.held[1].answer({ status: "claimed", keyBytes: new Uint8Array(32) });
  await waitForCondition(() => heard.length, "the look's answer");
  Assert.deepEqual(heard, ["claimed"], "one claimed answer, so one join");
});

/**
 * A folder that does not answer is counted claim by claim, so the page can
 * tell a blip from an outage, and an answer starts the count again.
 */
add_task(async function a_folder_that_does_not_answer_is_counted() {
  const look = new SvalPairingLook({ pollMs: 0 });
  const heard = [];
  const claims = heldClaims();
  look.start(claims.claim, answer => heard.push(answer));
  const answerNext = async (index, result) => {
    await waitForCondition(
      () => claims.held.length > index,
      `claim ${index} is made`
    );
    claims.held[index].answer(result);
    await waitForCondition(() => heard.length > index, `answer ${index}`);
  };
  await answerNext(0, { status: "waiting", problem: "offline" });
  await answerNext(1, { status: "waiting", problem: "offline" });
  await answerNext(2, { status: "waiting" });
  look.stop();
  Assert.deepEqual(
    heard.map(({ problem, failures }) => [problem, failures]),
    [
      ["offline", 1],
      ["offline", 2],
      [null, 0],
    ],
    "two in a row, then the folder answered"
  );
});
