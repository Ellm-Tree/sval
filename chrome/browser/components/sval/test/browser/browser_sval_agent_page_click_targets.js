/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_page_helpers.js */

/**
 * Where the page actor's click lands (agent-control spec §5.5): on the
 * element a ref names, never on a cover, a frame or a file picker.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_page_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

add_task(async function a_click_reaches_a_checkbox_its_label_draws() {
  const { page, browser } = await openPage();
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const label = doc.createElement("label");
    label.style.cssText =
      "position:relative;display:inline-block;padding:20px;background:white";
    label.innerHTML =
      "<input type=checkbox id=fancy style='position:absolute;left:0;top:0;" +
      "width:100%;height:100%;margin:0;z-index:-1'>Fancy";
    const pass = doc.createElement("div");
    pass.style.cssText =
      "position:fixed;inset:0;z-index:10;pointer-events:none";
    doc.body.prepend(label);
    doc.body.append(pass);
  });
  const { text } = await page.snapshot();
  const fancy = text.match(/checkbox "Fancy" \[(e\d+)\]/)[1];
  Assert.equal(
    await SpecialPowers.spawn(browser, [], () => {
      const box = content.document.getElementById("fancy");
      const r = box.getBoundingClientRect();
      const hit = content.document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2
      );
      return hit.localName;
    }),
    "label",
    "the label is what is drawn over the checkbox"
  );
  await page.click({ ref: fancy });
  Assert.ok(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.getElementById("fancy").checked
    ),
    "the click went through the label to the checkbox, and through a cover " +
      "with pointer-events: none"
  );
});

/**
 * Adds `html` to the page, takes a snapshot, then runs `cover` in the page to
 * lay something over it. Returns the page and the ref `pattern` matched.
 *
 * @param {string} html
 * @param {RegExp} pattern
 * @param {Function} cover Runs in the page, after the snapshot.
 * @returns {Promise<object>}
 */
async function coveredPage(html, pattern, cover) {
  const { page, browser } = await openPage();
  await SpecialPowers.spawn(browser, [html], markup => {
    const holder = content.document.createElement("div");
    // Parsed as the HTML parser would, so declarative shadow roots attach.
    holder.setHTMLUnsafe(markup);
    content.document.body.prepend(holder);
    content.document.body.dataset.clicks = "";
    content.addEventListener(
      "click",
      e => {
        content.document.body.dataset.clicks += `${e.target.localName}#${e.target.id} `;
      },
      true
    );
  });
  const { text } = await page.snapshot();
  const ref = text.match(pattern)[1];
  await SpecialPowers.spawn(
    browser,
    [cover.toString(), ROOT.replace("example.com", "example.org")],
    (source, other) => {
      // eslint-disable-next-line no-eval
      content.eval(`(${source})`)(content.document, other);
    }
  );
  const clicks = () =>
    SpecialPowers.spawn(browser, [], () =>
      content.document.body.dataset.clicks.trim()
    );
  return { page, browser, ref, clicks };
}

add_task(async function a_label_cannot_carry_a_click_somewhere_else() {
  const cases = [
    [
      "a frame inside a label for a button",
      "<button id=target>Target</button>",
      /button "Target" \[(e\d+)\]/,
      (doc, other) => {
        const label = doc.createElement("label");
        label.htmlFor = "target";
        label.style.cssText = "position:fixed;inset:0;z-index:10";
        const frame = doc.createElement("iframe");
        frame.src = other + "sval_agent_page2.html";
        frame.style.cssText =
          "width:100%;height:100%;border:0;opacity:0;display:block";
        label.append(frame);
        doc.body.append(label);
      },
    ],
    [
      "a link inside a label for a checkbox",
      "<input type=checkbox id=target aria-label=Target>",
      /checkbox "Target" \[(e\d+)\]/,
      doc => {
        const label = doc.createElement("label");
        label.htmlFor = "target";
        label.style.cssText = "position:fixed;inset:0;z-index:10";
        const link = doc.createElement("a");
        link.id = "away";
        link.href = "#away";
        link.style.cssText = "display:block;width:100%;height:100%";
        label.append(link);
        doc.body.append(label);
      },
    ],
    [
      "a label for a different control",
      "<input type=checkbox id=target aria-label=Target><input type=checkbox id=other aria-label=Other>",
      /checkbox "Target" \[(e\d+)\]/,
      doc => {
        const label = doc.createElement("label");
        label.htmlFor = "other";
        label.style.cssText = "position:fixed;inset:0;z-index:10";
        doc.body.append(label);
      },
    ],
    [
      "a frame inside the target itself",
      "<button id=target style='position:relative'>Target<iframe id=inner style='position:absolute;inset:0;width:100%;height:100%;border:0;opacity:0'></iframe></button>",
      /button "Target" \[(e\d+)\]/,
      (doc, other) => {
        doc.getElementById("inner").src = other + "sval_agent_page2.html";
      },
    ],
    [
      "a shadow host holding a frame, inside a label for a checkbox",
      "<input type=checkbox id=target aria-label=Target>",
      /checkbox "Target" \[(e\d+)\]/,
      (doc, other) => {
        const label = doc.createElement("label");
        label.htmlFor = "target";
        label.style.cssText = "position:fixed;inset:0;z-index:10";
        const host = doc.createElement("div");
        host.style.cssText = "width:100%;height:100%";
        host.attachShadow({ mode: "closed" }).innerHTML =
          `<iframe src="${other}sval_agent_page2.html" ` +
          "style='width:100%;height:100%;border:0;opacity:0;display:block'></iframe>";
        label.append(host);
        doc.body.append(label);
      },
    ],
    [
      "a link a component draws around slotted text, inside a label for a checkbox",
      "<input type=checkbox id=target aria-label=Target>",
      /checkbox "Target" \[(e\d+)\]/,
      doc => {
        const label = doc.createElement("label");
        label.htmlFor = "target";
        label.style.cssText = "position:fixed;inset:0;z-index:10";
        const host = doc.createElement("div");
        host.style.cssText = "display:block;width:100%;height:100%";
        host.attachShadow({ mode: "closed" }).innerHTML =
          "<a id=away href='#away' style='display:block;width:100%;height:100%'>" +
          "<slot></slot></a>";
        const text = doc.createElement("span");
        text.style.cssText = "display:block;width:100%;height:100%";
        text.textContent = "I agree";
        host.append(text);
        label.append(host);
        doc.body.append(label);
      },
    ],
  ];
  for (const [what, html, pattern, cover] of cases) {
    const { page, ref, clicks } = await coveredPage(html, pattern, cover);
    await Assert.rejects(
      page.click({ ref }),
      e => e.code === "click_intercepted",
      `${what} is refused`
    );
    Assert.equal(await clicks(), "", `${what}: the page heard no click`);
  }
});

add_task(async function a_cover_raised_on_mousedown_takes_no_click() {
  const { page, browser, ref, clicks } = await coveredPage(
    "<button id=target>Target</button><button id=later>Later</button>",
    /button "Target" \[(e\d+)\]/,
    doc => {
      doc.getElementById("target").addEventListener(
        "mousedown",
        () => {
          const cover = doc.createElement("div");
          cover.id = "cover";
          cover.style.cssText = "position:fixed;inset:0;z-index:10";
          doc.body.append(cover);
        },
        { once: true }
      );
    }
  );
  await SpecialPowers.spawn(browser, [], () => {
    content.document.body.dataset.releases = "";
    content.addEventListener(
      "mouseup",
      e => {
        content.document.body.dataset.releases += `${e.target.id ?? ""}:${e.buttons} `;
      },
      true
    );
  });
  await Assert.rejects(
    page.click({ ref }),
    e =>
      e.code === "click_intercepted" &&
      e.message ===
        "Sval pressed the element, but something moved over it before release. Sval released elsewhere. Take a new snapshot before acting again.",
    "a cover raised between press and release is refused, and the message " +
      "does not promise that no click was made"
  );
  Assert.equal(await clicks(), "", "nothing heard a click");
  Assert.equal(
    await SpecialPowers.spawn(browser, [], () =>
      content.document.body.dataset.releases.trim()
    ),
    ":0",
    "the button was released, off the cover, with no button left down"
  );
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("cover").remove()
  );
  const { text } = await page.snapshot();
  await page.click({ ref: text.match(/button "Later" \[(e\d+)\]/)[1] });
  Assert.equal(
    await clicks(),
    "button#later",
    "the mouse was released, so the next click is an ordinary one"
  );
});

add_task(async function a_link_that_wraps_is_clicked_on_its_first_line() {
  const { page, browser } = await openPage();
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const box = doc.createElement("div");
    box.style.cssText = "width:24ch;font:16px monospace";
    box.innerHTML =
      "xxxxxxxxxxxxxxx <a id=wrapped href='#wrapped'>wraps over lines</a>";
    doc.body.prepend(box);
  });
  const { text } = await page.snapshot();
  Assert.greater(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.getElementById("wrapped").getClientRects().length
    ),
    1,
    "the link is on more than one line"
  );
  await page.click({
    ref: text.match(/link "wraps over lines" \[(e\d+)\]/)[1],
  });
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(browser, [], () => content.location.hash).then(
        hash => hash === "#wrapped"
      ),
    "the link was followed"
  );
});

add_task(async function an_option_in_a_list_box_can_be_clicked() {
  const { page, browser } = await openPage();
  await SpecialPowers.spawn(browser, [], () => {
    const list = content.document.createElement("select");
    list.id = "list";
    list.size = 4;
    list.setAttribute("aria-label", "List");
    list.innerHTML =
      "<option>One</option><option>Two</option><option>Three</option>";
    content.document.body.prepend(list);
  });
  const { text } = await page.snapshot();
  await page.click({ ref: text.match(/option "Two" \[(e\d+)\]/)[1] });
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.getElementById("list").value
    ),
    "Two"
  );
});

add_task(async function a_cover_outside_a_shadow_tree_still_covers_it() {
  const cases = [
    [
      "a cross-origin frame in the light DOM",
      (doc, other) => {
        const frame = doc.createElement("iframe");
        frame.id = "cover";
        frame.src = other + "sval_agent_page2.html";
        frame.style.cssText =
          "position:fixed;inset:0;width:100%;height:100%;border:0;" +
          "opacity:0;z-index:10";
        doc.body.append(frame);
      },
    ],
    [
      "a cover inside a sibling component's shadow tree",
      doc => {
        const sibling = doc.createElement("div");
        sibling.id = "cover";
        sibling.attachShadow({ mode: "closed" }).innerHTML =
          "<div style='position:fixed;inset:0;z-index:10'></div>";
        doc.body.append(sibling);
      },
    ],
  ];
  for (const [what, cover] of cases) {
    const { page, browser, ref, clicks } = await coveredPage(
      "<div id=host><template shadowrootmode=closed>" +
        "<button>Inside</button></template></div>",
      /button "Inside" \[(e\d+)\]/,
      cover
    );
    await Assert.rejects(
      page.click({ ref }),
      e => e.code === "click_intercepted",
      `${what} is refused`
    );
    Assert.equal(await clicks(), "", `${what}: the button heard no click`);
    await SpecialPowers.spawn(browser, [], () =>
      content.document.getElementById("cover").remove()
    );
    await page.click({ ref });
    Assert.equal(
      await clicks(),
      "div#host",
      `${what}: with the cover gone, the button in the closed shadow tree ` +
        "is clicked"
    );
  }
});

add_task(async function a_frame_is_never_clicked_into() {
  const { page, ref, clicks } = await coveredPage(
    "<iframe id=target role=button aria-label=Submit " +
      "style='width:200px;height:60px;border:0'></iframe>",
    /button "Submit" \[(e\d+)\]/,
    (doc, other) => {
      doc.getElementById("target").src = other + "sval_agent_page2.html";
    }
  );
  await Assert.rejects(
    page.click({ ref }),
    e => e.code === "not_clickable",
    "a frame given a button's role is refused"
  );
  Assert.equal(await clicks(), "", "the page heard no click");
});

/**
 * A file input's picker is a dialog the agent cannot see (spec §4.4), so
 * files reach a page only through `upload_file`. A click or an activating
 * key on a file input, or on a label that opens one, is refused, and no
 * picker opens.
 */
add_task(async function a_file_input_never_opens_its_picker() {
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  let shown = 0;
  MockFilePicker.showCallback = () => {
    shown++;
  };
  MockFilePicker.returnValue = MockFilePicker.returnCancel;
  registerCleanupFunction(() => MockFilePicker.cleanup());

  const { page, browser } = await openPage();
  await SpecialPowers.spawn(browser, [], () => {
    const holder = content.document.createElement("div");
    holder.innerHTML =
      "<input type=file id=up aria-label=Attach>" +
      "<input type=file id=hidden style='position:absolute;opacity:0;width:1px'>" +
      "<label for=hidden role=button>Upload</label>" +
      "<label><span role=button>Choose</span>" +
      "<input type=file style='position:absolute;opacity:0;width:1px'></label>" +
      "<label><button>Inside</button>" +
      "<input type=file style='position:absolute;opacity:0;width:1px'></label>";
    content.document.body.prepend(holder);
  });
  const { text } = await page.snapshot();
  const refOf = pattern => text.match(pattern)[1];
  for (const [what, pattern] of [
    ["the file input", /button "Attach" \[(e\d+)\]/],
    ["a label for it", /button "Upload" \[(e\d+)\]/],
    ["an element in a label around it", /button "Choose" \[(e\d+)\]/],
  ]) {
    await Assert.rejects(
      page.click({ ref: refOf(pattern) }),
      e => e.code === "not_clickable" && e.message.includes("upload_file"),
      `a click on ${what} is refused, pointing at upload_file`
    );
  }
  // A button inside the label is its own control, and its click does not
  // reach the label's.
  await page.click({ ref: refOf(/button "Inside" \[(e\d+)\]/) });

  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("up").focus()
  );
  for (const key of ["Enter", "Space", " "]) {
    await Assert.rejects(
      page.press({ keys: ["a", key] }),
      e => e.code === "not_clickable",
      `${key} on a focused file input is refused`
    );
  }
  await page.press({ keys: ["Tab"] });
  Assert.ok(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.activeElement?.id !== "up"
    ),
    "Tab still moves focus on"
  );
  // Each refusal came before any event was sent, so nothing in the page
  // could have asked for a picker since.
  Assert.equal(shown, 0, "no file picker opened");
});
