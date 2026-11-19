/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { ERRORS, ToolError } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs"
);
const { codeOf, image, json, refusal, refusalOf, text, toMcp, withFields } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentResult.sys.mjs"
  );

const bodyOf = mcp => JSON.parse(mcp.content[0].text);

/** An agent's model acts on a code, so a code nobody listed is a fault. */
add_task(function an_error_takes_only_a_listed_code() {
  Assert.throws(
    () => new ToolError("page_chnaged", "The page changed."),
    /no agent error code "page_chnaged"/
  );
  const own = new ToolError("policy_denied", "Not that site.", { tab: "t1" });
  Assert.equal(own.code, "policy_denied");
  Assert.equal(own.message, "Not that site.");
  Assert.deepEqual(own.details, { tab: "t1" });
});

add_task(function a_code_with_one_sentence_says_it_unasked() {
  Assert.equal(new ToolError("no_document").message, ERRORS.no_document);
  Assert.equal(
    new ToolError("user_in_control").message,
    ERRORS.user_in_control
  );
});

add_task(function every_code_is_snake_case() {
  for (const [code, sentence] of Object.entries(ERRORS)) {
    Assert.ok(/^[a-z]+(_[a-z]+)*$/.test(code), code);
    Assert.ok(sentence === null || sentence.endsWith("."), code);
  }
});

add_task(function a_result_that_worked_is_json_text() {
  const mcp = toMcp(json({ tab: "t1", found: true }));
  Assert.deepEqual(bodyOf(mcp), { tab: "t1", found: true });
  Assert.ok(!("isError" in mcp));
  Assert.deepEqual(toMcp(text("Done.")), {
    content: [{ type: "text", text: "Done." }],
  });
  Assert.deepEqual(toMcp(image("AAAA")), {
    content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
  });
});

/** A reader that shows only the message still sees the code. */
add_task(function a_failure_names_its_code_twice() {
  const failed = refusal("policy_denied", "Not that site.", { tab: "t1" });
  Assert.equal(codeOf(failed), "policy_denied");
  const mcp = toMcp(failed);
  Assert.strictEqual(mcp.isError, true);
  Assert.deepEqual(bodyOf(mcp), {
    tab: "t1",
    error: "policy_denied",
    message: "policy_denied: Not that site.",
  });
  Assert.equal(
    bodyOf(toMcp(refusal("no_dialog"))).message,
    `no_dialog: ${ERRORS.no_dialog}`
  );
  Assert.equal(codeOf(json({ error: "not a failure" })), undefined);
});

add_task(function an_error_becomes_its_result() {
  const err = new ToolError("rate_limited", "Wait.", { retry_after_ms: 40 });
  Assert.deepEqual(refusalOf(err, { tab: "t1" }).body, {
    tab: "t1",
    retry_after_ms: 40,
    error: "rate_limited",
    message: "rate_limited: Wait.",
  });
});

add_task(function fields_join_a_body_and_nothing_else() {
  Assert.deepEqual(withFields(json({ tab: "t1" }), { throttled_ms: 5 }).body, {
    tab: "t1",
    throttled_ms: 5,
  });
  const failed = withFields(refusal("no_dialog"), { throttled_ms: 5 });
  Assert.ok(failed.failed, "a failure stays one");
  Assert.equal(failed.body.throttled_ms, 5);
  const shot = image("AAAA");
  Assert.equal(withFields(shot, { throttled_ms: 5 }), shot);
});
