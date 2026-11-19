/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The tools that put input into a page: a click, typing, a key, a scroll,
 * files, the answer to a dialog (agent-control spec §4). Each is a row of
 * `SvalAgentToolTable`.
 *
 * Every one runs its input through the write gate (`ToolCall.act`), which
 * judges what the page sends because of it, and answers what became of
 * those writes. Be polite spaces them out per site.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import { noDialog } from "moz-src:///browser/components/sval/SvalAgentPageDialogs.sys.mjs";
import {
  pageActor,
  pageDeadline,
} from "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs";
import { hostOfDocument } from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";
import { refuseIfUserHolds } from "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs";
import {
  ASKING,
  DIALOG_OPENED,
  ON_PAGE,
  PAGE,
} from "moz-src:///browser/components/sval/SvalAgentToolCall.sys.mjs";
import { settled } from "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs";
import {
  ACTS,
  input,
  MOVES,
  REF,
  TAB,
  WRITES,
} from "moz-src:///browser/components/sval/SvalAgentToolSchema.sys.mjs";
import {
  checkedFiles,
  readCheckedFiles,
} from "moz-src:///browser/components/sval/SvalAgentUploads.sys.mjs";

const MAX_TEXT = 10_000;
const MAX_PATH = 4096;
const MAX_UPLOAD_FILES = 20;

export const clickElement = {
  name: "click_element",
  title: "Click",
  description: `Click an element by ref, and wait for any page it loads. ${WRITES}`,
  inputSchema: input({ tab: TAB, ref: REF }, ["tab", "ref"]),
  annotations: ACTS,
  page: PAGE,
  actsOn: ON_PAGE,
  activity: "Clicking",
  run: (call, { ref }) =>
    call.input(page => page.click({ ref }), { settle: true }),
};

export const typeText = {
  name: "type_text",
  title: "Type",
  description: `Type into a field by ref, replacing what it holds unless clear is false. It doesn't submit: press Enter or click the form's button. ${WRITES}`,
  inputSchema: input(
    {
      tab: TAB,
      ref: REF,
      text: { type: "string", maxLength: MAX_TEXT },
      clear: {
        type: "boolean",
        description: "false types after what the field holds; default true.",
      },
    },
    ["tab", "ref", "text"]
  ),
  annotations: ACTS,
  page: PAGE,
  actsOn: ON_PAGE,
  activity: "Typing",
  run: (call, { ref, text, clear = true }) =>
    call.input(page => page.type({ ref, text, clear }), {
      says: done => ({ value: done.value }),
    }),
};

export const fillForm = {
  name: "fill_form",
  title: "Fill a form",
  description: `Type into several fields in order, replacing what each holds. It doesn't submit: press Enter or click the form's button. ${WRITES}`,
  inputSchema: input(
    {
      tab: TAB,
      fields: {
        type: "array",
        maxItems: 50,
        items: input(
          { ref: REF, text: { type: "string", maxLength: MAX_TEXT } },
          ["ref", "text"]
        ),
      },
    },
    ["tab", "fields"]
  ),
  annotations: ACTS,
  page: PAGE,
  actsOn: ON_PAGE,
  activity: "Filling in a form",
  async run(call, { tab, fields }) {
    const { browser } = call;
    const page = pageActor(browser);
    let filled = 0;
    const { done, failed } = await call.act(
      async () => {
        // One deadline for every field, so the form takes no longer than
        // any other input.
        const until = pageDeadline();
        for (const { ref, text } of fields) {
          // The user can take the tab while the field before is typed,
          // and a tab taken then gets no more input.
          refuseIfUserHolds(browser);
          const answer = await call.answered(
            page.type({ ref, text, clear: true, until })
          );
          if (answer === DIALOG_OPENED) {
            return answer;
          }
          filled++;
        }
        return {};
      },
      err => ({
        ...(err instanceof ToolError && {
          message: `fields[${filled}] failed: ${err.message} The ${filled} fields before it were filled.`,
        }),
        tab,
        filled,
      })
    );
    if (failed) {
      return failed;
    }
    return call.reply({ tab, filled, writes: done.writes });
  },
};

export const selectOption = {
  name: "select_option",
  title: "Choose an option",
  description: `Choose options in a select element by ref, by value or visible label. ${WRITES}`,
  inputSchema: input(
    {
      tab: TAB,
      ref: REF,
      values: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 1000 },
      },
    },
    ["tab", "ref", "values"]
  ),
  annotations: ACTS,
  page: PAGE,
  actsOn: ON_PAGE,
  activity: "Choosing an option",
  run: (call, { ref, values }) =>
    call.input(page => page.select({ ref, values })),
};

export const pressKeys = {
  name: "press_keys",
  title: "Press keys",
  description: `Press keys in the focused element: single characters, or Enter, Tab, Escape, Backspace, Delete, the arrow keys, Home, End, PageUp, PageDown and Space. No modifiers. ${WRITES}`,
  inputSchema: input(
    {
      tab: TAB,
      keys: {
        type: "array",
        maxItems: 50,
        items: { type: "string", maxLength: 16 },
      },
    },
    ["tab", "keys"]
  ),
  annotations: ACTS,
  page: PAGE,
  actsOn: ON_PAGE,
  activity: "Pressing keys",
  run: (call, { keys }) =>
    call.input(page => page.press({ keys }), { settle: true }),
};

export const scrollPage = {
  name: "scroll_page",
  title: "Scroll",
  description:
    "Scroll an element into view by ref, or scroll up, down, left or right by amount steps.",
  inputSchema: input(
    {
      tab: TAB,
      ref: REF,
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "integer", minimum: 1, maximum: 10 },
    },
    ["tab"]
  ),
  annotations: MOVES,
  page: PAGE,
  actsOn: ON_PAGE,
  activity: "Scrolling",
  check({ ref, direction, amount }) {
    if ((ref === undefined) === (direction === undefined)) {
      throw new ToolError(
        "invalid_arguments",
        "Give either ref or direction, not both."
      );
    }
    if (ref !== undefined && amount !== undefined) {
      throw new ToolError(
        "invalid_arguments",
        "amount goes with direction, not with ref."
      );
    }
  },
  // A page can send on scroll, as an infinite list loading more does.
  run: (call, { ref, direction, amount }) =>
    call.input(page => page.scroll({ ref, direction, amount })),
};

export const answerDialog = {
  name: "answer_dialog",
  title: "Answer a dialog",
  description: `Answer the confirm or prompt open in a tab: accept true for OK, false for Cancel. text fills a prompt. ${WRITES}`,
  inputSchema: input(
    {
      tab: TAB,
      accept: { type: "boolean" },
      text: { type: "string", maxLength: MAX_TEXT },
    },
    ["tab", "accept"]
  ),
  annotations: ACTS,
  page: ASKING,
  actsOn: ON_PAGE,
  activity: "Answering the page",
  async run(call, { tab, accept, text }) {
    // A refused agent can still close the tab, and the user can answer the
    // dialog in the agent's window.
    const { browser } = call;
    const open = call.dialogs.openDialog(browser);
    if (!open) {
      throw noDialog();
    }
    // The answer resumes the script of the frame that asked, so the
    // frame's site must be one the agent may act on now too: a frame from
    // a site that is Blocked, or that the user has not yet decided on, is
    // the user's to answer, and so is one whose site Sval could not work
    // out (undefined), since unknown is never allowed. A blank frame
    // nothing wrote into has no site (null). The top page's site was
    // checked as the call entered the tab (`ASKING`).
    const [, frameSite] = open.sites;
    if (frameSite === undefined) {
      throw new ToolError(
        "policy_denied",
        "Sval cannot tell which site asked this, so the dialog is the user's to answer."
      );
    }
    try {
      call.sites.checkSite(call.agent, frameSite);
    } catch (err) {
      if (err?.code !== "policy_denied") {
        throw err;
      }
      throw new ToolError(
        "policy_denied",
        `${err.message} The dialog came from a frame of that site, so it is the user's to answer.`
      );
    }
    // An input like a click: accepting a "Delete?" is what sends the
    // delete, so the answer runs inside an action window.
    const { done, failed } = await call.act(
      async () => {
        call.dialogs.answer(browser, { accept, text });
        return {};
      },
      undefined,
      // A site's tool may be the one waiting on the dialog.
      { answersDialog: true }
    );
    if (failed) {
      return failed;
    }
    const { writes } = done;
    if (writes !== "awaiting_approval" && !call.dialogs.openDialog(browser)) {
      await settled(browser);
    }
    return call.reply({ tab, ...call.shown(), writes });
  },
};

export const uploadFile = {
  name: "upload_file",
  title: "Upload files",
  description: `Give a file input, by ref, files from the user's computer by absolute path, as if the user picked them. Sval asks the user first, unless they always allow uploads to that site from those folders. ${WRITES}`,
  inputSchema: input(
    {
      tab: TAB,
      ref: REF,
      paths: {
        type: "array",
        maxItems: MAX_UPLOAD_FILES,
        items: { type: "string", maxLength: MAX_PATH },
      },
    },
    ["tab", "ref", "paths"]
  ),
  annotations: ACTS,
  page: PAGE,
  actsOn: ON_PAGE,
  activity: "Uploading a file",
  async run(call, { tab, ref, paths }) {
    const { browser } = call;
    const checked = await checkedFiles(paths, call.maxUploadBytes);
    const page = pageActor(browser);
    // Checked before the user is asked, so a wrong ref never raises an
    // alert.
    await page.fileInput({ ref, count: checked.length });
    const allowedFor = await call.sites.allowUpload(
      call.agent,
      browser,
      checked.map(c => c.file.path),
      call.task
    );
    // The user can take a while, and the page can change meanwhile: a
    // dialog it opened, or another page (`stillThere`). A site blocked
    // since is refused by `act`.
    call.refuseIfDialogOpen();
    const files = await readCheckedFiles(checked, call.maxUploadBytes);
    // The files go to the site the user was asked about, or nowhere: a tab
    // that moved on, even to a page the agent may read, gets nothing.
    const stillThere = () => {
      if (
        typeof allowedFor !== "string" ||
        hostOfDocument(browser.browsingContext?.currentWindowGlobal) !==
          allowedFor
      ) {
        throw new ToolError(
          "page_changed",
          "The tab moved to another page while the user decided. Nothing was uploaded. Take a new snapshot."
        );
      }
      if (call.sites.uploadAllowed(call.agent, allowedFor) !== true) {
        throw new ToolError(
          "policy_denied",
          `The user has not allowed this agent to upload files to ${allowedFor}.`
        );
      }
    };
    // Before the input too, so a page that moved on while the user decided
    // is refused as such, with no input made and no writes to report.
    stillThere();
    const now = pageActor(browser);
    // A page may send the files on `change`, as an input sends a form.
    const { done, failed } = await call.act(() => {
      stillThere();
      return call.answered(
        now.upload({
          ref,
          files: files.map(
            f =>
              new File([f.bytes], f.name, {
                type: f.type,
                lastModified: f.lastModified,
              })
          ),
        })
      );
    });
    if (failed) {
      return failed;
    }
    return call.reply({
      tab,
      files: files.map(f => f.name),
      writes: done.writes,
    });
  },
};
