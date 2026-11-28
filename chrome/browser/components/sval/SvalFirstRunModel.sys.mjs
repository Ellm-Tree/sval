/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The first-run flow as data (first-run spec §3, revamped by the 2026-11-09
 * spec §2). No DOM and no effects: the dialog renders a step, the panel
 * performs it, and this decides what comes next. Every step the user answers
 * is preset to its default, so Continue keeps it. The password manager step
 * alone has no preset, so no manager is put ahead of the others; Continue
 * there with nothing chosen installs nothing.
 */

const STEPS = Object.freeze({
  intro: "intro",
  question: "question",
  joinFolder: "joinFolder",
  joinCode: "joinCode",
  joinBackup: "joinBackup",
  import: "import",
  workspace: "workspace",
  search: "search",
  privacy: "privacy",
  passwordManager: "passwordManager",
  more: "more",
  welcome: "welcome",
  done: "done",
});

/**
 * Whether no imported window will fill the Workspace first run makes: none
 * is imported, or nothing at all. Before the import step is answered its
 * picker has a browser ticked, so the import is taken to bring windows, and
 * the Workspace step joins the path only once the user continues without
 * one: a step is only ever added after the one shown, and the progress bar
 * never moves back (2026-11-09 spec §2.5).
 *
 * @param {object} answers
 * @param {object} facts
 * @returns {boolean}
 */
function importsNoWindow(answers, facts) {
  if (!facts.importAvailable) {
    return true;
  }
  const plan = answers.importPlan;
  return !!plan && !plan.some(entry => entry.windows?.some(w => w.import));
}

// The steps in order, each with when it is shown.
const FLOW = [
  [STEPS.intro, () => true],
  // The question's two answers choose the path.
  [STEPS.question, () => true],
  [STEPS.joinFolder, a => a.path === "join"],
  // A key found in the folder needs no code, and the folder
  // step shows it opening the workspaces. The code step waits for the other
  // device's files itself. A user with no other device left takes the key
  // from its backup in the code step's place.
  [
    STEPS.joinCode,
    (a, f) => a.path === "join" && !f.keyRecovered && a.joinWith !== "backup",
  ],
  [
    STEPS.joinBackup,
    (a, f) => a.path === "join" && !f.keyRecovered && a.joinWith === "backup",
  ],
  [STEPS.import, (a, f) => a.path === "new" && f.importAvailable],
  // Imported windows become Workspaces, the first filling the one first run
  // makes, so the user names that one only when no window is imported.
  [STEPS.workspace, (a, f) => a.path === "new" && importsNoWindow(a, f)],
  // On both paths: a joining device reviews the engine its workspaces use,
  // and signs in to Kagi again, since a Kagi session is per device.
  [STEPS.search, () => true],
  [STEPS.privacy, a => a.path === "new"],
  // On both paths: the extension installs per device.
  [STEPS.passwordManager, () => true],
  // On both paths: the panel's side, agent access and the default browser
  // are this device's own.
  [STEPS.more, () => true],
  [STEPS.welcome, () => true],
  [STEPS.done, () => true],
];

function shown(answers, facts) {
  return FLOW.filter(([, when]) => when(answers, facts)).map(([step]) => step);
}

/**
 * The steps the progress bar counts: those the user answers.
 *
 * @param {object} answers
 * @param {object} facts
 * @returns {string[]}
 */
function answered(answers, facts) {
  return shown(answers, facts).filter(
    step => ![STEPS.intro, STEPS.welcome, STEPS.done].includes(step)
  );
}

export const SvalFirstRunModel = Object.freeze({
  STEPS,

  /**
   * The name the Workspace step offers, and the one the first Workspace
   * takes when the user leaves first run without that step's answer.
   */
  FIRST_WORKSPACE_NAME: "Default Workspace",

  /**
   * The new path's steps whose Continue records the answer and whose write
   * waits for the new path's end. Both settings sync last-writer-wins
   * (first-run spec §2): a new device that turns back to join its other
   * device's tabs and settings must have written neither, since writing the
   * old value back would itself be a newer write.
   */
  HELD_STEPS: Object.freeze([STEPS.search, STEPS.privacy]),

  /**
   * The answers of "A few more things" (2026-11-09 spec §3.6), each its own
   * setting, applied together by the step's Continue.
   */
  MORE_FIELDS: Object.freeze(["panelSide", "agents", "defaultBrowser"]),

  /**
   * Agent access's answers (site-tools spec §7): "off" leaves agent access
   * off, "on" turns it on, and "tools" turns it on and lets sites offer
   * agents their tools.
   */
  AGENT_CHOICES: Object.freeze(["off", "on", "tools"]),

  defaults() {
    return {
      path: "new",
      joinWith: "code",
      folder: null,
      search: "ddg",
      adblock: "balanced",
      passwordManager: null,
      agents: "off",
      panelSide: "left",
      defaultBrowser: true,
      // The Workspace step's fields, set by its Continue; the dialog presets
      // the name it shows.
      workspace: null,
    };
  },

  /**
   * What Skip setup applies to every step not continued through: only what
   * installs nothing (2026-11-09 spec §2.4).
   *
   * @param {object} _answers The answers as they stand.
   * @returns {object}
   */
  setUpLaterAnswers(_answers) {
    return {
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
  },

  next(step, answers, facts) {
    const steps = shown(answers, facts);
    const i = steps.indexOf(step);
    return i < 0 ? STEPS.done : steps[Math.min(i + 1, steps.length - 1)];
  },

  back(step, answers, facts) {
    const steps = shown(answers, facts);
    const i = steps.indexOf(step);
    return i <= 0 ? STEPS.intro : steps[i - 1];
  },

  /**
   * How far the progress bar fills on `step`: its place among the steps the
   * path shows as the answers and facts stand, counting the step itself.
   * The introduction and the welcome are not steps the user answers, so
   * neither has a place.
   *
   * @param {string} step A step of {@link STEPS}.
   * @param {object} answers The answers as they stand.
   * @param {object} facts What is known about this device.
   * @returns {?number} between 0 and 1, or null for a step this path does
   *   not count.
   */
  progress(step, answers, facts) {
    const steps = answered(answers, facts);
    const i = steps.indexOf(step);
    return i < 0 ? null : (i + 1) / steps.length;
  },

  /**
   * Whether Continue on `step` ends the answering, and the welcome follows.
   *
   * @param {string} step A step of {@link STEPS}.
   * @param {object} answers The answers as they stand.
   * @param {object} facts What is known about this device.
   * @returns {boolean}
   */
  isLast(step, answers, facts) {
    return answered(answers, facts).at(-1) === step;
  },
});
