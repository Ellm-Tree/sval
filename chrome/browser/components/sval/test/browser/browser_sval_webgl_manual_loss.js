/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A WebGL context the application loses on purpose logs nothing: about:support
 * and the feedback form free the contexts their GPU probe makes with
 * `WEBGL_lose_context.loseContext()`. A web page that loses its own context is
 * still warned.
 *
 * Linux CI's image carries Mesa's software GL, so on Linux a missing context
 * is a broken environment and fails. Elsewhere the tasks are skipped, and the
 * harness logs the skip, when the chrome document gets no context: a runner VM
 * may have no GL driver (`FEATURE_FAILURE_CGL_FBO` on macOS).
 */

const LOST = "WebGL context was lost.";

const CONTEXT_EXPECTED = AppConstants.platform == "linux";

/** The document Troubleshoot's graphics probe draws in. */
function chromeCanvas() {
  return new DOMParser()
    .parseFromString("<html/>", "text/html")
    .createElement("canvas");
}

const HAS_CONTEXT = !!chromeCanvas().getContext("webgl");
const skip_if = () => !CONTEXT_EXPECTED && !HAS_CONTEXT;

/**
 * The context-loss warnings the console receives while `act` runs.
 *
 * @param {Function} act
 * @returns {Promise<string[]>}
 */
async function lossWarningsWhile(act) {
  const seen = [];
  const listener = {
    observe(message) {
      if (
        message instanceof Ci.nsIScriptError &&
        message.errorMessage.includes(LOST)
      ) {
        seen.push(message.errorMessage);
      }
    },
  };
  Services.console.registerListener(listener);
  try {
    await act();
  } finally {
    Services.console.unregisterListener(listener);
  }
  return seen;
}

add_task(
  { skip_if },
  async function a_chrome_context_lost_on_purpose_is_silent() {
    const seen = await lossWarningsWhile(async () => {
      const canvas = chromeCanvas();
      const gl = canvas.getContext("webgl");
      ok(gl, "the chrome document has a WebGL context");
      gl.getExtension("WEBGL_lose_context").loseContext();
      // The event is dispatched on a later turn (ClientWebGLContext::OnContextLoss).
      const lost = BrowserTestUtils.waitForEvent(canvas, "webglcontextlost");
      await within(lost, 10_000, "the chrome context's loss");
      ok(gl.isContextLost(), "the chrome context is lost");
    });
    Assert.deepEqual(seen, [], "the chrome context's loss logged no warning");
  }
);

/**
 * Evaluated in the page's own global, so the page is the caller of
 * `loseContext()`; a spawned task runs with the system principal.
 */
async function pageLosesItsContext() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl");
  if (!gl) {
    return false;
  }
  const event = new Promise(resolve =>
    canvas.addEventListener("webglcontextlost", resolve, { once: true })
  );
  gl.getExtension("WEBGL_lose_context").loseContext();
  await event;
  return gl.isContextLost();
}

add_task({ skip_if }, async function a_web_page_losing_its_context_is_warned() {
  const seen = await lossWarningsWhile(async () => {
    await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
      const lost = await within(
        SpecialPowers.spawn(browser, [pageLosesItsContext.toString()], src =>
          content.wrappedJSObject.eval(`(${src})()`)
        ),
        10_000,
        "the page's context loss"
      );
      ok(lost, "the page's context is lost");
      // The warning is reported from the page's process; a second round
      // trip delivers what it logged before.
      await SpecialPowers.spawn(browser, [], () => {});
    });
  });
  Assert.equal(seen.length, 1, "the page's loss is warned once");
});
