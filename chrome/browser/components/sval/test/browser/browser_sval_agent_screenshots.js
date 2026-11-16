/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What an agent's screenshot draws (agent-control spec §4): the page and its
 * own frames, never a frame from a site the agent may not read.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/** A page of solid red, on example.com. */
const RED = ROOT + "sval_agent_red.html";

/** The same page on example.org, a site of its own, so in its own process. */
const RED_ORG = RED.replace("://example.com/", "://example.org/");

/** A page of solid red, as a `data:` address, which no agent may read. */
const RED_DATA =
  "data:text/html,<body style='margin:0;background:%23f00'></body>";

/**
 * A paired agent that may read every site but example.org, which is blocked.
 *
 * @returns {Promise<object>}
 */
function toolsBlockingOrg() {
  return agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
}

/**
 * Adds a 200 by 200 frame at `src` to the top left of `browser`'s page, and
 * waits for it to load.
 *
 * @param {object} browser
 * @param {string} src
 */
async function addFrame(browser, src) {
  await SpecialPowers.spawn(browser, [src], async frameSrc => {
    const frame = content.document.createElement("iframe");
    frame.id = "added";
    frame.src = frameSrc;
    frame.style =
      "position:fixed;top:0;left:0;width:200px;height:200px;border:0";
    const loaded = new Promise(resolve =>
      frame.addEventListener("load", resolve, { once: true })
    );
    content.document.body.append(frame);
    await loaded;
  });
}

/** @param {object} browser */
async function removeFrame(browser) {
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("added").remove()
  );
}

/**
 * @param {object} result A `get_screenshot` result.
 * @returns {Promise<number>} How many of its pixels are pure red.
 */
async function redPixels(result) {
  const img = new Image();
  img.src = "data:image/png;base64," + result.content[0].data;
  await img.decode();
  const canvas = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let red = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0) {
      red++;
    }
  }
  return red;
}

/**
 * A frame from the page's own site is drawn: it is the page's own content.
 * The red counts in the other screenshot tests mean something only because
 * this one finds red.
 */
add_task(async function a_screenshot_draws_a_frame_from_the_pages_site() {
  const { call, raw, tabs, agent } = await toolsBlockingOrg();
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await addFrame(browser, RED);
  const image = await raw("get_screenshot", { tab });
  Assert.greaterOrEqual(await redPixels(image), 200 * 200, "the frame shows");
});

/**
 * A screenshot is drawn in the page's own process, so a frame from another
 * site, which is in a process of its own, is blank in it whatever the page
 * does while it is drawn.
 */
add_task(async function a_screenshot_leaves_an_unreadable_frame_blank() {
  const { call, raw, tabs, agent } = await toolsBlockingOrg();
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await addFrame(browser, RED_ORG);
  const image = await raw("get_screenshot", { tab });
  Assert.equal(await redPixels(image), 0, "the frame is blank");
});

/**
 * A frame the agent may not read but which shares the page's process, such
 * as one at a `data:` address, would be drawn, so the page is refused.
 */
add_task(async function an_unreadable_frame_in_the_pages_process_is_refused() {
  const { call, reply, tabs, agent } = await toolsBlockingOrg();
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await addFrame(browser, RED_DATA);
  Assert.equal(
    (await reply("get_screenshot", { tab })).error,
    "frame_not_readable",
    "the page is refused"
  );
});
