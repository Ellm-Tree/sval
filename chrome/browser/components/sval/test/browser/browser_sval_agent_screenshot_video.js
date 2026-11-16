/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What an agent's screenshot draws of a video: its frames, unless it holds
 * MediaKeys, whose decrypted frames Gecko keeps out of a page's canvas.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/** Where the manifest installs Gecko's media test files. */
const MEDIA = "https://example.com/browser/dom/media/test/browser/";

/** Gecko's EME test helper, loaded as chrome code, as its own tests do. */
const EME_HELPER =
  "chrome://mochitests/content/browser/dom/media/test/browser/eme_standalone.js";

/**
 * Gecko's ClearKey test file, and the id and value it is encrypted with,
 * public in Gecko's own media tests.
 */
const EME_VIDEO = "sintel-short-clearkey-subsample-encrypted-video.webm";
const EME_DECRYPT = [
  "2cdb0ed6119853e7850671c3e9906c3c",
  "808b9adac384de1e4f56140f4ad76194",
];

/** @returns {Promise<object>} A paired agent that may read example.com. */
function tools() {
  return agentSetup({ sites: { "example.com": "full" } });
}

/**
 * Adds a video at the top left of the document `context` shows, plays the
 * ClearKey file through MediaKeys when `encrypted` and Gecko's clear test
 * file otherwise, and waits until it shows the frame half a second in.
 *
 * @param {object} context A browsing context.
 * @param {boolean} encrypted
 * @returns {Promise<number[]>} The video's rect: left, top, width, height.
 */
function addVideo(context, encrypted) {
  return within(
    SpecialPowers.spawn(
      context,
      [encrypted, MEDIA, EME_HELPER, EME_VIDEO, EME_DECRYPT],
      async (protect, root, emeHelper, file, [keyId, key]) => {
        const once = (target, name) =>
          new Promise(resolve =>
            target.addEventListener(name, resolve, { once: true })
          );
        const video = content.document.createElement("video");
        video.style = "position:fixed;top:0;left:0;width:320px;height:136px";
        content.document.body.append(video);
        if (protect) {
          Services.scriptloader.loadSubScript(emeHelper, content);
          const helper = new content.wrappedJSObject.EmeHelper();
          helper.SetKeySystem(
            content.wrappedJSObject.EmeHelper.GetClearkeyKeySystemString()
          );
          helper.SetInitDataTypes(Cu.cloneInto(["webm"], content));
          helper.SetVideoCapabilities(
            Cu.cloneInto([{ contentType: 'video/webm; codecs="vp9"' }], content)
          );
          helper.AddKeyIdAndKey(keyId, key);
          await helper.ConfigureEme(video);
          const source = new content.MediaSource();
          video.src = content.URL.createObjectURL(source);
          await once(source, "sourceopen");
          const buffer = source.addSourceBuffer("video/webm");
          const response = await content.fetch(root + file);
          buffer.appendBuffer(await response.arrayBuffer());
          await once(buffer, "updateend");
          source.endOfStream();
        } else {
          video.src = root + "gizmo.webm";
        }
        await once(video, "loadeddata");
        const seeked = once(video, "seeked");
        video.currentTime = 0.5;
        await seeked;
        Assert.equal(!!video.mediaKeys, protect, "the video's MediaKeys");
        const r = video.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      }
    ),
    20_000,
    "the video's frame"
  );
}

/**
 * @param {object} result A `get_screenshot` result.
 * @param {number[]} rect Left, top, width and height; two pixels in from
 *   each edge are read.
 * @returns {Promise<number>} How many pixels read are not black.
 */
async function litPixels(result, [left, top, width, height]) {
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
  const { data } = ctx.getImageData(left + 2, top + 2, width - 4, height - 4);
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] + data[i + 1] + data[i + 2] > 0) {
      lit++;
    }
  }
  return lit;
}

/**
 * A video without MediaKeys is drawn. The black in the other tests means
 * something only because this one finds the frame.
 */
add_task(async function a_screenshot_draws_a_clear_video() {
  const { call, raw, tabs, agent } = await tools();
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  const rect = await addVideo(browser.browsingContext, false);
  const image = await raw("get_screenshot", { tab });
  Assert.greater(await litPixels(image, rect), 0, "the frame shows");
});

/** A video holding MediaKeys is black. */
add_task(async function a_screenshot_covers_a_protected_video() {
  const { call, raw, tabs, agent } = await tools();
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  const rect = await addVideo(browser.browsingContext, true);
  const image = await raw("get_screenshot", { tab });
  Assert.equal(await litPixels(image, rect), 0, "the video is black");
});

/**
 * A protected video in a frame of the page's own site, which the page's
 * process draws, is black too.
 */
add_task(async function a_screenshot_covers_a_protected_video_in_a_frame() {
  const { call, raw, tabs, agent } = await tools();
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await SpecialPowers.spawn(browser, [PAGE2], async src => {
    const frame = content.document.createElement("iframe");
    frame.src = src;
    frame.style =
      "position:fixed;top:0;left:0;width:200px;height:200px;border:0";
    const loaded = new Promise(resolve =>
      frame.addEventListener("load", resolve, { once: true })
    );
    content.document.body.append(frame);
    await loaded;
  });
  const [left, top, , height] = await addVideo(
    browser.browsingContext.children[0],
    true
  );
  const image = await raw("get_screenshot", { tab });
  Assert.equal(
    await litPixels(image, [left, top, 200, Math.min(height, 200)]),
    0,
    "the video is black"
  );
});
