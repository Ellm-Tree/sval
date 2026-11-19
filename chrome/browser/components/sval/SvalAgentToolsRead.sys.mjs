/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The tools that read what an agent's tabs show and send nothing to a page
 * (agent-control spec §4). Each is a row of `SvalAgentToolTable`.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import {
  image,
  json,
} from "moz-src:///browser/components/sval/SvalAgentResult.sys.mjs";
import {
  pageActor,
  screenshot,
} from "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs";
import { hostOfDocument } from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";
import { MAX_CONSOLE_MESSAGES } from "moz-src:///browser/components/sval/SvalAgentConsole.sys.mjs";
import {
  SOURCE_CHUNK_DEFAULT,
  SOURCE_CHUNK_MAX,
} from "moz-src:///browser/components/sval/SvalAgentSnapshot.sys.mjs";
import {
  PAGE,
  SEEN,
} from "moz-src:///browser/components/sval/SvalAgentToolCall.sys.mjs";
import {
  input,
  MAX_ID,
  READ_ONLY,
  REF,
  TAB,
} from "moz-src:///browser/components/sval/SvalAgentToolSchema.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

/** How many console messages one call answers unless it asks for fewer. */
const CONSOLE_LIMIT_DEFAULT = 100;
/**
 * The most characters of console messages, as JSON, one call answers: well
 * inside a reply frame (`MAX_FRAME_BYTES`) even when every character takes
 * three bytes.
 */
const CONSOLE_MAX_CHARS = 256 * 1024;
const DEFAULT_WAIT_MS = 10_000;
/** How long between tries when a wait for text finds the page changing. */
const RETRY_MS = 100;

/**
 * Refuses a screenshot that drew a frame the agent may not read.
 * `screenshot` leaves every frame in another process blank and gives this
 * the documents of the frames it drew, as they were when drawn.
 *
 * @param {object} call The `ToolCall`.
 * @param {Array<WindowGlobalParent|null>} frames
 */
function refuseUnreadableFrames(call, frames) {
  for (const windowGlobal of frames) {
    let site;
    try {
      site = hostOfDocument(windowGlobal);
    } catch {
      site = undefined;
    }
    if (!call.mayRead(site)) {
      throw new ToolError("frame_not_readable");
    }
  }
}

export const getSnapshot = {
  name: "get_snapshot",
  title: "Read a page",
  description:
    "Read a page as an outline, one element per line, with a ref like [e12] for each element you can act on. Pass ref or viewport_only to read less of a long page.",
  inputSchema: input(
    {
      tab: TAB,
      ref: {
        ...REF,
        description:
          "Read only this element and what is inside it, by its ref from an earlier get_snapshot.",
      },
      viewport_only: {
        type: "boolean",
        description:
          "List only what is in view now, at the page's current scroll position.",
      },
    },
    ["tab"]
  ),
  annotations: READ_ONLY,
  page: PAGE,
  activity: "Reading the page",
  async run(call, { tab, ref, viewport_only }) {
    const { browser } = call;
    const { text, truncated } = await pageActor(browser).snapshot({
      ref,
      viewportOnly: viewport_only,
    });
    return call.reply({
      tab,
      ...call.shown(),
      snapshot: text,
      truncated,
    });
  },
};

export const getScreenshot = {
  name: "get_screenshot",
  title: "Screenshot a page",
  description:
    "Take a PNG of the part of the page in view. Use scroll_page to see more.",
  inputSchema: input({ tab: TAB }, ["tab"]),
  annotations: READ_ONLY,
  page: SEEN,
  activity: "Looking at the page",
  async run(call) {
    const { browser } = call;
    const data = await screenshot(browser, {
      checkFrames: frames => refuseUnreadableFrames(call, frames),
    });
    return image(data);
  },
};

export const getPageSource = {
  name: "get_page_source",
  title: "Read page source",
  description: `Read the page's HTML, or one element's by ref, in chunks of ${SOURCE_CHUNK_DEFAULT} characters. Pass next_offset as offset for the next chunk. Passwords come back blank.`,
  inputSchema: input(
    {
      tab: TAB,
      ref: REF,
      offset: {
        type: "integer",
        minimum: 0,
        description: "Where to start reading: a next_offset from before.",
      },
      max_chars: {
        type: "integer",
        minimum: 1,
        maximum: SOURCE_CHUNK_MAX,
        description: "The most characters to return in this chunk.",
      },
    },
    ["tab"]
  ),
  annotations: READ_ONLY,
  page: PAGE,
  activity: "Reading the page",
  async run(call, { tab, ref, offset = 0, max_chars }) {
    const { browser } = call;
    const source = await pageActor(browser).source({
      ref,
      offset,
      chunk: max_chars,
    });
    return call.reply({
      tab,
      html: source.html,
      offset: source.offset,
      next_offset: source.nextOffset,
      total: source.total,
    });
  },
};

export const getPageText = {
  name: "get_page_text",
  title: "Read page text",
  description: `Read the text the page shows, or one element's by ref, in chunks of ${SOURCE_CHUNK_DEFAULT} characters. Pass next_offset as offset for the next chunk.`,
  inputSchema: input(
    {
      tab: TAB,
      ref: REF,
      offset: {
        type: "integer",
        minimum: 0,
        description: "Where to start reading: a next_offset from before.",
      },
      max_chars: {
        type: "integer",
        minimum: 1,
        maximum: SOURCE_CHUNK_MAX,
        description: "The most characters to return in this chunk.",
      },
    },
    ["tab"]
  ),
  annotations: READ_ONLY,
  page: PAGE,
  activity: "Reading the page",
  async run(call, { tab, ref, offset = 0, max_chars }) {
    const { browser } = call;
    const page = await pageActor(browser).text({
      ref,
      offset,
      chunk: max_chars,
    });
    return call.reply({
      tab,
      text: page.text,
      offset: page.offset,
      next_offset: page.nextOffset,
      total: page.total,
    });
  },
};

export const waitForText = {
  name: "wait_for_text",
  title: "Wait for text",
  description:
    "Wait until the page shows this exact, case-sensitive text, for up to timeout_ms (default 10000). Returns found: false if it never appears.",
  inputSchema: input(
    {
      tab: TAB,
      text: { type: "string", maxLength: 500 },
      timeout_ms: { type: "integer", minimum: 1, maximum: 30_000 },
    },
    ["tab", "text"]
  ),
  annotations: READ_ONLY,
  page: null,
  activity: "Waiting for the page",
  async run(call, { tab, text, timeout_ms = DEFAULT_WAIT_MS }) {
    const deadline = Date.now() + timeout_ms;
    for (;;) {
      // Asked again on every try: the tab may have loaded a page agents
      // may not read since the last one. A tab between pages has no
      // document to check yet, which is waited out like a page change.
      const { browser } = await call.find(tab);
      call.refuseIfDialogOpen();
      const left = deadline - Date.now();
      try {
        call.checkPage();
        await call.refuseIfChallenge();
        const answer = await call.answered(
          pageActor(browser).waitForText({
            text,
            timeoutMs: Math.max(left, 0),
          })
        );
        // A dialog that opens meanwhile stops the page, and the wait with it.
        call.refuseIfDialogOpen();
        return call.reply({ tab, found: answer.found });
      } catch (err) {
        // The page changed under the wait, as it does on a form submit.
        // The wait goes on in the new page for the time that is left.
        if (
          !(err instanceof ToolError) ||
          (err.code !== "page_changed" && err.code !== "no_document")
        ) {
          throw err;
        }
      }
      const rest = deadline - Date.now();
      if (rest <= 0) {
        return call.reply({ tab, found: false });
      }
      await new Promise(resolve =>
        setTimeout(resolve, Math.min(RETRY_MS, rest))
      );
    }
  },
};

export const getConsoleMessages = {
  name: "get_console_messages",
  title: "Read the console",
  description:
    "Read what the page wrote to its console, oldest first, with uncaught errors. Pass back cursor to get only newer messages. Sval asks the user the first time you read a site's console.",
  inputSchema: input(
    {
      tab: TAB,
      cursor: {
        type: "string",
        maxLength: MAX_ID,
        description: "The cursor from your last get_console_messages call.",
      },
      max_messages: {
        type: "integer",
        minimum: 1,
        maximum: MAX_CONSOLE_MESSAGES,
        description: "The most messages to return.",
      },
    },
    ["tab"]
  ),
  annotations: READ_ONLY,
  page: PAGE,
  activity: "Reading the console",
  async run(
    call,
    { tab, cursor, max_messages: limit = CONSOLE_LIMIT_DEFAULT }
  ) {
    const { browser } = call;
    const windowGlobal = browser.browsingContext?.currentWindowGlobal;
    const site = hostOfDocument(windowGlobal);
    const page = windowGlobal.innerWindowId;
    if (site === null) {
      // A blank page, or Sval's own about:agentblocked: nothing of a
      // site's to ask about.
      return call.reply({
        tab,
        ...call.shown(),
        messages: [],
        cursor: `${page}:0`,
        more: false,
      });
    }
    await call.sites.allowConsole(call.agent, site, call.task);
    // The user can take a while, and the tab can move on meanwhile: the
    // messages are read from the page the answer was about, or not at all.
    call.refuseIfDialogOpen();
    const now = browser.browsingContext?.currentWindowGlobal;
    if (now !== windowGlobal) {
      throw new ToolError(
        "page_changed",
        "The tab moved to another page while the user decided. Call get_console_messages again."
      );
    }
    call.checkPage();
    // A cursor names its page, so one from an earlier page reads this
    // page from its first message.
    const [cursorPage, cursorSeq] = String(cursor ?? "").split(":");
    const from =
      Number(cursorPage) === page && Number.isSafeInteger(Number(cursorSeq))
        ? Math.max(Number(cursorSeq), 0)
        : 0;
    const read = await pageActor(browser).consoleMessages({
      after: from,
      limit,
    });
    if (
      browser.browsingContext?.currentWindowGlobal !== windowGlobal ||
      !call.sites.consoleAllowed(call.agent, site)
    ) {
      throw new ToolError(
        "console_denied",
        `The user has not allowed this agent to read ${site}'s console.`
      );
    }
    const messages = [];
    let size = 0;
    let last = from;
    for (const { seq, ...message } of read.messages) {
      size += JSON.stringify(message).length;
      if (messages.length && size > CONSOLE_MAX_CHARS) {
        break;
      }
      messages.push(message);
      last = seq;
    }
    if (!read.messages.length) {
      last = read.last;
    }
    return call.reply({
      tab,
      ...call.shown(),
      messages,
      cursor: `${page}:${last}`,
      more: read.more || messages.length < read.messages.length,
      ...(read.dropped ? { dropped: read.dropped } : {}),
    });
  },
};

export const listDownloads = {
  name: "list_downloads",
  title: "List downloads",
  description:
    "List the downloads your tabs started, oldest first, with file_name, path, state and bytes. A download is saved to the user's download folder and never opened.",
  inputSchema: input({}, []),
  annotations: READ_ONLY,
  page: null,
  async run(call) {
    return json({ downloads: call.sites.listDownloads(call.agent) });
  },
};
