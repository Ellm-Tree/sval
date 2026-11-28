/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's export page (export spec §3), opened by `SvalExport.askExport`.
 *
 * The page offers the targets, the workspaces (all ticked), Favorites and,
 * for Safari alone, History: no other browser imports history from a file.
 * Export hands the choices to `window.arguments[0].save`, which asks where
 * and writes the file; the page then shows that target's notice and a
 * Done button.
 */

/* import-globals-from import-picker.js */

"use strict";

const { SvalLog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLog.sys.mjs"
);

const SvalExportPage = {
  start() {
    const args = window.arguments[0];
    const doc = document;
    const $ = selector => doc.querySelector(selector);
    const HTML_NS = "http://www.w3.org/1999/xhtml";
    const make = (tag, props = {}, ...children) => {
      const el = doc.createElementNS(HTML_NS, tag);
      Object.assign(el, props);
      el.append(...children);
      return el;
    };
    // A workspace's icon (`SvalWorkspaceEntries.workspaceIcon`).
    const icon = workspace => {
      if (workspace.mark) {
        const mark = make("span", { className: "sval-im-mark" });
        mark.style.setProperty("--sval-im-mark", `url("${workspace.mark}")`);
        return mark;
      }
      return workspace.emoji
        ? make("span", { className: "sval-im-emoji" }, workspace.emoji)
        : "";
    };
    const state = { target: args.target };
    const exportButton = $(".sval-ex-export");
    const cancelButton = $(".sval-ex-cancel");

    const targetOf = key => args.targets.find(t => t.key === key);
    const sync = () => {
      const target = targetOf(state.target);
      const complete = target.format === "complete";
      $(".sval-ex-choices").hidden = complete;
      $(".sval-ex-complete").hidden = !complete;
      $(".sval-ex-history-row").hidden = target.format !== "safari";
      for (const li of doc.querySelectorAll(".sval-ex-target")) {
        li.toggleAttribute("data-ticked", li.dataset.key === state.target);
      }
      exportButton.disabled = !complete && !chosen().any;
    };
    const chosen = () => {
      const workspaces = [...doc.querySelectorAll(".sval-ex-workspace")]
        .filter(box => box.checked)
        .map(box => box.value);
      const favorites = $(".sval-ex-favorites").checked;
      const history =
        targetOf(state.target).format === "safari" &&
        $(".sval-ex-history").checked;
      return {
        workspaces,
        favorites,
        history,
        any: !!(workspaces.length || favorites || history),
      };
    };

    const targets = $(".sval-ex-targets");
    for (const target of args.targets) {
      const radio = make("input", {
        type: "radio",
        name: "target",
        value: target.key,
        className: "sval-ex-radio",
        checked: target.key === state.target,
      });
      radio.addEventListener("change", () => {
        state.target = target.key;
        sync();
      });
      const logo =
        target.key === "sval"
          ? make("img", {
              className: "sval-im-logo",
              src: "chrome://browser/content/sval/sval-glyph.svg",
              alt: "",
            })
          : SvalImportPicker.logo(doc, target.key, "sval-im-logo");
      const li = make(
        "li",
        { className: "sval-im-source sval-ex-target" },
        make(
          "label",
          { className: "sval-im-source-head sval-im-source-label" },
          radio,
          logo,
          make("span", { className: "sval-im-source-name" }, target.name)
        )
      );
      li.dataset.key = target.key;
      targets.append(li);
    }

    const list = $(".sval-ex-workspaces");
    for (const workspace of args.workspaces) {
      const box = make("input", {
        type: "checkbox",
        className: "sval-ex-workspace",
        value: workspace.id,
        checked: true,
      });
      box.addEventListener("change", sync);
      list.append(
        make(
          "li",
          { className: "sval-im-window" },
          make(
            "label",
            { className: "sval-im-check" },
            box,
            icon(workspace),
            workspace.name
          )
        )
      );
    }
    for (const box of doc.querySelectorAll(
      ".sval-ex-favorites, .sval-ex-history"
    )) {
      box.addEventListener("change", sync);
    }

    $(".sval-ex").addEventListener("submit", async event => {
      event.preventDefault();
      if (exportButton.dataset.done) {
        window.close();
        return;
      }
      const { workspaces, favorites, history } = chosen();
      exportButton.disabled = true;
      let notice = null;
      let failed = false;
      try {
        notice = await args.save({
          target: state.target,
          workspaces,
          favorites,
          history,
        });
      } catch (err) {
        SvalLog.error(
          `export: the file was not saved: ${SvalLog.errorName(err)}`
        );
        failed = true;
      }
      exportButton.disabled = false;
      if (!notice && !failed) {
        return;
      }
      const box = $(".sval-ex-notice");
      box.replaceChildren(
        ...(failed
          ? [make("p", {}, "Couldn't save the file. Try another place.")]
          : [
              make("p", { className: "sval-ex-saved" }, "Saved."),
              ...notice.map(line => make("p", {}, line)),
            ])
      );
      box.hidden = false;
      if (!failed) {
        $(".sval-ex-body").hidden = true;
        cancelButton.hidden = true;
        exportButton.textContent = "Done";
        exportButton.dataset.done = "true";
      }
    });
    cancelButton.addEventListener("click", () => window.close());
    sync();
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => SvalExportPage.start(), {
    once: true,
  });
} else {
  SvalExportPage.start();
}
