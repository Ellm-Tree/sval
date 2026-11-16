/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalFirstRunModel: M } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirstRunModel.sys.mjs"
);
const S = M.STEPS;
/** An import plan whose one browser brings a window. */
const WINDOWS = [{ windows: [{ import: true }] }];
/** One whose browser brings bookmarks alone. */
const BOOKMARKS = [{ windows: [{ import: false }] }];

const FACTS = {
  importAvailable: false,
  isDefaultBrowser: false,
};

function walk(answers, facts = FACTS) {
  const seen = [S.intro];
  let step = S.intro;
  while (step !== S.done) {
    step = M.next(step, answers, facts);
    seen.push(step);
    Assert.less(seen.length, 20, "the flow ends");
  }
  return seen;
}

/**
 * Every path the model can take, each with the facts that make it. Each is
 * walked with the answers as they stand at the end.
 */
function paths() {
  const fresh = M.defaults();
  const joining = { ...fresh, path: "join" };
  const browsers = { ...FACTS, importAvailable: true };
  return [
    ["new, no other browser", fresh, FACTS],
    ["new, importing", { ...fresh, importPlan: WINDOWS }, browsers],
    ["new, importing nothing", { ...fresh, importPlan: [] }, browsers],
    ["new, bookmarks alone", { ...fresh, importPlan: BOOKMARKS }, browsers],
    ["new, already the default", fresh, { ...FACTS, isDefaultBrowser: true }],
    ["join", joining, FACTS],
    ["join, key found", joining, { ...FACTS, keyRecovered: true }],
    ["join, backup", { ...joining, joinWith: "backup" }, FACTS],
  ];
}

add_task(function the_defaults_are_the_specs() {
  Assert.deepEqual(M.defaults(), {
    path: "new",
    joinWith: "code",
    folder: null,
    search: "ddg",
    adblock: "balanced",
    passwordManager: null,
    agents: "off",
    panelSide: "left",
    defaultBrowser: true,
    workspace: null,
  });
});

/**
 * A new user with no other browser names a Workspace, then answers the rest.
 * No step chooses where Sval saves (2026-11-09 spec §2.1).
 */
add_task(function a_new_user_names_a_workspace_without_import() {
  Assert.deepEqual(walk(M.defaults()), [
    S.intro,
    S.question,
    S.workspace,
    S.search,
    S.privacy,
    S.passwordManager,
    S.more,
    S.welcome,
    S.done,
  ]);
});

add_task(function import_comes_before_the_workspace() {
  const facts = { ...FACTS, importAvailable: true };
  Assert.deepEqual(
    walk(M.defaults(), facts).slice(0, 4),
    [S.intro, S.question, S.import, S.search],
    "a pending import is taken to bring windows, so no Workspace step"
  );
  Assert.deepEqual(
    walk({ ...M.defaults(), importPlan: WINDOWS }, facts).slice(0, 4),
    [S.intro, S.question, S.import, S.search],
    "an import that brings a window fills the Workspace"
  );
  Assert.deepEqual(
    walk({ ...M.defaults(), importPlan: BOOKMARKS }, facts).slice(0, 5),
    [S.intro, S.question, S.import, S.workspace, S.search],
    "bookmarks alone fill no Workspace, so the user names one"
  );
  Assert.deepEqual(
    walk({ ...M.defaults(), importPlan: [] }, facts).slice(0, 5),
    [S.intro, S.question, S.import, S.workspace, S.search],
    "importing nothing names one"
  );
});

add_task(function a_few_more_things_is_one_step_whatever_the_default() {
  for (const isDefaultBrowser of [true, false]) {
    const steps = walk(M.defaults(), { ...FACTS, isDefaultBrowser });
    Assert.equal(steps.at(-3), S.more, "the last step answered");
    Assert.equal(steps.at(-2), S.welcome, "then the welcome");
  }
  Assert.deepEqual(M.MORE_FIELDS, ["panelSide", "agents", "defaultBrowser"]);
});

add_task(function a_joining_user_reviews_search_and_skips_the_rest() {
  const answers = { ...M.defaults(), path: "join" };
  Assert.deepEqual(walk(answers, { ...FACTS, importAvailable: true }), [
    S.intro,
    S.question,
    S.joinFolder,
    S.joinCode,
    S.search,
    S.passwordManager,
    S.more,
    S.welcome,
    S.done,
  ]);
});

add_task(function a_key_found_in_the_folder_skips_the_code() {
  const answers = { ...M.defaults(), path: "join" };
  const facts = { ...FACTS, keyRecovered: true };
  Assert.deepEqual(walk(answers, facts), [
    S.intro,
    S.question,
    S.joinFolder,
    S.search,
    S.passwordManager,
    S.more,
    S.welcome,
    S.done,
  ]);
  Assert.equal(M.back(S.search, answers, facts), S.joinFolder);
});

/** A user with no other device left restores the key from its backup. */
add_task(function a_backup_key_takes_the_codes_place() {
  const answers = { ...M.defaults(), path: "join", joinWith: "backup" };
  Assert.deepEqual(walk(answers), [
    S.intro,
    S.question,
    S.joinFolder,
    S.joinBackup,
    S.search,
    S.passwordManager,
    S.more,
    S.welcome,
    S.done,
  ]);
  Assert.equal(
    M.progress(S.joinBackup, answers, FACTS),
    M.progress(S.joinCode, { ...answers, joinWith: "code" }, FACTS),
    "it fills the bar where the code step does"
  );
});

/**
 * The bar fills to each answered step's place in its path, the
 * introduction and the welcome left out.
 */
add_task(function progress_is_the_place_in_the_path() {
  for (const [name, answers, facts] of paths()) {
    const counted = walk(answers, facts).filter(
      step => ![S.intro, S.welcome, S.done].includes(step)
    );
    for (const [index, step] of counted.entries()) {
      Assert.equal(
        M.progress(step, answers, facts),
        (index + 1) / counted.length,
        `${name}: ${step}`
      );
    }
    Assert.equal(M.progress(S.intro, answers, facts), null, `${name}: intro`);
    Assert.equal(
      M.progress(S.welcome, answers, facts),
      null,
      `${name}: welcome`
    );
  }
  Assert.equal(
    M.progress(S.joinCode, M.defaults(), FACTS),
    null,
    "a step of the other path has no place"
  );
});

/**
 * Continue never moves the bar back, however the answer given on a step
 * changes the path after it: the path is worked out again on every step
 * (2026-11-09 spec §2.5).
 */
add_task(function continue_never_moves_the_bar_back() {
  const browsers = { ...FACTS, importAvailable: true };
  // Each path as the user walks it: the answers and facts on each step,
  // then what they are on the next once its Continue has recorded them.
  const walks = [
    [
      "new, unticking every browser",
      [
        [S.question, M.defaults(), browsers],
        [S.import, M.defaults(), browsers],
        [S.workspace, { ...M.defaults(), importPlan: [] }, browsers],
        [S.search, { ...M.defaults(), importPlan: [] }, browsers],
      ],
    ],
    [
      "new, importing",
      [
        [S.question, M.defaults(), browsers],
        [S.import, M.defaults(), browsers],
        [S.search, { ...M.defaults(), importPlan: WINDOWS }, browsers],
      ],
    ],
    [
      "joining, the folder holding this user's key",
      [
        [S.question, { ...M.defaults(), path: "join" }, FACTS],
        [S.joinFolder, { ...M.defaults(), path: "join" }, FACTS],
        [
          S.search,
          { ...M.defaults(), path: "join" },
          { ...FACTS, keyRecovered: true },
        ],
      ],
    ],
    [
      "joining with a backup",
      [
        [S.joinFolder, { ...M.defaults(), path: "join" }, FACTS],
        [S.joinCode, { ...M.defaults(), path: "join" }, FACTS],
        [
          S.joinBackup,
          { ...M.defaults(), path: "join", joinWith: "backup" },
          FACTS,
        ],
        [
          S.search,
          { ...M.defaults(), path: "join", joinWith: "backup" },
          FACTS,
        ],
      ],
    ],
  ];
  for (const [name, steps] of walks) {
    let before = 0;
    for (const [step, answers, facts] of steps) {
      const now = M.progress(step, answers, facts);
      Assert.greaterOrEqual(now, before, `${name}: ${step} fills no less`);
      before = now;
    }
  }
  // Every Continue on every path, the answers left as they are.
  for (const [name, answers, facts] of paths()) {
    let before = 0;
    for (const step of walk(answers, facts)) {
      const now = M.progress(step, answers, facts);
      if (now !== null) {
        Assert.greater(now, before, `${name}: ${step} fills more`);
        before = now;
      }
    }
  }
});

add_task(function the_last_step_is_the_one_before_the_welcome() {
  for (const [name, answers, facts] of paths()) {
    const steps = walk(answers, facts);
    const last = steps.at(-3);
    Assert.equal(last, S.more, `${name}: ends on a few more things`);
    for (const step of steps) {
      Assert.equal(
        M.isLast(step, answers, facts),
        step === last,
        `${name}: ${step}`
      );
    }
  }
  Assert.ok(
    !M.isLast(S.joinCode, M.defaults(), FACTS),
    "a step this path does not show is not its last"
  );
});

add_task(function back_retraces_next() {
  for (const [name, answers, facts] of paths()) {
    for (const step of walk(answers, facts).slice(1, -1)) {
      const prev = M.back(step, answers, facts);
      Assert.equal(
        M.next(prev, answers, facts),
        step,
        `${name}: back from ${step}`
      );
    }
  }
  Assert.equal(M.back(S.question, M.defaults(), FACTS), S.intro);
});

/**
 * Skip setup, from any step of either path, takes these answers for every
 * step not continued through: what installs nothing (2026-11-09 spec §2.4).
 */
add_task(function skip_setup_installs_nothing_from_any_step() {
  const later = {
    path: "new",
    folder: null,
    search: "ddg",
    adblock: "balanced",
    passwordManager: "none",
    agents: "off",
    panelSide: "left",
    defaultBrowser: false,
    workspace: null,
  };
  for (const [name, answers, facts] of paths()) {
    for (const step of walk(answers, facts)) {
      Assert.deepEqual(
        M.setUpLaterAnswers({
          ...answers,
          adblock: "strict",
          search: "kagi",
          passwordManager: "bitwarden",
          agents: "tools",
          panelSide: "right",
          defaultBrowser: true,
          workspace: { name: "Home", color: "blue", emoji: "" },
        }),
        later,
        `${name}: Skip setup on ${step}`
      );
    }
  }
});

add_task(function agent_access_has_three_answers() {
  Assert.deepEqual(M.AGENT_CHOICES, ["off", "on", "tools"]);
});

/**
 * The new path's synced steps are held until it ends, so turning to join
 * has written neither (first-run spec §2).
 */
add_task(function the_held_steps_are_the_synced_ones() {
  Assert.deepEqual(M.HELD_STEPS, [S.search, S.privacy]);
});
