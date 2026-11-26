/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's first run (first-run spec §3, revamped by the 2026-11-09 spec),
 * opened by `SvalFirstRun.sys.mjs`.
 *
 * One section per step, one shown at a time. `SvalFirstRunModel` decides which
 * step follows which; this page renders the step, collects the answer and
 * calls the opener's `actions` for every effect. Continue performs the step
 * through `actions.apply` before moving on (spec §3.3), and the end of the
 * flow is `actions.end`, which the welcome follows.
 *
 * It answers through `window.arguments[0].result`, which the opener reads once
 * the dialog has closed: `{ outcome, answers, completed }`, where `outcome` is
 * `done` or `later` and `completed` lists the steps continued through. A
 * dialog closed any other way leaves `result` null.
 *
 * A classic script in a chrome document, like `new-workspace.js`, so the
 * modules come through `ChromeUtils`.
 */

/* import-globals-from import-picker.js */
/* import-globals-from workspace-form.js */
/* import-globals-from first-run-intro.js */

"use strict";

const { SvalFirstRunModel } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirstRunModel.sys.mjs"
);
const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalPasswordManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPasswordManager.sys.mjs"
);
const { SvalKagi } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagi.sys.mjs"
);
const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);
const { iconURL } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIcons.sys.mjs"
);
const { SvalLog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLog.sys.mjs"
);
const { raceTimeout } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTimeout.sys.mjs"
);
const {
  normalizeCode,
  groupCodeField,
  friendlyFolderName,
  cloudServiceOf,
  randomWorkspaceEmoji,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { LAUNCHER_KEY, keyOf, shortcutCaps, shortcutText } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
  );
const { SvalPairingLook } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPairing.sys.mjs"
);
const { EMOJI_GROUPS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmojiData.sys.mjs"
);
const { drawableEmojiGroups, showInline } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmojiPicker.sys.mjs"
);
const { readCard } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalCard.sys.mjs"
);
const { renderCard } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalCardArt.sys.mjs"
);
const { importFailureKind } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImport.sys.mjs"
);
const { BOOKMARKS_TO } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportModel.sys.mjs"
);
const { harvestBrowser } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
);
const {
  dropboxRoot,
  isRemoteRoot,
  parseDropboxRoot,
  parseSmbRoot,
  remoteFolderPlace,
  smbRoot,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalRemoteFolder.sys.mjs"
);
const { SvalSecretStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);

const { STEPS } = SvalFirstRunModel;

/**
 * How long the waiting step looks before saying the files have not arrived.
 * Long enough that a quick provider never shows it, short enough that the user
 * is not left wondering (spec §3.2).
 */
const FIRST_RUN_NOTE_AFTER_MS = 30000;

/**
 * How long the dialog waits for its font and the engine list before it
 * shows anyway: a window-modal dialog that never shows would leave the
 * window unusable.
 */
const FIRST_RUN_READY_WAIT_MS = 2000;

/**
 * How long Skip setup waits for a step still being applied before it
 * goes on anyway. Leaving must not depend on the panel answering (spec §2).
 */
const FIRST_RUN_APPLY_WAIT_MS = 5000;

/** Sval's app icon and light-on-dark wordmark, from the branding masters. */
const FIRST_RUN_MARK_URL = "chrome://browser/content/sval/home/app-icon.svg";
const FIRST_RUN_WORDMARK_URL =
  "chrome://browser/content/sval/home/wordmark-light-on-dark.svg";

/**
 * Every word the page shows, kept as one set. A sentence never names Sval's
 * own terms a new user has not met.
 */
const STRINGS = Object.freeze({
  title: "Welcome to Sval",
  back: "Back",
  later: "Skip setup",
  continue: "Continue",
  startBrowsing: "Start browsing",
  tryAgain: "Try again",
  cancel: "Cancel",
  // The progress bar's name, which a screen reader says with its value.
  progress: "Setup progress",
  chooseFolder: "Choose folder…",
  connectSmb: "Connect to SMB server…",
  connectDropbox: "Connect to Dropbox…",
  settingUp: where => `Setting up sync through ${where}…`,
  // The SMB server's and the Dropbox folder's panels, worded as Settings'
  // dialogs are (`settings-panes.html`).
  smb: {
    heading: "Connect to an SMB server",
    host: "Server address",
    share: "Share",
    folder: "Folder in the share (optional)",
    user: "Username",
    password: "Password",
    connect: "Connect",
    keychain: label =>
      `If your Mac asks whether Sval can access "${label}" after you ` +
      `select Connect, choose Always Allow.`,
    notKept:
      "Sval couldn't save the password, so it didn't connect to the server.",
  },
  dropbox: {
    heading: "Choose a Dropbox folder",
    up: "Back",
    use: "Use this folder",
    loading: "Loading folders…",
    empty: "This folder has no folders in it.",
    signInFailed: "Sval couldn't sign in to Dropbox.",
    signInRefused: "Dropbox didn't accept Sval's sign-in.",
    unreachable: "Sval can't reach Dropbox. Check your internet connection.",
    keychain: label =>
      `If your Mac asks whether Sval can access "${label}" after you ` +
      `select Use this folder, choose Always Allow.`,
    notKept:
      "Sval couldn't save the Dropbox sign-in, so it didn't use the folder.",
  },
  savingTo: folder => `Saving to ${folder}`,
  chooseAnother: "Choose another folder",
  sendReport: "Send report…",
  startNewInstead: "Start new instead",
  codeLabel: "Code",
  codePlaceholder: "XXXX-XXXX-XXXX",
  codeWrong:
    "That code didn't work. Check the code on your other device and type it again.",
  waitingFor: service =>
    service
      ? `Waiting for ${service} to sync from your other device…`
      : "Waiting for your other device…",
  waitingNote: (service, folder) =>
    service
      ? `This can take a few minutes. Your other device must also save to ${folder}.`
      : `Your other device must also save to ${folder}.`,
  useBackup: "Restore with your backup key",
  backupLabel: "Backup key",
  adopting: "Opening your tabs and settings…",
  joined: "Your tabs and settings are here.",
  // What the folder's problem (`SvalSharedFolder.folderProblem`) leaves the
  // user to do, and the buttons that do it.
  problems: {
    gone: {
      text:
        "The folder isn't there anymore. If the folder is on a network " +
        "drive or USB drive, reconnect the drive.",
      actions: ["retry"],
    },
    denied: {
      text: "Sval doesn't have permission to change files in the folder.",
      actions: ["chooseAnother"],
    },
    offline: {
      text:
        "Sval can't read the folder. If the folder is on a network drive, " +
        "check that you're connected to the network.",
      actions: ["retry"],
    },
    "too-large": {
      text: "Sval can't open a file in the folder because the file is too large.",
      actions: ["report"],
    },
    bug: {
      text: "Sval can't open your tabs and settings. This is a problem in Sval. Send a report so it can be fixed.",
      actions: ["report", "startNew"],
    },
  },
  stepFailed: "Something went wrong. Click Continue to try again.",
  intro: {
    // Each frame's heading is a list of parts; `keys` stands for the
    // Launcher's key caps.
    // The first frame is Sval's own welcome; the others each have a scene
    // (`first-run-intro.js`), in order.
    frames: [
      {
        heading: ["Welcome to Sval"],
        body: "Here's a quick look at how Sval works.",
      },
      {
        heading: ["Your tabs live in Workspaces"],
        body:
          "A Workspace holds the tabs and groups for whatever you're " +
          "working on. Use the switcher above your tabs to move between " +
          "Workspaces. Show tabs side-by-side with Splits.",
      },
      {
        heading: ["Press ", { keys: true }, " to open the Launcher"],
        body:
          "Type to search the web, jump to any open tab on any Workspace, " +
          "or to run a command. Use the @ shortcuts to search specific sites.",
      },
      {
        heading: ["Your data stays yours"],
        body:
          "Sval blocks the ways companies track you. Your tabs sync through " +
          "storage you control, and Sval collects no personal data. An AI " +
          "assistant on your computer can use Sval only if you want it to, " +
          "otherwise AI can be off entirely.",
      },
    ],
    next: "Next",
    back: "Back",
    getStarted: "Get started",
    skip: "Skip",
    // The scenes' canned content (`first-run-intro.js`). `keyword` and
    // `siteEngine` name a real alias of Sval's and its engine.
    scenes: {
      newTab: "New tab",
      workspaces: [
        {
          name: "Work",
          emoji: "💼",
          color: "blue",
          tabs: ["Q3 roadmap", "Inbox"],
          split: ["Design review", "Spec draft"],
          group: {
            name: "Launch",
            color: "cyan",
            tabs: ["Press kit", "Status page"],
          },
        },
        {
          name: "Home",
          emoji: "🏠",
          color: "green",
          tabs: ["Groceries", "Electric bill", "Weeknight recipes"],
          group: {
            name: "Garden",
            color: "yellow",
            tabs: ["Seed order", "Tomato care"],
          },
        },
        {
          name: "Trip to Lisbon",
          emoji: "✈️",
          color: "orange",
          tabs: ["Flights", "Alfama apartment", "Tram 28 times"],
          group: {
            name: "Food",
            color: "pink",
            tabs: ["Pastéis de Belém", "Time Out Market"],
          },
        },
      ],
      launcher: {
        color: "green",
        query: "lisbon",
        stillQuery: "lisb",
        engine: "DuckDuckGo",
        tab: {
          title: "Lisbon apartment in Alfama",
          url: "stays.example.com/lisbon/alfama",
          workspace: "Trip to Lisbon",
          emoji: "✈️",
          color: "orange",
        },
        history: [
          {
            title: "Tram 28 · Lisbon trams",
            url: "trams.example.com/lisbon/28",
          },
        ],
        suggestions: ["lisbon weather in may", "lisbon to porto train"],
        keyword: "@maps",
        siteEngine: "OpenStreetMap",
        siteQuery: "alfama",
      },
      protection: {
        host: "news.example.com",
        trackers: 23,
        ads: 9,
        fingerprinters: 2,
      },
    },
  },
  steps: {
    question: {
      heading: "Is this your first time using Sval?",
      options: {
        new: "I'm new to Sval",
        join: "I use Sval on another device",
      },
      details: {
        new: "Set up Sval on this computer.",
        join: "Bring your Workspaces from that device to this computer.",
      },
    },
    joinFolder: {
      heading: "Choose the folder your other device syncs to",
      body: "Sval looks for your Workspaces in that folder.",
    },
    joinCode: {
      heading: "Type the code from your other device",
      body:
        "On your other device, open Settings › Sync and devices › " +
        "Sync with another device › This device shows a code.",
    },
    joinBackup: {
      heading: "Type your backup key",
      body:
        "Sval showed you this key when you set up sync. Look for it in " +
        "your password manager or in the file or printout you saved.",
    },
    import: {
      heading: "Bring your info from another browser",
      body:
        "Your open tabs arrive in Workspaces. Each profile or Space becomes " +
        "a Sval Workspace. Your bookmarks go into the Sval Favorites menu.",
      arcCard:
        "Your Arc card comes too, along with your years in Arc. You can " +
        "see it when setup finishes.",
    },
    workspace: {
      heading: "Name your first Workspace",
      body: "A Workspace holds the tabs and groups for whatever you're working on.",
      name: SvalFirstRunModel.FIRST_WORKSPACE_NAME,
    },
    search: {
      heading: "Choose a search engine",
      joinBody: engine =>
        `Your other device uses ${engine}, so Sval defaulted to it here.`,
      details: {
        ddg: "Doesn't track you. Ads match only what you search for.",
        startpage: "Google's results, without Google tracking you.",
        brave: "Its own results. Doesn't build a profile of you.",
        kagi: "Paid, with no ads. You can rank sites higher or lower.",
        google: "The most results. Tracks you to show ads.",
        bing: "Microsoft's search. Tracks you to show ads.",
        ecosia: "Uses its profits to plant trees.",
        qwant: "Based in Europe. Doesn't keep your search history.",
        perplexity: "AI answers, with links to sources.",
        wikipedia: "Searches Wikipedia only.",
      },
      kagi: "Kagi needs an account.",
      kagiSignIn: "Sign in to Kagi",
      kagiOpen: "A new window opened. Sign in to Kagi there.",
      kagiOpenAgain: "Open Again",
      kagiSignedIn: "Signed in to Kagi.",
    },
    privacy: {
      heading: "How much should Sval block?",
      options: {
        off: "No Blocking",
        balanced: "Balanced Blocking",
        strict: "Strict Blocking",
      },
      details: {
        off: "Sites load every ad and tracker they ask for.",
        balanced: "Blocks ads and trackers. Most sites work as usual.",
        strict:
          "Also blocks cookie pop-ups, social media buttons, and trackers " +
          "in links. Some sites may break.",
      },
      alwaysOn:
        "Whichever you choose, Sval will still warn you about scam and " +
        "malware sites.",
    },
    passwordManager: {
      heading: "Which password manager do you use?",
      body:
        "Sval doesn't keep your passwords. Choose your password manager, " +
        "and Sval will install the extension for it.",
      options: {
        ...Object.fromEntries(
          SvalPasswordManager.MANAGERS.map(manager => [
            manager.key,
            manager.name,
          ])
        ),
        none: "None of these",
      },
      details: {
        none:
          "No password extensions installed. You can choose one later in " +
          "Settings › Privacy and protection › Password manager.",
      },
    },
    more: {
      heading: "A few more things",
      body: "You can change these choices later in Settings.",
      panelSide: {
        title: "Workspace panel",
        text: "Choose the side of the window the Workspace panel goes on.",
        options: { left: "Left", right: "Right" },
      },
      agents: {
        title: "AI assistants",
        text: "Let AI assistants on this computer use Sval. You still approve each assistant first.",
        options: { off: "Off", on: "On" },
      },
      defaultBrowser: {
        title: "Default browser",
        text: "Make Sval your default web browser.",
        options: { true: "Yes", false: "No" },
      },
      tools: "Let websites offer tools to AI assistants",
      toolsDetail:
        "A website can offer agents tools, like searching a store or " +
        "comparing products. You approve each website first.",
    },
    welcome: {
      // The card stores its title in capitals, as its art draws it; a
      // sentence names it in title case.
      heading: title =>
        `Welcome, ${title
          .toLowerCase()
          .replace(/(^|[\s-])\p{L}/gu, c => c.toUpperCase())}.`,
      cards: {
        new:
          "Welcome to Sval! This is your Sval Card, a fun memento for " +
          "joining Sval. We hope you enjoy it. Please give us feedback if " +
          "you have any.",
        arc:
          "Welcome to Sval! This is your Sval Card, a fun memento for " +
          "joining Sval. As a previous user of Arc, we carried your Arc " +
          "Card details over. We hope you enjoy it. Please give us feedback " +
          "if you have any.",
        synced:
          "Welcome to Sval! This is your Sval Card, a fun memento for " +
          "joining Sval. We hope you enjoy it. Please give us feedback if " +
          "you have any.",
      },
      sync: {
        new: "Your tabs are only stored on this computer for now.",
        join: "Your Workspaces sync with your other device through the folder you chose.",
      },
      setUpSync: "Set up sync",
      importing: browser =>
        `Sval is bringing your information from ${browser}.`,
      imported: browsers =>
        `Sval brought in your information from ${browsers}.`,
    },
  },
  // The tour's one mention of the Launcher's key (launcher spec §8), in
  // `sval/launcher.ftl`.
  tip: "launcher-tour-tip",
});

/** Each choice's glyph, a name in `SvalIcons`. */
const GLYPHS = Object.freeze({
  [STEPS.question]: { new: "new-sync", join: "device" },
  [STEPS.privacy]: {
    off: "privacy-off",
    balanced: "privacy-balanced",
    strict: "privacy-strict",
  },
  [STEPS.passwordManager]: { [SvalPasswordManager.NONE]: "none" },
});

/** Each card's glyph on "A few more things"; the panel's follows its side. */
const MORE_GLYPHS = Object.freeze({
  panelSide: { left: "panel-on-left", right: "panel-on-right" },
  agents: "agents",
  defaultBrowser: "default-browser",
});

/**
 * Each password manager's own logo, so the user finds theirs by sight. "None"
 * has a glyph in `GLYPHS` instead.
 */
const LOGOS = Object.freeze({
  [STEPS.passwordManager]: Object.fromEntries(
    SvalPasswordManager.MANAGERS.map(manager => [
      manager.key,
      `chrome://browser/content/sval/password-managers/${manager.key}.png`,
    ])
  ),
});

/**
 * The choice steps drawn as dense rows, so a long list fits the sheet with
 * its notice (spec §3.1: all ten engines, and every password manager).
 */
const DENSE = Object.freeze([STEPS.search, STEPS.passwordManager]);

/**
 * The steps that are one choice, the answer each sets and its values. The
 * search step's values arrive from `actions.searchEngines()`.
 */
const CHOICES = Object.freeze({
  [STEPS.question]: { field: "path", values: ["new", "join"] },
  [STEPS.search]: { field: "search", values: [] },
  [STEPS.privacy]: { field: "adblock", values: SvalBlocking.CURATED_LEVELS },
  [STEPS.passwordManager]: {
    field: "passwordManager",
    values: SvalPasswordManager.choices(),
  },
});

/**
 * "A few more things": each card's answer and its values. On covers both
 * answers that turn agent access on; the checkbox under it says whether
 * sites may offer tools (`accepted` lists every answer an earlier run may
 * have left).
 */
const MORE = Object.freeze({
  panelSide: { field: "panelSide", values: ["left", "right"] },
  agents: {
    field: "agents",
    values: ["off", "on"],
    accepted: SvalFirstRunModel.AGENT_CHOICES,
    read: answers => (answers.agents === "off" ? "off" : "on"),
    write: (answers, value) => {
      if (value === "off") {
        answers.agents = "off";
      } else if (answers.agents === "off") {
        answers.agents = "on";
      }
    },
  },
  defaultBrowser: { field: "defaultBrowser", values: [true, false] },
});

/**
 * The answers each step decides, so Skip setup keeps what was continued
 * through and takes its own answers for the rest.
 */
const STEP_FIELDS = Object.freeze({
  [STEPS.joinFolder]: ["folder"],
  [STEPS.search]: ["search"],
  [STEPS.privacy]: ["adblock"],
  [STEPS.import]: ["importPlan"],
  [STEPS.workspace]: ["workspace"],
  [STEPS.passwordManager]: ["passwordManager"],
  [STEPS.more]: SvalFirstRunModel.MORE_FIELDS,
});

/** The steps a join is shown on, which offer what a failed one can do. */
const JOINING = Object.freeze([
  STEPS.joinFolder,
  STEPS.joinCode,
  STEPS.joinBackup,
]);

/** The steps with a subtitle under their heading. */
const SUBTITLED = Object.freeze([
  STEPS.joinFolder,
  STEPS.joinCode,
  STEPS.joinBackup,
  STEPS.import,
  STEPS.workspace,
  STEPS.search,
  STEPS.passwordManager,
  STEPS.more,
]);

const DRAWN = Object.freeze(
  Object.values(STEPS).filter(step => step !== STEPS.done)
);

const SvalFirstRunPage = {
  /**
   * What the opener passed in: `{ actions, facts, roots, result }`.
   */
  _args: null,

  _answers: null,

  _facts: null,

  _step: null,

  /** Each continued step's answers as they were on its Continue. */
  _confirmed: null,

  /**
   * What an interrupted first run already applied, by field, which Skip
   * setup keeps whether or not its step is continued through again.
   */
  _earlier: null,

  /** Whether an action the page waits on is running. */
  _busy: false,

  /**
   * The folder the join step is setting up while its sign-in is saved and
   * Sval reaches it, or null.
   */
  _working: null,

  /**
   * The Dropbox panel's state while it is open: the refresh token it lists
   * with, and the folder it shows, `/`-separated and empty for the root of
   * the Dropbox.
   */
  _dropbox: null,

  /** The normalized pairing code, once the code step has accepted one. */
  _code: null,

  /**
   * Where pairing is: `idle`, `looking`, `adopting`, `failed`, or `landed`.
   * Landed is final: the dialog never claims or adopts again.
   */
  _join: "idle",

  /**
   * What Try again repeats once joining has failed: `look` claims with the
   * same code again, `adopt` adopts the claimed key again, and `restore`
   * restores the typed backup again.
   */
  _retry: null,

  /** The waiting step's look for the code, a `SvalPairingLook`. */
  _claims: null,

  _noteTimer: null,

  /** Whether a normal window is signed in to Kagi, as last heard. */
  _kagiSignedIn: false,

  /** The `actions.apply` under way, or null. */
  _applying: null,

  /**
   * How the flow ended, `done` or `later`, once `actions.end` has been
   * asked; null before. The welcome follows it.
   */
  _ended: null,

  /** Set once the dialog is answering, so it answers once. */
  _finishing: false,

  /** The import step's `SvalImportPicker`, once it is drawn. */
  _importPicker: null,

  /** The Workspace step's `SvalWorkspaceForm`. */
  _workspaceForm: null,

  /** The introduction's scenes (`SvalFirstRunIntro.build`). */
  _intro: null,

  /** The introduction's heroes: the welcome's, then each scene's. */
  _heroes: null,

  /** Which of the introduction's frames shows. */
  _frame: 0,

  /** Each engine's name, by id, for the joining device's line. */
  _engineNames: null,

  /**
   * The welcome's import: `{ items, report, running }`, one item per plan
   * entry run, `{ entry, state, kind, error }`, as the import page keeps
   * them; null when nothing is imported.
   */
  _import: null,

  /**
   * A failed join's problem, a key of `STRINGS.problems`, or null; with the
   * join's own failure name, which a report carries.
   */
  _problem: null,

  _failure: null,

  /** Counts Kagi sign-ins asked for, so only the latest one's end is said. */
  _kagiAsks: 0,

  /** Set from a step being shown until the task that showed it ends. */
  _settling: false,

  /** How many choices are drawn, so each has ids of its own. */
  _options: 0,

  _gone: false,

  start() {
    this._args = window.arguments?.[0] ?? {};
    this._actions = this._args.actions;
    this._claims = new SvalPairingLook({ timers: window });
    this._answers = SvalFirstRunModel.defaults();
    this._facts = { ...this._args.facts };
    // Sval already the default leaves the card out (2026-11-09 spec §3.6),
    // so nothing asks the system again.
    if (this._facts.isDefaultBrowser) {
      this._answers.defaultBrowser = false;
    }
    this._confirmed = new Map();
    this._engineNames = {};
    this._presetEarlier(this._facts.earlier ?? {});
    document.title = STRINGS.title;

    this._shapeBox();
    this._main = document.querySelector("main");
    this._announcer = this._element("p", {
      class: "sval-visually-hidden",
      "aria-live": "polite",
    });
    for (const step of DRAWN) {
      this._main.append(this._buildSection(step));
    }
    this._main.append(this._announcer);

    // Reading the other browsers takes a moment, so it starts with the
    // dialog and is done long before the user reaches the step.
    this._importPicker?.load().catch(err => {
      SvalLog.warn(
        `first run: other browsers were not read (${SvalLog.errorName(err)})`
      );
    });

    // The sheet's size is its stylesheet's, the same for every step, so it
    // waits only for Outfit and the engines, which it is drawn with when
    // they come in time.
    document.mozSubdialogReady = Promise.all([
      this._bounded(this._loadEngines()),
      this._bounded(document.fonts.load('15px "Outfit"')),
    ]);
    document.subDialogSetDefaultFocus = () => this._focusStep();

    this._main.addEventListener("click", this);
    this._main.addEventListener("change", this);
    this._main.addEventListener("input", this);
    this._main.addEventListener("focusin", this);
    this._main.addEventListener("submit", this);
    window.addEventListener("keydown", this);
    window.addEventListener("unload", () => {
      this._gone = true;
      this._stopLooking();
      this._intro?.stop();
    });

    this._show(STEPS.intro);
    // No step came before the introduction, so no Continue can be aimed at
    // one. Its settling timer may also run late: the dialog box stays
    // hidden until it is sized, and a hidden document's timers may be
    // throttled.
    this._settling = false;
  },

  /**
   * Presets what an interrupted first run already applied, and counts each
   * step whose answers it all holds as continued through, so Skip setup
   * keeps it: a re-run loses nothing already answered (spec §3.3). A value
   * the step does not offer is left at the step's default.
   *
   * @param {object} earlier The answers, by field.
   */
  _presetEarlier(earlier) {
    const offered = (field, value) => {
      const choice = [...Object.values(CHOICES), ...Object.values(MORE)].find(
        c => c.field === field
      );
      const values = choice?.accepted ?? choice?.values;
      return !values?.length || values.includes(value);
    };
    this._earlier = Object.fromEntries(
      Object.entries(earlier).filter(([field, value]) => offered(field, value))
    );
    Object.assign(this._answers, this._earlier);
    for (const [step, fields] of Object.entries(STEP_FIELDS)) {
      if (fields.every(field => field in this._earlier)) {
        this._confirmed.set(
          step,
          Object.fromEntries(fields.map(field => [field, this._earlier[field]]))
        );
      }
    }
  },

  /**
   * Resolves once `promise` settles, or after the ready wait; never
   * rejects. It runs on the window's own clock: the opener's clock may be a
   * test's, which moves only by hand.
   *
   * @param {Promise|undefined} promise
   * @returns {Promise<void>}
   */
  async _bounded(promise) {
    await raceTimeout(
      Promise.resolve(promise).catch(() => {}),
      FIRST_RUN_READY_WAIT_MS,
      window
    );
  },

  _element(tag, attrs = {}, text = null) {
    const el = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (const [name, value] of Object.entries(attrs)) {
      el.setAttribute(name, value);
    }
    if (text !== null) {
      el.textContent = text;
    }
    return el;
  },

  _button(kind, text, { primary = false } = {}) {
    return this._element(
      "button",
      { class: `sval-fr-${kind}${primary ? " primary" : ""}`, type: "button" },
      text
    );
  },

  _section(step) {
    return this._main.querySelector(`section[data-step="${step}"]`);
  },

  _in(selector, step = this._step) {
    return this._section(step).querySelector(selector);
  },

  /**
   * The dialog box holds nothing but the sheet, so it draws the sheet's card
   * with its shadow (`SvalDialogBox`). `SubDialog` clones the box for this
   * dialog alone and removes it when the dialog closes, so nothing outlives
   * the sheet.
   */
  _shapeBox() {
    const { shapeDialogBox } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalDialogBox.sys.mjs"
    );
    shapeDialogBox(document.querySelector(".sval-fr"), {
      shadow: "0 24px 64px rgba(3, 5, 26, 0.55)",
    });
  },

  /**
   * One step's section. The introduction and the welcome have their own
   * layouts; every other step has a header with the progress bar, heading
   * and subtitle, what the step offers, and Skip setup, Back and Continue.
   *
   * @param {string} step A step of `SvalFirstRunModel.STEPS`.
   * @returns {Element} the section.
   */
  _buildSection(step) {
    const headingId = `sval-fr-${step}-heading`;
    const section = this._element("section", {
      "data-step": step,
      "aria-labelledby": headingId,
    });
    section.hidden = true;
    if (step === STEPS.intro) {
      return this._buildIntro(section, headingId);
    }
    if (step === STEPS.welcome) {
      return this._buildWelcome(section, headingId);
    }
    const words = STRINGS.steps[step];
    const bodyId = `sval-fr-${step}-body`;
    const alwaysId = `sval-fr-${step}-always`;

    const head = this._element("header", { class: "sval-fr-head" });
    const bar = this._element("div", {
      class: "sval-fr-progress",
      role: "progressbar",
      "aria-label": STRINGS.progress,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
    });
    bar.append(this._element("div", { class: "sval-fr-progress-fill" }));
    head.append(
      bar,
      this._element("h1", { id: headingId, tabindex: "-1" }, words.heading)
    );
    if (SUBTITLED.includes(step)) {
      head.append(
        this._element(
          "p",
          { id: bodyId, class: "sval-fr-body" },
          words.body ?? ""
        )
      );
    }

    const content = this._element("div", { class: "sval-fr-content" });
    const choice = CHOICES[step];
    if (choice) {
      // The group is named by the heading and described by the words the
      // choice depends on, which a screen reader says as focus enters it.
      const described = [];
      if (SUBTITLED.includes(step)) {
        described.push(bodyId);
      }
      if (words.alwaysOn) {
        described.push(alwaysId);
      }
      const group = this._element("div", {
        class: "sval-fr-options",
        role: "radiogroup",
        "aria-labelledby": headingId,
      });
      if (described.length) {
        group.setAttribute("aria-describedby", described.join(" "));
      }
      if (DENSE.includes(step)) {
        group.dataset.dense = "true";
      }
      for (const value of choice.values) {
        group.append(
          this._option(step, value, words.options[String(value)], {
            detail: words.details?.[value],
            glyph: GLYPHS[step]?.[value],
            icon: LOGOS[step]?.[value],
          })
        );
      }
      content.append(group);
    }

    // Every step says what went wrong in one line (spec §8). It is always
    // present and filled in when due: a live region announces a change to its
    // text, and may say nothing when it is itself shown.
    let status = this._element("p", {
      class: "sval-fr-status sval-fr-notice",
      role: "status",
      "data-tone": "warn",
    });

    switch (step) {
      case STEPS.joinFolder: {
        const zone = this._element("div", { class: "sval-fr-folder-zone" });
        const ways = this._element("div", { class: "sval-fr-folder-ways" });
        const choose = this._button("choose-folder", "");
        choose.append(this._glyph("choose-folder"), STRINGS.chooseFolder);
        const dropbox = this._button("connect-dropbox", "");
        dropbox.append(
          this._element("img", {
            class: "sval-fr-brand",
            src: "chrome://browser/content/sval/sync-services/dropbox.svg",
            alt: "",
          }),
          STRINGS.connectDropbox
        );
        ways.append(
          choose,
          this._button("connect-smb", STRINGS.connectSmb),
          dropbox
        );
        // The folder is said as it is shown: the native picker hands focus
        // back to the button with nothing else announced.
        const chosen = this._element("p", {
          class: "sval-fr-folder-chosen",
          role: "status",
        });
        chosen.append(this._element("span", { class: "sval-fr-folder" }));
        // Saving a sign-in may wait on the Keychain, and reaching a remote
        // folder on the network: the step says it is working meanwhile.
        const working = this._element("p", {
          class: "sval-fr-working",
          role: "status",
        });
        working.hidden = true;
        zone.append(ways, chosen, working);
        content.append(zone, this._buildSmb(), this._buildDropbox(), status);
        break;
      }
      case STEPS.joinCode: {
        const field = this._element("div", { class: "sval-fr-field" });
        const inputId = "sval-fr-code-input";
        const statusId = "sval-fr-code-status";
        status = this._element("p", {
          id: statusId,
          class: "sval-fr-status sval-fr-error",
          role: "alert",
        });
        const input = this._element("input", {
          id: inputId,
          class: "sval-fr-code",
          type: "text",
          autocomplete: "off",
          spellcheck: "false",
          placeholder: STRINGS.codePlaceholder,
          "aria-describedby": statusId,
        });
        groupCodeField(input);
        field.append(
          this._element(
            "label",
            { class: "sval-fr-label", for: inputId },
            STRINGS.codeLabel
          ),
          input,
          status
        );
        const join = this._element("p", {
          class: "sval-fr-join",
          role: "status",
        });
        join.hidden = true;
        content.append(
          field,
          this._button("use-backup", STRINGS.useBackup),
          join,
          this._element("p", {
            class: "sval-fr-note sval-fr-notice",
            role: "status",
            "data-tone": "neutral",
          })
        );
        break;
      }
      case STEPS.joinBackup: {
        const field = this._element("div", { class: "sval-fr-field" });
        const inputId = "sval-fr-backup-input";
        const statusId = "sval-fr-backup-status";
        status = this._element("p", {
          id: statusId,
          class: "sval-fr-status sval-fr-error",
          role: "alert",
        });
        // A backup is thirteen groups of four, too long for one line of the
        // code field's type, so it wraps in a box of two.
        const input = this._element("textarea", {
          id: inputId,
          class: "sval-fr-code sval-fr-backup-key",
          rows: "2",
          autocomplete: "off",
          spellcheck: "false",
          "aria-describedby": statusId,
        });
        field.append(
          this._element(
            "label",
            { class: "sval-fr-label", for: inputId },
            STRINGS.backupLabel
          ),
          input,
          status
        );
        const join = this._element("p", {
          class: "sval-fr-join",
          role: "status",
        });
        join.hidden = true;
        content.append(field, join);
        break;
      }
      case STEPS.search: {
        const kagi = this._element("div", {
          class: "sval-fr-kagi sval-fr-notice",
          role: "note",
          "data-tone": "info",
        });
        kagi.hidden = true;
        kagi.append(
          this._element(
            "p",
            { class: "sval-fr-kagi-then", role: "status" },
            words.kagi
          ),
          this._button("kagi-signin", words.kagiSignIn)
        );
        content.append(kagi);
        break;
      }
      case STEPS.privacy:
        content.append(
          this._element(
            "p",
            { id: alwaysId, class: "sval-fr-always" },
            words.alwaysOn
          )
        );
        break;
      case STEPS.import: {
        // The import page's own picker (import spec §5), with the logins
        // hand-off left to the password manager step, where the manager is
        // chosen.
        const host = this._element("div", { class: "sval-im-picker" });
        const arc = this._element(
          "p",
          {
            class: "sval-fr-arc-card sval-fr-notice",
            role: "note",
            "data-tone": "card",
          },
          words.arcCard
        );
        arc.hidden = true;
        content.append(host, arc);
        if (this._facts.importAvailable) {
          this._importPicker = new SvalImportPicker(host, {
            roots: this._args.roots,
            logins: false,
            archive: true,
            onChange: () => {
              this._syncIfShown(STEPS.import);
              this._syncIfShown(STEPS.passwordManager);
            },
          });
        }
        break;
      }
      case STEPS.workspace:
        this._buildWorkspace(content);
        break;
      case STEPS.passwordManager: {
        const logins = this._element("div", { class: "sval-fr-logins" });
        logins.hidden = true;
        content.append(logins);
        break;
      }
      case STEPS.more:
        this._buildMore(content);
        break;
    }
    if (!status.parentNode) {
      content.append(status);
    }
    // What the user can do about a join that failed, under its line.
    if (JOINING.includes(step)) {
      const problem = this._element("div", { class: "sval-fr-problem" });
      problem.hidden = true;
      problem.append(
        this._button("choose-another", STRINGS.chooseAnother),
        this._button("report", STRINGS.sendReport),
        this._button("start-new", STRINGS.startNewInstead)
      );
      content.append(problem);
    }

    const actions = this._element("footer", { class: "sval-fr-actions" });
    actions.append(
      this._button("later", STRINGS.later),
      this._element("span", { class: "sval-fr-spacer" }),
      this._button("back", STRINGS.back)
    );
    if (JOINING.includes(step)) {
      const retry = this._button("retry", STRINGS.tryAgain, { primary: true });
      retry.hidden = true;
      actions.append(retry);
    }
    if (step === STEPS.joinCode) {
      // While the code step waits, Cancel stands where Continue stood.
      const cancel = this._button("cancel", STRINGS.cancel);
      cancel.hidden = true;
      actions.append(cancel);
    }
    actions.append(
      this._button("continue", STRINGS.continue, { primary: true })
    );
    section.append(head, content, actions);
    return section;
  },

  /**
   * The introduction (2026-11-09 spec §3.1): Sval's welcome, then three
   * frames, each a night-sky scene of the real components over its words,
   * moved through by Next and Back, the dots, the arrow keys and Enter. Skip
   * goes to the question.
   *
   * @param {Element} section The introduction's section.
   * @param {string} headingId The heading's id.
   * @returns {Element} the section.
   */
  _buildIntro(section, headingId) {
    const words = STRINGS.intro;
    section.classList.add("sval-fr-intro");
    const caps = this._launcherCaps();
    this._intro = SvalFirstRunIntro.build(document, { content: words.scenes });
    // The welcome's hero: Sval's mark and wordmark on the night sky.
    const welcome = this._element("div", {
      class: "sval-fr-intro-welcome",
      "aria-hidden": "true",
    });
    const wordmark = this._element("span", { class: "sval-fr-wordmark" });
    wordmark.append(
      this._element("img", { src: FIRST_RUN_WORDMARK_URL, alt: "" })
    );
    welcome.append(
      this._element("img", {
        class: "sval-fr-mark",
        src: FIRST_RUN_MARK_URL,
        alt: "",
      }),
      wordmark
    );
    this._heroes = [welcome, ...this._intro.heroes];
    const heroes = this._element("div", { class: "sval-fr-heroes" });
    heroes.append(...this._heroes);
    // The heading says each frame as it changes: focus stays on the button
    // that moved it.
    const text = this._element("div", {
      class: "sval-fr-intro-text",
      "aria-live": "polite",
    });
    text.append(
      this._element("h1", { id: headingId, tabindex: "-1" }),
      this._element("p", { class: "sval-fr-body" })
    );
    const dots = this._element("div", { class: "sval-fr-dots" });
    words.frames.forEach((frame, i) => {
      const dot = this._element("button", {
        class: "sval-fr-dot",
        type: "button",
        "data-frame": String(i),
        "aria-label": this._headingText(frame.heading, caps),
      });
      dot.append(this._element("span", { class: "sval-fr-dot-mark" }));
      dots.append(dot);
    });
    const actions = this._element("footer", { class: "sval-fr-actions" });
    actions.append(
      dots,
      this._element("span", { class: "sval-fr-spacer" }),
      this._button("skip", words.skip),
      this._button("intro-back", words.back),
      this._button("next", words.next, { primary: true })
    );
    section.append(heroes, text, actions);
    return section;
  },

  /**
   * @returns {string[]} the Launcher's key as the browser window has it,
   *   one cap per key, which opens this dialog over itself (`SvalFirstRun`).
   */
  _launcherCaps() {
    const key =
      window.browsingContext.topChromeWindow.document.getElementById(
        LAUNCHER_KEY
      );
    return shortcutCaps(keyOf(key));
  },

  /**
   * @param {Array<string|object>} parts A frame's heading.
   * @param {string[]} caps The Launcher's key caps.
   * @returns {string} the heading as words, the caps spaced as drawn.
   */
  _headingText(parts, caps) {
    return parts
      .map(part => (typeof part === "string" ? part : caps.join(" ")))
      .join("");
  },

  /** Shows the introduction's frame `this._frame`. */
  _syncIntro() {
    const section = this._section(STEPS.intro);
    const frame = STRINGS.intro.frames[this._frame];
    const last = this._frame === STRINGS.intro.frames.length - 1;
    section.dataset.frame = String(this._frame);
    this._heroes.forEach((hero, i) => {
      hero.hidden = i !== this._frame;
    });
    const heading = section.querySelector("h1");
    heading.replaceChildren(
      ...frame.heading.map(part => {
        if (typeof part === "string") {
          return part;
        }
        const keys = this._element("span", { class: "sval-fr-keys" });
        keys.append(
          ...this._launcherCaps().map(cap =>
            this._element("kbd", { class: "sval-fr-keycap" }, cap)
          )
        );
        return keys;
      })
    );
    section.querySelector(".sval-fr-body").textContent = frame.body;
    for (const dot of section.querySelectorAll(".sval-fr-dot")) {
      if (Number(dot.dataset.frame) === this._frame) {
        dot.setAttribute("aria-current", "step");
      } else {
        dot.removeAttribute("aria-current");
      }
    }
    section.querySelector(".sval-fr-intro-back").hidden = this._frame === 0;
    const next = section.querySelector(".sval-fr-next");
    next.textContent = last ? STRINGS.intro.getStarted : STRINGS.intro.next;
    next.toggleAttribute("data-last", last);
    // The welcome has no scene; each frame after it plays its own.
    if (this._frame) {
      this._intro.show(this._frame - 1);
    } else {
      this._intro.stop();
    }
  },

  /**
   * Moves the introduction to `frame`, or on past its last to the question.
   *
   * @param {number} frame
   */
  _toFrame(frame) {
    if (frame < 0) {
      return;
    }
    if (frame >= STRINGS.intro.frames.length) {
      this._leaveIntro();
      return;
    }
    this._frame = frame;
    this._syncIntro();
  },

  _leaveIntro() {
    this._intro.stop();
    this._show(STEPS.question);
  },

  /**
   * The Workspace step's body (2026-11-09 spec §3.4): the Workspace's header
   * as the panel will draw it, above the New Workspace dialog's own fields
   * (`SvalWorkspaceForm`). Its emoji button opens Sval's emoji picker in the
   * step itself, since no dialog opens over this one.
   *
   * @param {Element} content The step's body.
   */
  _buildWorkspace(content) {
    const words = STRINGS.steps.workspace;
    const preview = this._element("div", {
      class: "sval-fr-ws-preview",
      "aria-hidden": "true",
    });
    preview.append(
      this._element("span", { class: "sval-fr-ws-tile" }),
      this._element("span", { class: "sval-fr-ws-name" }),
      this._glyph("expand", "sval-fr-ws-glyph")
    );
    const form = this._element("div", { class: "sval-fr-ws-form" });
    form.append(...SvalWorkspaceForm.fields(document));
    content.append(preview, form);
    this._workspaceForm = new SvalWorkspaceForm(form, {
      tintsWindow: true,
      name: words.name,
      color: null,
      emoji:
        randomWorkspaceEmoji(drawableEmojiGroups(EMOJI_GROUPS, document)) ?? "",
      onChange: () => this._previewWorkspace(),
      onPickEmoji: () => this._openEmoji(),
    });
  },

  /**
   * Draws what the Workspace step's fields hold on its header, and on the
   * panel behind the sheet, which follows as the user changes them.
   */
  _previewWorkspace() {
    const fields = this._workspaceFields();
    const preview = this._in(".sval-fr-ws-preview", STEPS.workspace);
    preview.querySelector(".sval-fr-ws-tile").textContent = fields.emoji;
    preview.querySelector(".sval-fr-ws-name").textContent =
      fields.name.trim() || STRINGS.steps.workspace.name;
    const look =
      fields.color &&
      SvalColor.windowLook(
        { color: fields.color },
        {
          scheme: matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light",
          more: matchMedia("(prefers-contrast: more)").matches,
        }
      );
    preview.toggleAttribute("data-color", !!look);
    const values = look && {
      tint: SvalColor.css(look.tint),
      body: SvalColor.css(look.strong),
      line: SvalColor.css(look.line),
    };
    for (const member of ["tint", "body", "line"]) {
      if (values) {
        preview.style.setProperty(`--sval-fr-ws-${member}`, values[member]);
      } else {
        preview.style.removeProperty(`--sval-fr-ws-${member}`);
      }
    }
    this._sayPreview(fields);
  },

  /**
   * Has the panel show `fields` on its switcher, or put its own back.
   *
   * @param {?object} fields
   */
  _sayPreview(fields) {
    this._actions
      .previewWorkspace?.(fields)
      .catch(err =>
        SvalLog.warn(
          `first run: the panel did not follow (${SvalLog.errorName(err)})`
        )
      );
  },

  /** @returns {{name: string, color: ?string, emoji: string}} */
  _workspaceFields() {
    const form = this._workspaceForm;
    return { name: form.name, color: form.color, emoji: form.emoji };
  },

  /**
   * Shows the emoji picker in the step, in place of the fields, and puts
   * them back with what was chosen. Escape in the picker is its Cancel
   * (`emoji-picker.js`), so Escape closes the picker before it skips setup.
   */
  _openEmoji() {
    const section = this._section(STEPS.workspace);
    const form = this._workspaceForm;
    // Made as it opens and removed as it closes, so no empty frame loads.
    const frame = this._element("iframe", {
      class: "sval-fr-emoji",
      title: "Emoji",
    });
    section.dataset.picking = "true";
    showInline(frame, form.emoji, ({ ok, value }) => {
      if (this._gone) {
        return;
      }
      delete section.dataset.picking;
      frame.remove();
      if (ok) {
        form.emoji = value;
      }
      form.els.emoji.focus();
    });
    this._in(".sval-fr-content", STEPS.workspace).append(frame);
  },

  /**
   * "A few more things" (2026-11-09 spec §3.6): a card for each choice, its
   * glyph, title and words beside a two-way switch drawn as two radios. AI
   * assistants on shows whether sites may offer them tools; Default browser
   * is left out where Sval already is.
   *
   * @param {Element} content The step's body.
   */
  _buildMore(content) {
    const words = STRINGS.steps.more;
    const cards = this._element("div", { class: "sval-fr-cards" });
    for (const [setting, choice] of Object.entries(MORE)) {
      if (setting === "defaultBrowser" && this._facts.isDefaultBrowser) {
        continue;
      }
      const card = words[setting];
      const titleId = `sval-fr-more-${setting}-title`;
      const textId = `sval-fr-more-${setting}-text`;
      const el = this._element("div", {
        class: "sval-fr-card",
        "data-setting": setting,
      });
      const main = this._element("div", { class: "sval-fr-card-main" });
      const tile = this._element("span", { class: "sval-fr-tile" });
      const glyph = MORE_GLYPHS[setting];
      tile.append(this._glyph(typeof glyph === "string" ? glyph : glyph.left));
      const cardWords = this._element("span", {
        class: "sval-fr-option-words",
      });
      cardWords.append(
        this._element(
          "span",
          { id: titleId, class: "sval-fr-option-label" },
          card.title
        ),
        this._element(
          "span",
          { id: textId, class: "sval-fr-option-detail" },
          card.text
        )
      );
      const group = this._element("div", {
        class: "sval-fr-segments",
        role: "radiogroup",
        "aria-labelledby": titleId,
        "aria-describedby": textId,
      });
      for (const value of choice.values) {
        const label = this._element("label", { class: "sval-fr-segment" });
        label.append(
          this._element("input", {
            type: "radio",
            name: `sval-fr-more-${setting}`,
            value: String(value),
            "data-setting": setting,
          }),
          this._element("span", {}, card.options[String(value)])
        );
        group.append(label);
      }
      main.append(tile, cardWords, group);
      el.append(main);
      if (setting === "agents") {
        const check = this._element("label", { class: "sval-fr-check" });
        const box = this._element("input", {
          type: "checkbox",
          class: "sval-fr-tools",
          "aria-describedby": "sval-fr-tools-detail",
        });
        const checkWords = this._element("span", {
          class: "sval-fr-option-words",
        });
        checkWords.append(
          this._element("span", { class: "sval-fr-check-label" }, words.tools),
          this._element(
            "span",
            { id: "sval-fr-tools-detail", class: "sval-fr-option-detail" },
            words.toolsDetail
          )
        );
        check.append(box, checkWords);
        check.hidden = true;
        el.append(check);
      }
      cards.append(el);
    }
    content.append(cards);
  },

  /**
   * The welcome (2026-11-09 spec §3.7): the user's card with its reveal and
   * a greeting by its title; under it what is being imported, where the
   * user's tabs are kept, and the Launcher's key; then Start browsing.
   *
   * @param {Element} section The welcome's section.
   * @param {string} headingId The heading's id.
   * @returns {Element} the section.
   */
  _buildWelcome(section, headingId) {
    const words = STRINGS.steps.welcome;
    section.classList.add("sval-fr-welcome");
    // The greeting on the left of the night sky, and the card on its right.
    const hero = this._element("div", { class: "sval-fr-card-hero" });
    const text = this._element("div", { class: "sval-fr-welcome-text" });
    text.append(
      this._element("h1", { id: headingId, tabindex: "-1" }),
      this._element("p", { class: "sval-fr-body" })
    );
    hero.append(text, this._element("div", { class: "sval-fr-card-slot" }));

    const rows = this._element("div", { class: "sval-fr-rows" });
    const importRow = this._element("div", {
      class: "sval-fr-row sval-fr-import",
      role: "status",
    });
    importRow.hidden = true;
    const importHead = this._element("div", { class: "sval-fr-import-head" });
    importHead.append(
      this._element("span", { class: "sval-fr-import-logos" }),
      this._element("p", { class: "sval-fr-import-text" })
    );
    const importBar = this._element("div", {
      class: "sval-fr-import-bar",
      "aria-hidden": "true",
    });
    importBar.append(this._element("div", { class: "sval-fr-progress-fill" }));
    importRow.append(
      importHead,
      importBar,
      this._element("div", { class: "sval-fr-import-result" })
    );

    const syncRow = this._element("div", { class: "sval-fr-row sval-fr-sync" });
    syncRow.append(
      this._glyph("folder-sync", "sval-fr-row-glyph"),
      this._element("p", { class: "sval-fr-sync-text" }),
      this._button("set-up-sync", words.setUpSync)
    );
    const tipRow = this._element("div", { class: "sval-fr-row" });
    tipRow.append(this._launcherTip(STRINGS.tip));
    rows.append(importRow, syncRow, tipRow);

    const actions = this._element("footer", { class: "sval-fr-actions" });
    actions.append(
      this._element("span", { class: "sval-fr-spacer" }),
      this._button("start", STRINGS.startBrowsing, { primary: true })
    );
    section.append(hero, rows, actions);
    return section;
  },

  /**
   * A line naming the Launcher's key as the browser window has it. The
   * page's other words are its own (`STRINGS`); the Launcher's are Fluent's,
   * and the dialog has no localization of its own.
   *
   * @param {string} id The line's message in `sval/launcher.ftl`.
   * @returns {Element} the line.
   */
  _launcherTip(id) {
    const key =
      window.browsingContext.topChromeWindow.document.getElementById(
        LAUNCHER_KEY
      );
    const tip = this._element("p", { class: "sval-fr-tip" });
    this._launcherL10n ??= new DOMLocalization(["sval/launcher.ftl"]);
    this._launcherL10n.setAttributes(tip, id, {
      key: shortcutText(keyOf(key)),
    });
    this._launcherL10n
      .translateElements([tip])
      .catch(err =>
        SvalLog.error(
          `the tour's Launcher line failed: ${SvalLog.errorName(err)}`
        )
      );
    return tip;
  },

  /**
   * One of the page's Lucide glyphs, drawn in its element's `fill`.
   *
   * @param {string} name The glyph's name in `SvalIcons`.
   * @param {string} [className]
   * @returns {Element} the image.
   */
  _glyph(name, className = "sval-fr-glyph") {
    return this._element("img", {
      class: className,
      src: iconURL(name),
      alt: "",
    });
  },

  /**
   * The bar that warns of the Keychain's question, which comes as Sval
   * saves the sign-in. `_openConnect` shows it on a Mac whose secrets the
   * system store keeps or will.
   *
   * @param {Function} words The sentence, given the store's label.
   * @returns {Element} the bar, hidden.
   */
  _keychainBar(words) {
    const bar = this._element("moz-message-bar", {
      class: "sval-fr-keychain",
      type: "warning",
      message: words(SvalSecretStore.userLabel()),
    });
    bar.hidden = true;
    return bar;
  },

  /**
   * Cancel and the panel's own action, at the panel's foot.
   *
   * @param {string} kind The panel's name, which prefixes its buttons'.
   * @param {Element} go Its action.
   * @returns {Element} the row.
   */
  _connectActions(kind, go) {
    const row = this._element("div", { class: "sval-fr-connect-actions" });
    row.append(
      this._element("span", { class: "sval-fr-spacer" }),
      this._button(`${kind}-cancel`, STRINGS.cancel),
      go
    );
    return row;
  },

  /**
   * The SMB server's panel, which takes the folder zone's place while it is
   * open: where the folder is and the sign-in for it, as Settings' dialog
   * asks (`settings-panes.html`). Connect submits the form, so Enter in a
   * field connects.
   *
   * @returns {Element} the panel, hidden.
   */
  _buildSmb() {
    const words = STRINGS.smb;
    const panel = this._element("form", {
      class: "sval-fr-connect sval-fr-smb",
      "aria-labelledby": "sval-fr-smb-heading",
    });
    panel.hidden = true;
    const fields = this._element("div", { class: "sval-fr-smb-fields" });
    for (const [name, attrs] of [
      ["host", { required: "required", placeholder: "nas.local" }],
      ["share", { required: "required", placeholder: "Shared" }],
      ["folder", { placeholder: "Sval" }],
      ["user", {}],
      ["password", { type: "password" }],
    ]) {
      const id = `sval-fr-smb-${name}`;
      fields.append(
        this._element(
          "label",
          { class: "sval-fr-label", for: id },
          words[name]
        ),
        this._element("input", {
          id,
          class: "sval-fr-input",
          name,
          type: "text",
          spellcheck: "false",
          autocomplete: "off",
          ...attrs,
        })
      );
    }
    const connect = this._button("smb-connect", words.connect, {
      primary: true,
    });
    connect.type = "submit";
    panel.append(
      this._element(
        "h2",
        { id: "sval-fr-smb-heading", class: "sval-fr-connect-heading" },
        words.heading
      ),
      fields,
      this._keychainBar(words.keychain),
      this._connectActions("smb", connect)
    );
    return panel;
  },

  /**
   * The Dropbox panel, which takes the folder zone's place while it is open:
   * where it is in the Dropbox, Back up one level, and the folders there,
   * each opened by a click, as Settings' dialog shows them
   * (`settings-panes.html`).
   *
   * @returns {Element} the panel, hidden.
   */
  _buildDropbox() {
    const words = STRINGS.dropbox;
    const panel = this._element("div", {
      class: "sval-fr-connect sval-fr-dropbox",
      role: "group",
      "aria-labelledby": "sval-fr-dropbox-heading",
    });
    panel.hidden = true;
    const where = this._element("div", { class: "sval-fr-dropbox-where" });
    where.append(
      this._button("dropbox-up", words.up),
      this._element("span", {
        id: "sval-fr-dropbox-place",
        class: "sval-fr-dropbox-place",
      })
    );
    panel.append(
      this._element(
        "h2",
        { id: "sval-fr-dropbox-heading", class: "sval-fr-connect-heading" },
        words.heading
      ),
      where,
      this._element("ul", {
        class: "sval-fr-dropbox-folders",
        "aria-labelledby": "sval-fr-dropbox-place",
      }),
      this._element("p", {
        class: "sval-fr-dropbox-status",
        role: "status",
      }),
      this._keychainBar(words.keychain),
      this._connectActions(
        "dropbox",
        this._button("dropbox-use", words.use, { primary: true })
      )
    );
    return panel;
  },

  /**
   * One radio, named by its label and described by its detail, so arrowing
   * through a group says each choice's name first. The radio is a real one,
   * so the group keeps the platform's arrow keys and announcements (spec §7).
   *
   * @param {string} step The step it belongs to.
   * @param {string|boolean} value The answer it stands for.
   * @param {string} label Its name.
   * @param {object} [extra]
   * @param {string} [extra.detail] A few words more.
   * @param {string} [extra.icon] An image URL drawn before the name.
   * @param {string} [extra.glyph] A glyph drawn before the name instead.
   * @returns {Element} the option's label.
   */
  _option(step, value, label, { detail, icon, glyph } = {}) {
    const row = this._element("label", { class: "sval-fr-option" });
    if (glyph) {
      const tile = this._element("span", { class: "sval-fr-tile" });
      tile.append(this._glyph(glyph));
      row.append(tile);
    } else if (icon !== undefined) {
      const img = this._element("img", { alt: "", class: "sval-fr-icon" });
      if (icon) {
        img.setAttribute("src", icon);
      }
      row.append(img);
    }
    const id = `sval-fr-option-${++this._options}`;
    const words = this._element("span", { class: "sval-fr-option-words" });
    words.append(
      this._element(
        "span",
        { id: `${id}-label`, class: "sval-fr-option-label" },
        label
      )
    );
    const radio = this._element("input", {
      type: "radio",
      name: `sval-fr-${step}`,
      value: String(value),
      "aria-labelledby": `${id}-label`,
    });
    if (detail) {
      words.append(
        this._element(
          "span",
          { id: `${id}-detail`, class: "sval-fr-option-detail" },
          detail
        )
      );
      radio.setAttribute("aria-describedby", `${id}-detail`);
    }
    row.append(words, radio);
    return row;
  },

  /**
   * Kagi's row and its sign-in, drawn as one choice, so the sign-in shows
   * under Kagi while Kagi is the one chosen. The sign-in sits beside the
   * label, outside it, because a button inside a label would be its control.
   *
   * @param {Element} option Kagi's option label.
   * @returns {Element}
   */
  _withKagiSignIn(option) {
    const block = this._element("div", { class: "sval-fr-option-block" });
    block.append(option, this._in(".sval-fr-kagi", STEPS.search));
    return block;
  },

  /** Draws the search step's engines, in the order the opener gives. */
  async _loadEngines() {
    try {
      const engines = (await this._actions.searchEngines()) ?? [];
      if (this._gone) {
        return;
      }
      const words = STRINGS.steps.search;
      const group = this._in('[role="radiogroup"]', STEPS.search);
      for (const engine of engines) {
        try {
          const detail =
            words.details[engine.id] ?? words.details[engine.id.split("-")[0]];
          const option = this._option(STEPS.search, engine.id, engine.name, {
            detail,
            icon: engine.iconURL ?? "",
          });
          group.append(
            engine.id === "kagi" ? this._withKagiSignIn(option) : option
          );
          // With its row, so every row drawn is a value Continue can keep.
          CHOICES[STEPS.search].values.push(engine.id);
          this._engineNames[engine.id] = engine.name;
        } catch (err) {
          SvalLog.warn(
            `first run: a search engine was not drawn (${SvalLog.errorName(err)})`
          );
        }
      }
      // `_presetEarlier` ran before the engines were known, so it kept any
      // earlier engine; one the step does not offer leaves the default.
      const { values } = CHOICES[STEPS.search];
      if (values.length && !values.includes(this._answers.search)) {
        this._answers.search = SvalFirstRunModel.defaults().search;
        this._confirmed.delete(STEPS.search);
        delete this._earlier.search;
      }
      // The user may be on the step already, so its choice is drawn and
      // focus stays where they put it.
      this._syncIfShown(STEPS.search);
    } catch (err) {
      SvalLog.warn(
        `first run: the search engines did not load (${SvalLog.errorName(err)})`
      );
    }
  },

  /**
   * Shows `step`, says its heading, and puts focus where spec §7 wants it.
   *
   * @param {string} step A drawn step.
   */
  _show(step) {
    this._step = step;
    // A Continue that arrives in the same task as the step change was aimed
    // at the last step: every step's Continue sits in the same place. The
    // window's own clock ends it, since the opener's may be a test's, which
    // moves only by hand.
    this._settling = true;
    window.setTimeout(() => {
      this._settling = false;
    }, 0);
    for (const section of this._main.querySelectorAll("section")) {
      section.hidden = section.dataset.step !== step;
    }
    // `SubDialog` makes the body the dialog; the shown step's heading names
    // it.
    document.body.setAttribute("aria-labelledby", `sval-fr-${step}-heading`);
    if (step === STEPS.intro) {
      this._syncIntro();
    } else {
      this._sync();
    }
    // Focus goes to the step's choice, so the heading is said by itself.
    // The introduction's frames say theirs as they change.
    if (step !== STEPS.intro) {
      this._announcer.textContent = this._in("h1").textContent;
    }
    if (step === STEPS.workspace) {
      this._previewWorkspace();
    } else if (
      SvalFirstRunModel.progress(
        STEPS.workspace,
        this._answers,
        this._facts
      ) === null
    ) {
      // The path names no workspace any more, so the panel shows its own.
      this._sayPreview(null);
    }
    this._focusStep();
    if (step === STEPS.search && this._answers.search === "kagi") {
      this._checkKagi();
    }
  },

  /**
   * Focus on what the step asks (spec §7): the selected choice of a group,
   * or the first when none is, the first field, or the button that moves
   * on. The welcome waits on its heading while its import runs.
   */
  _focusStep() {
    const section = this._section(this._step);
    let target;
    switch (this._step) {
      case STEPS.intro:
        target = section.querySelector(".sval-fr-next");
        break;
      case STEPS.workspace:
        target = this._workspaceForm.els.name;
        break;
      case STEPS.joinFolder:
        target = section.querySelector(".sval-fr-choose-folder");
        break;
      case STEPS.joinCode:
      case STEPS.joinBackup:
        target = section.querySelector(".sval-fr-code");
        if (target.disabled) {
          target = section.querySelector("h1");
        }
        break;
      case STEPS.import:
        target =
          section.querySelector(".sval-im-tick:not(:disabled)") ??
          section.querySelector(".sval-fr-continue");
        break;
      case STEPS.welcome: {
        const start = section.querySelector(".sval-fr-start");
        target = start.disabled ? section.querySelector("h1") : start;
        break;
      }
      default:
        target =
          section.querySelector('input[type="radio"]:checked') ??
          section.querySelector('input[type="radio"]');
    }
    target?.focus();
    if (this._step === STEPS.workspace) {
      target.select();
    }
  },

  /** Brings the shown step's controls into line with the answers. */
  _sync() {
    const step = this._step;
    const section = this._section(step);
    if (step === STEPS.welcome) {
      this._syncWelcome(section);
      return;
    }
    if (CHOICES[step]) {
      const current = this._valueOf(step);
      for (const radio of section.querySelectorAll('input[type="radio"]')) {
        radio.checked = radio.value === String(current);
      }
    }

    const back = section.querySelector(".sval-fr-back");
    const next = section.querySelector(".sval-fr-continue");
    let canContinue = true;
    switch (step) {
      case STEPS.joinFolder: {
        // Written only when the folder changes: the line is live, and a
        // rewrite would say the same folder again.
        const folder = this._answers.folder;
        const line = folder ? STRINGS.savingTo(this._folderName(folder)) : "";
        const path = section.querySelector(".sval-fr-folder");
        if (path.textContent !== line) {
          path.textContent = line;
        }
        canContinue = !!folder && !this._working;
        const working = section.querySelector(".sval-fr-working");
        working.hidden = !this._working;
        const doing = this._working
          ? STRINGS.settingUp(this._workingPlace(this._working))
          : "";
        if (working.textContent !== doing) {
          working.textContent = doing;
        }
        for (const way of section.querySelectorAll(
          ".sval-fr-folder-ways > button"
        )) {
          way.disabled = !!this._working;
        }
        // A key found in the folder opens the workspaces here, and the flow
        // goes on once they are open.
        if (this._facts.keyRecovered && this._join !== "landed") {
          canContinue = false;
        }
        this._syncProblem(section, next);
        break;
      }
      case STEPS.joinCode: {
        const code = this._in(".sval-fr-code", step);
        const busy = ["looking", "adopting"].includes(this._join);
        code.disabled = busy || this._join === "landed";
        canContinue = !busy;
        back.disabled = ["landed", "adopting"].includes(this._join);
        section.dataset.join = this._join;
        this._in(".sval-fr-join", step).hidden = this._join === "idle";
        this._syncProblem(section, next);
        const looking = this._join === "looking";
        this._in(".sval-fr-cancel", step).hidden = !looking;
        if (looking) {
          next.hidden = true;
        }
        this._in(".sval-fr-use-backup", step).hidden = [
          "adopting",
          "landed",
        ].includes(this._join);
        break;
      }
      case STEPS.joinBackup: {
        const busy = this._join === "adopting";
        this._in(".sval-fr-code", step).disabled =
          busy || this._join === "landed";
        canContinue = !busy;
        back.disabled = ["landed", "adopting"].includes(this._join);
        section.dataset.join = this._join;
        this._in(".sval-fr-join", step).hidden = this._join === "idle";
        this._syncProblem(section, next);
        break;
      }
      case STEPS.import:
        // Continue waits only while the other browsers are being read.
        canContinue = this._importPicker?.loaded ?? true;
        this._in(".sval-fr-arc-card", step).hidden = !this._importPicker
          ?.plan()
          .some(entry => entry.harvest?.arcCard);
        break;
      case STEPS.passwordManager:
        this._syncLogins(section);
        break;
      case STEPS.more:
        this._syncMore(section);
        break;
      case STEPS.search: {
        const joining = this._answers.path === "join";
        const body = this._in(".sval-fr-body", step);
        const engine =
          this._engineNames[this._facts.syncedSearch] ??
          this._facts.syncedSearch;
        body.textContent =
          joining && engine ? STRINGS.steps.search.joinBody(engine) : "";
        body.hidden = !body.textContent;
        this._in(".sval-fr-kagi", step).hidden =
          this._answers.search !== "kagi";
        // Signed in, Kagi needs neither its sign-in nor its trial.
        for (const button of section.querySelectorAll(".sval-fr-kagi button")) {
          button.hidden = this._kagiSignedIn;
        }
        break;
      }
    }
    next.disabled = !canContinue;
    this._syncProgress(section);
  },

  /**
   * Draws "A few more things" from the answers.
   *
   * @param {Element} section The step's section.
   */
  _syncMore(section) {
    for (const radio of section.querySelectorAll('input[type="radio"]')) {
      const { field, read } = MORE[radio.dataset.setting];
      const current = read ? read(this._answers) : this._answers[field];
      radio.checked = radio.value === String(current);
    }
    const side = MORE_GLYPHS.panelSide[this._answers.panelSide];
    section
      .querySelector('[data-setting="panelSide"] .sval-fr-glyph')
      .setAttribute("src", iconURL(side));
    section.querySelector(".sval-fr-check").hidden =
      this._answers.agents === "off";
    section.querySelector(".sval-fr-tools").checked =
      this._answers.agents === "tools";
  },

  /**
   * @param {string} folder An absolute path, or an SMB or Dropbox root.
   * @returns {string} how the page names it: the service and folder for a
   *   cloud folder, the whole place for any other, since a share's or a
   *   drive's own name is not enough to tell it apart.
   */
  _folderName(folder) {
    if (isRemoteRoot(folder)) {
      return remoteFolderPlace(folder);
    }
    return cloudServiceOf(folder) ? friendlyFolderName(folder) : folder;
  },

  /**
   * Shows the buttons a failed join's problem offers (`STRINGS.problems`),
   * with Try again in Continue's place, so Enter and the eye find the one way
   * forward where Continue stood.
   *
   * @param {Element} section A join step's section.
   * @param {Element} next Its Continue.
   */
  _syncProblem(section, next) {
    const failed = this._join === "failed" && this._problem;
    const actions = failed ? STRINGS.problems[this._problem].actions : [];
    section.querySelector(".sval-fr-problem").hidden = !actions.some(
      action => action !== "retry"
    );
    for (const [action, selector] of [
      ["chooseAnother", ".sval-fr-problem .sval-fr-choose-another"],
      ["report", ".sval-fr-report"],
      ["startNew", ".sval-fr-start-new"],
      ["retry", ".sval-fr-retry"],
    ]) {
      section.querySelector(selector).hidden = !actions.includes(action);
    }
    next.hidden = actions.includes("retry");
  },

  /**
   * Shows, under the managers, how to move the passwords of each browser
   * being imported into the one chosen (import spec §5.1), always open: on
   * this step it is what the choice is for. Sval reads none of them.
   *
   * @param {Element} section The password manager step's section.
   */
  _syncLogins(section) {
    const box = section.querySelector(".sval-fr-logins");
    const imported = this._confirmed.has(STEPS.import);
    const sources = imported ? (this._importPicker?.loginSources() ?? []) : [];
    const without = imported
      ? (this._importPicker?.noLoginSources() ?? [])
      : [];
    box.hidden = !sources.length && !without.length;
    box.textContent = "";
    if (box.hidden) {
      return;
    }
    const manager = SvalPasswordManager.managerFor(
      this._answers.passwordManager
    );
    box.append(
      SvalImportPicker.handoff(document, sources, manager, { without })
    );
  },

  /**
   * Fills the progress bar to the step's place in the path as the answers
   * and facts stand, so it follows the path chosen (2026-11-09 spec §2.5).
   *
   * @param {Element} section The shown step's section.
   */
  _syncProgress(section) {
    const share =
      SvalFirstRunModel.progress(this._step, this._answers, this._facts) ?? 0;
    const bar = section.querySelector(".sval-fr-progress");
    bar.setAttribute("aria-valuenow", String(Math.round(share * 100)));
    bar.style.setProperty("--sval-fr-share", String(share));
  },

  /**
   * The shown answer of a choice step.
   *
   * @param {string} step A choice step.
   * @returns {string|boolean} the answer.
   */
  _valueOf(step) {
    return this._answers[CHOICES[step].field];
  },

  /**
   * Says one thing on a step's status line, or clears it.
   *
   * @param {string} text What to say, or "" for nothing.
   * @param {string} [step] The step whose line it is.
   * @param {string} [tone] A notice's tone: `warn`, or `info` for news that is
   *   not a fault. The code step's line is always its field's error, and the
   *   waiting step's always its join status.
   * @param {string} [said] What the line says, as its `data-said`: a key of
   *   `STRINGS.problems`, or the name of the news.
   */
  _status(text, step = this._step, tone = "warn", said = "") {
    const status = this._in(".sval-fr-status", step);
    status.textContent = text;
    status.dataset.said = text ? said : "";
    if (status.dataset.tone) {
      status.dataset.tone = tone;
    }
    if (step === STEPS.joinCode || step === STEPS.joinBackup) {
      this._in(".sval-fr-code", step).setAttribute(
        "aria-invalid",
        String(!!text)
      );
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case "click":
        this._onClick(event);
        break;
      case "change":
        this._onChange(event);
        break;
      case "input":
        if (event.target.classList.contains("sval-fr-code")) {
          this._status("");
          // A code changed after a join failed is a new code.
          if (this._join === "failed") {
            this._join = "idle";
            this._problem = null;
            this._joinLine("");
            this._sync();
          }
        }
        break;
      case "keydown":
        this._onKeyDown(event);
        break;
      case "submit":
        event.preventDefault();
        if (event.target.classList.contains("sval-fr-smb")) {
          this._connectSmb();
        }
        break;
      case "focusin":
        // Gecko scrolls a focused element only when none of it shows
        // (`nsFocusManager::ScrollIntoView`), so a choice at the edge of a
        // scrolling list could stay half under the buttons. Its whole row
        // comes into view.
        if (event.target.type === "radio") {
          event.target.closest(".sval-fr-option")?.scrollIntoView({
            block: "nearest",
          });
        }
        break;
    }
  },

  _onClick(event) {
    const button = event.target.closest?.("button");
    // The second click of a double click is not a second press.
    if (!button || button.disabled || event.detail > 1) {
      return;
    }
    if (button.classList.contains("sval-fr-dot")) {
      this._toFrame(Number(button.dataset.frame));
      return;
    }
    const kind = [...button.classList].find(name =>
      name.startsWith("sval-fr-")
    );
    switch (kind) {
      case "sval-fr-next":
        this._toFrame(this._frame + 1);
        break;
      case "sval-fr-intro-back":
        this._toFrame(this._frame - 1);
        break;
      case "sval-fr-skip":
        this._leaveIntro();
        break;
      case "sval-fr-continue":
        this._continue();
        break;
      case "sval-fr-back":
        this._back();
        break;
      case "sval-fr-retry":
        this._tryAgain();
        break;
      case "sval-fr-cancel":
        this._cancelLooking();
        break;
      case "sval-fr-later":
        this._skipSetup();
        break;
      case "sval-fr-choose-folder":
      case "sval-fr-choose-another":
        this._chooseAnother();
        break;
      case "sval-fr-connect-smb":
        this._openSmb();
        break;
      case "sval-fr-connect-dropbox":
        this._chooseDropbox();
        break;
      case "sval-fr-smb-cancel":
      case "sval-fr-dropbox-cancel":
        this._closeConnect();
        break;
      case "sval-fr-dropbox-up": {
        const folder = this._dropbox?.folder ?? "";
        this._browseDropbox(folder.split("/").slice(0, -1).join("/"));
        break;
      }
      case "sval-fr-dropbox-folder": {
        const folder = this._dropbox?.folder ?? "";
        const name = button.dataset.name;
        this._browseDropbox(folder ? `${folder}/${name}` : name);
        break;
      }
      case "sval-fr-dropbox-use":
        this._useDropboxFolder();
        break;
      case "sval-fr-report":
        this._skipSetup({
          report: `First run: joining failed (${this._failure ?? "unknown"}, ${this._problem ?? "no folder problem"}).`,
        });
        break;
      case "sval-fr-start-new":
        this._startNewInstead();
        break;
      case "sval-fr-use-backup":
        this._useBackup();
        break;
      case "sval-fr-kagi-signin":
        this._signInToKagi();
        break;
      case "sval-fr-start":
        this._close();
        break;
      case "sval-fr-set-up-sync":
        this._setUpSync();
        break;
    }
  },

  _onChange(event) {
    const input = event.target;
    const step = input.closest("section")?.dataset.step;
    if (step !== this._step) {
      return;
    }
    if (input.classList.contains("sval-fr-tools")) {
      this._answers.agents = input.checked ? "tools" : "on";
      return;
    }
    if (input.type !== "radio") {
      return;
    }
    if (step === STEPS.more) {
      const { field, values, write } = MORE[input.dataset.setting];
      const value = values.find(v => String(v) === input.value);
      if (write) {
        write(this._answers, value);
      } else {
        this._answers[field] = value;
      }
      this._sync();
      if (field === "panelSide") {
        // The panel moves behind the dialog as the side is chosen (spec §2).
        // Panel side is this device's alone, so moving it early writes
        // nothing another device reads.
        this._actions.movePanel(value).catch(err => {
          SvalLog.warn(
            `first run: the panel side did not move (${SvalLog.errorName(err)})`
          );
        });
      }
      return;
    }
    if (!CHOICES[step]) {
      return;
    }
    const { field, values } = CHOICES[step];
    const value = values.find(v => String(v) === input.value);
    if (step === STEPS.question) {
      this._choosePath(value);
    } else {
      this._answers[field] = value;
    }
    this._status("");
    this._sync();
    if (step === STEPS.search && this._answers.search === "kagi") {
      this._checkKagi();
    }
  },

  /**
   * Enter is Continue, or Try again where it stands in Continue's place, and
   * Escape is Skip setup on every step (spec §7), and is kept from the dialog
   * box, which would close the dialog unanswered. A focused button keeps
   * Enter for itself. The introduction has no Skip setup, so Escape does
   * nothing there, and its frames move by the arrow keys and Enter. On the
   * welcome both keys start browsing, once nothing is running.
   *
   * @param {KeyboardEvent} event The key pressed.
   */
  _onKeyDown(event) {
    // A key the emoji picker's frame has handled, as its Escape and Enter,
    // still reaches this window (chrome documents' events go on to the
    // frame's own).
    if (event.defaultPrevented) {
      return;
    }
    const enter = event.key === "Enter";
    const escape = event.key === "Escape";
    // A held key is one press.
    if (event.repeat && (escape || enter)) {
      event.preventDefault();
      return;
    }
    const onButton = event.target.localName === "button";
    // An open SMB or Dropbox panel keeps Enter for its own fields and
    // buttons, and Escape is its Cancel.
    if (this._section(this._step)?.dataset.connecting) {
      if (escape) {
        event.preventDefault();
        this._closeConnect();
      }
      return;
    }
    switch (this._step) {
      case STEPS.intro:
        if (escape) {
          event.preventDefault();
        } else if (enter && !onButton) {
          event.preventDefault();
          this._toFrame(this._frame + 1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          this._toFrame(this._frame + 1);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          this._toFrame(this._frame - 1);
        }
        return;
      case STEPS.welcome:
        if (escape || (enter && !onButton)) {
          event.preventDefault();
          if (!this._in(".sval-fr-start").disabled) {
            this._close();
          }
        }
        return;
    }
    if (escape) {
      event.preventDefault();
      this._skipSetup();
    } else if (enter && !onButton) {
      event.preventDefault();
      const retry = this._section(this._step).querySelector(".sval-fr-retry");
      if (retry && !retry.hidden) {
        this._tryAgain();
      } else if (!this._in(".sval-fr-continue").disabled) {
        this._continue();
      }
    }
  },

  _copy() {
    return structuredClone(this._answers);
  },

  /**
   * Takes the path the question's answer names. Turning to the other path
   * leaves nothing of the first behind that another device reads: the held
   * steps (`SvalFirstRunModel.HELD_STEPS`) wrote nothing, and they start
   * again from their defaults.
   *
   * @param {string} path `new` or `join`.
   */
  _choosePath(path) {
    if (this._answers.path === path) {
      return;
    }
    this._answers.path = path;
    const defaults = SvalFirstRunModel.defaults();
    this._answers.joinWith = defaults.joinWith;
    // A folder is chosen for joining alone.
    this._answers.folder = null;
    this._confirmed.delete(STEPS.joinFolder);
    this._facts.keyRecovered = false;
    this._stopLooking();
    if (this._join !== "landed") {
      this._join = "idle";
      this._problem = null;
    }
    for (const step of SvalFirstRunModel.HELD_STEPS) {
      for (const field of STEP_FIELDS[step]) {
        this._answers[field] = defaults[field];
      }
      this._confirmed.delete(step);
    }
  },

  async _continue() {
    if (this._busy || this._settling || this._ended) {
      return;
    }
    const step = this._step;
    // The code step waits for the other device's files in place: Continue
    // looks with the code typed, and moves on once the join has landed.
    if (step === STEPS.joinCode && this._join !== "landed") {
      const code = normalizeCode(this._in(".sval-fr-code").value);
      if (!code) {
        this._status(STRINGS.codeWrong, this._step, "warn", "code-wrong");
        this._in(".sval-fr-code").focus();
        return;
      }
      this._code = code;
      this._startLooking();
      return;
    }
    if (step === STEPS.joinBackup && this._join !== "landed") {
      await this._restore();
      return;
    }

    if (step === STEPS.import) {
      this._answers.importPlan = this._importPicker?.plan() ?? [];
    }
    if (step === STEPS.workspace) {
      if (!this._workspaceForm.checkName()) {
        return;
      }
      this._answers.workspace = this._workspaceFields();
    }

    // Search is synced: a joining device that keeps the engine its workspaces
    // use writes nothing, so it cannot put back an engine that sync has not
    // brought yet over the one the other devices chose.
    const keepsSyncedSearch =
      step === STEPS.search &&
      this._answers.path === "join" &&
      this._answers.search === this._facts.syncedSearch;
    // The opener applies a held step at the new path's end.
    const held =
      this._answers.path === "new" &&
      SvalFirstRunModel.HELD_STEPS.includes(step);
    const answers = this._copy();
    if (step !== STEPS.question) {
      this._busy = true;
      try {
        this._applying =
          keepsSyncedSearch || held
            ? Promise.resolve()
            : this._actions.apply(step, answers);
        await this._applying;
      } catch (err) {
        SvalLog.warn(
          `first run: ${step} did not apply (${SvalLog.errorName(err)})`
        );
        this._status(STRINGS.stepFailed, this._step, "warn", "step-failed");
        return;
      } finally {
        this._busy = false;
        this._applying = null;
      }
    }
    const confirmed = {};
    for (const field of STEP_FIELDS[step] ?? []) {
      confirmed[field] = answers[field];
    }
    if (STEP_FIELDS[step]) {
      this._confirmed.set(step, confirmed);
    }
    if (this._ended || this._gone) {
      return;
    }

    const next = SvalFirstRunModel.next(step, this._answers, this._facts);
    if (next === STEPS.welcome) {
      await this._end("done");
      return;
    }
    this._show(next);
  },

  _back() {
    if (this._busy || this._ended) {
      return;
    }
    // Back from the backup is the code step, where it was offered.
    if (this._step === STEPS.joinBackup) {
      this._join = "idle";
      this._problem = null;
      this._joinLine("");
      this._status("");
      this._answers.joinWith = "code";
      this._show(STEPS.joinCode);
      return;
    }
    if (this._step === STEPS.joinCode) {
      this._stopLooking();
      if (this._join !== "landed") {
        this._join = "idle";
        this._problem = null;
        this._joinLine("");
        this._stopClaim();
      }
    }
    const back = SvalFirstRunModel.back(this._step, this._answers, this._facts);
    if (back === STEPS.intro) {
      this._frame = STRINGS.intro.frames.length - 1;
    }
    this._show(back);
  },

  /**
   * Skip setup (2026-11-09 spec §2.4). The welcome follows, with the answers
   * continued through kept and Skip setup's for the rest. A joining device
   * whose pairing has not landed has no welcome to show: the dialog closes,
   * and pairing keeps trying in the background (spec §3.2).
   *
   * @param {object} [options]
   * @param {string} [options.report] What Send report… tells the feedback
   *   form, which opens once the dialog has gone, since the dialog would
   *   hold the form out of reach.
   */
  async _skipSetup({ report = null } = {}) {
    if (this._ended || this._gone) {
      return;
    }
    this._stopLooking();
    const welcome = this._answers.path === "new" || this._join === "landed";
    await this._end("later", { welcome: welcome && !report });
    if (!welcome || report) {
      this._close({ report });
    }
  },

  /**
   * Cancel on the code step while it waits: looking stops, and the code is
   * the user's to change again or take Back from. The code given up is left
   * to no one, so Skip setup afterwards claims nothing (spec §3.2).
   */
  _cancelLooking() {
    if (this._join !== "looking") {
      return;
    }
    this._stopLooking();
    this._join = "idle";
    this._problem = null;
    this._joinLine("");
    this._stopClaim();
    this._sync();
    this._in(".sval-fr-code").focus();
  },

  /**
   * Tells the opener the code step's claim is given up, so nothing claims
   * it once the dialog closes.
   */
  _stopClaim() {
    this._actions
      .stopClaim()
      .catch(err =>
        SvalLog.warn(
          `first run: the claim did not stop (${SvalLog.errorName(err)})`
        )
      );
  },

  /**
   * Choose another folder, from wherever a folder's problem offered it: the
   * folder step's picker opens over the step it belongs to.
   */
  async _chooseAnother() {
    this._clearFailedJoin();
    if (this._step === STEPS.joinCode || this._step === STEPS.joinBackup) {
      this._stopLooking();
      this._show(STEPS.joinFolder);
    }
    await this._chooseFolder();
  },

  /** A join that failed is over once another folder is being chosen. */
  _clearFailedJoin() {
    if (this._join === "failed") {
      this._join = "idle";
      this._problem = null;
      this._joinLine("");
    }
  },

  /**
   * Asks for a folder on this computer and keeps it only once Sval can use
   * it.
   */
  async _chooseFolder() {
    await this._takeFolder(
      async () => (await this._actions.chooseFolder())?.path
    );
  },

  /**
   * Keeps the folder `choose` names only once Sval can use it. A `choose`
   * that names none leaves the step as it was; an unusable folder says why
   * in one line (spec §8).
   *
   * @param {Function} choose Resolves to the folder, or to nothing.
   * @param {?string} [root] The folder, when it is known before `choose`
   *   runs: the step shows it is being set up from the start.
   */
  async _takeFolder(choose, root = null) {
    if (this._busy) {
      return;
    }
    const step = this._step;
    // The button that started this, which holding the step's buttons blurs
    // on some platforms: focus goes back to it once they are free.
    const from = document.activeElement;
    this._busy = true;
    this._working = root;
    this._sync();
    try {
      const chosen = await choose();
      if (chosen) {
        this._working = chosen;
        this._sync();
        await this._useFolder(chosen);
      }
    } catch (err) {
      SvalLog.warn(
        `first run: choosing a folder failed (${SvalLog.errorName(err)})`
      );
      this._status(STRINGS.problems.bug.text, step, "warn", "bug");
    } finally {
      this._busy = false;
      this._working = null;
      if (!this._gone && this._step === step) {
        this._sync();
        const lost =
          !document.activeElement || document.activeElement === document.body;
        if (lost && from?.isConnected && !from.disabled) {
          from.focus();
        }
      }
    }
  },

  /**
   * @param {string} root A folder being set up.
   * @returns {string} where the busy line says sync is being set up.
   */
  _workingPlace(root) {
    if (parseDropboxRoot(root)) {
      return "Dropbox";
    }
    return isRemoteRoot(root) ? "the SMB server" : "this folder";
  },

  /**
   * Shows the SMB or Dropbox panel in the folder zone's place, with the
   * Keychain's warning on a Mac whose secrets the system store keeps or
   * will, and focus on `focus`.
   *
   * @param {string} which `smb` or `dropbox`.
   * @param {Element} [focus] What takes focus; the panel's first control
   *   otherwise.
   */
  async _openConnect(which, focus = null) {
    const section = this._section(STEPS.joinFolder);
    const panel = section.querySelector(`.sval-fr-${which}`);
    section.dataset.connecting = which;
    panel.hidden = false;
    this._sync();
    (focus ?? panel.querySelector(":is(input, button):not(:disabled)")).focus();
    const asks = await this._actions.keychainAsks().catch(() => false);
    if (section.dataset.connecting === which) {
      panel.querySelector(".sval-fr-keychain").hidden = !asks;
    }
  },

  /**
   * Puts the folder zone back in place of the panel open, with focus on the
   * button that opened it.
   */
  _closeConnect() {
    const section = this._section(STEPS.joinFolder);
    const which = section.dataset.connecting;
    if (!which) {
      return;
    }
    delete section.dataset.connecting;
    section.querySelector(`.sval-fr-${which}`).hidden = true;
    this._dropbox = null;
    section.querySelector(`.sval-fr-connect-${which}`).focus();
  },

  /**
   * Asks where a folder on an SMB server is, and the sign-in for it, filled
   * in with the folder chosen when it is one.
   */
  _openSmb() {
    if (this._busy) {
      return;
    }
    this._clearFailedJoin();
    const panel = this._in(".sval-fr-smb", STEPS.joinFolder);
    const field = name => panel.querySelector(`input[name="${name}"]`);
    const current = parseSmbRoot(this._answers.folder);
    let server = current?.host ?? "";
    if (current && current.port !== 445) {
      server += `:${current.port}`;
    }
    field("host").value = server;
    field("share").value = current?.share ?? "";
    field("folder").value = current?.folder ?? "";
    field("user").value = current?.username ?? "";
    field("password").value = "";
    this._openConnect("smb", current ? field("password") : field("host"));
  },

  /**
   * Keeps the password the SMB panel was given, and uses the folder it
   * names.
   */
  async _connectSmb() {
    const panel = this._in(".sval-fr-smb", STEPS.joinFolder);
    const field = name => panel.querySelector(`input[name="${name}"]`);
    const root = smbRoot({
      server: field("host").value,
      share: field("share").value,
      folder: field("folder").value,
      username: field("user").value,
    });
    if (!root) {
      field("host").focus();
      return;
    }
    const password = field("password").value;
    field("password").value = "";
    this._closeConnect();
    await this._takeFolder(() => this._keepSignIn(root, { password }), root);
  },

  /**
   * Keeps a folder's sign-in, saying in the step's line when it cannot.
   *
   * @param {string} root The SMB or Dropbox folder.
   * @param {object} auth Its sign-in (`SvalRemoteFolder.keepSignIn`).
   * @returns {Promise<?string>} `root` once its sign-in is kept, or null.
   */
  async _keepSignIn(root, auth) {
    try {
      await this._actions.keepSignIn(root, auth);
      return root;
    } catch (err) {
      SvalLog.warn(
        `first run: keeping a sign-in failed (${SvalLog.errorName(err)})`
      );
      const words = parseDropboxRoot(root) ? STRINGS.dropbox : STRINGS.smb;
      this._status(words.notKept, STEPS.joinFolder, "warn", "sign-in-not-kept");
      return null;
    }
  },

  /**
   * Opens the Dropbox panel at the Dropbox folder chosen, signed in as it
   * is, or signs in to Dropbox first and opens it at the Dropbox's root.
   */
  async _chooseDropbox() {
    if (this._busy) {
      return;
    }
    this._clearFailedJoin();
    const chosen = this._answers.folder;
    const current = parseDropboxRoot(chosen);
    const kept = current
      ? await this._actions.signInFor(chosen).catch(() => null)
      : null;
    let token = kept?.refreshToken;
    if (!token) {
      token = await this._signInToDropbox();
      if (!token || this._gone || this._step !== STEPS.joinFolder) {
        return;
      }
    }
    this._dropbox = { token, folder: current?.folder ?? "" };
    // Back is disabled at the Dropbox's root before its first wait, so
    // focus goes to the first control that can take it.
    const browsing = this._browseDropbox(this._dropbox.folder);
    this._openConnect("dropbox");
    await browsing;
  },

  /**
   * Signs in to Dropbox in a page of its own (`SvalDropbox`). A sign-in the
   * user gave up says nothing.
   *
   * @returns {Promise<?string>} the refresh token, or null when the user
   *   gave up or Dropbox refused.
   */
  async _signInToDropbox() {
    const button = this._in(".sval-fr-connect-dropbox", STEPS.joinFolder);
    button.disabled = true;
    try {
      return await this._actions.signInToDropbox();
    } catch (err) {
      if (err?.name !== "SignInCancelled") {
        SvalLog.warn(
          `first run: signing in to Dropbox failed (${SvalLog.errorName(err)})`
        );
        this._status(
          STRINGS.dropbox.signInFailed,
          STEPS.joinFolder,
          "warn",
          "dropbox-sign-in"
        );
      }
      return null;
    } finally {
      button.disabled = false;
    }
  },

  /**
   * Shows the folders in `folder` of the user's Dropbox. A token Dropbox no
   * longer accepts is replaced by signing in again.
   *
   * @param {string} folder `/`-separated, empty for the Dropbox's root.
   */
  async _browseDropbox(folder) {
    const state = this._dropbox;
    if (!state) {
      return;
    }
    const words = STRINGS.dropbox;
    const panel = this._in(".sval-fr-dropbox", STEPS.joinFolder);
    const list = panel.querySelector(".sval-fr-dropbox-folders");
    const status = panel.querySelector(".sval-fr-dropbox-status");
    const use = panel.querySelector(".sval-fr-dropbox-use");
    state.folder = folder;
    const root = dropboxRoot(folder);
    panel.querySelector(".sval-fr-dropbox-place").textContent =
      remoteFolderPlace(root);
    panel.querySelector(".sval-fr-dropbox-up").disabled = !folder;
    use.disabled = true;
    list.replaceChildren();
    status.textContent = words.loading;
    status.dataset.said = "loading";
    let answer = await this._actions.listDropboxFolders(root, state.token);
    if (answer.error === "SignInError" && this._dropbox === state) {
      const token = await this._signInToDropbox();
      if (!token) {
        if (this._dropbox === state) {
          this._closeConnect();
        }
        return;
      }
      state.token = token;
      answer = await this._actions.listDropboxFolders(root, state.token);
    }
    // A later click, or a closed panel, has moved on from this listing.
    if (this._gone || this._dropbox !== state || state.folder !== folder) {
      return;
    }
    if (!answer.reachable) {
      const refused = answer.error === "SignInError";
      status.textContent = refused ? words.signInRefused : words.unreachable;
      status.dataset.said = refused ? "sign-in" : "unreachable";
      return;
    }
    status.textContent = answer.folders.length ? "" : words.empty;
    status.dataset.said = answer.folders.length ? "" : "empty";
    for (const name of answer.folders) {
      const open = this._button("dropbox-folder", "");
      open.dataset.name = name;
      open.append(this._glyph("folder"), name);
      const row = this._element("li");
      row.append(open);
      list.append(row);
    }
    use.disabled = false;
  },

  /** Keeps the Dropbox sign-in for the folder shown, and uses the folder. */
  async _useDropboxFolder() {
    const state = this._dropbox;
    if (!state) {
      return;
    }
    const root = dropboxRoot(state.folder);
    this._closeConnect();
    await this._takeFolder(
      () => this._keepSignIn(root, { refreshToken: state.token }),
      root
    );
  },

  /** A join that cannot work here goes back to I'm new to Sval. */
  _startNewInstead() {
    this._join = "idle";
    this._choosePath("new");
    this._show(
      SvalFirstRunModel.next(STEPS.question, this._answers, this._facts)
    );
  },

  /**
   * The line for a folder or join that failed: the folder's problem when a
   * pass named one, and Sval's own fault otherwise.
   *
   * @param {?object} result `useFolder`'s or `adopt`'s answer.
   * @returns {string} a key of `STRINGS.problems`.
   */
  _problemOf(result) {
    if (result?.failure && result.failure !== "folder") {
      return "bug";
    }
    const problem = result?.problem;
    if (problem && problem in STRINGS.problems && problem !== "bug") {
      return problem;
    }
    return result?.failure === "folder" || result?.unreachable
      ? "offline"
      : "bug";
  },

  /**
   * Has the panel set up `path` as the folder the other device uses, and
   * keeps it only once Sval can use it, saying in one line why not
   * otherwise (spec §8).
   *
   * @param {string} path The folder.
   */
  async _useFolder(path) {
    const step = STEPS.joinFolder;
    const used = await this._actions.useFolder(path);
    if (!used?.reached) {
      const problem = this._problemOf(used);
      this._status(STRINGS.problems[problem].text, step, "warn", problem);
      return;
    }
    this._answers.folder = path;
    this._status("", step);
    await this._recover();
  },

  /**
   * Looks in the chosen folder for this user's own key, which a reinstall on
   * the same machine finds (decision 0084). A key found there is adopted as a
   * claimed code's would be, and the code step is skipped; otherwise the
   * flow asks for a code.
   */
  async _recover() {
    if (["adopting", "landed"].includes(this._join)) {
      return;
    }
    if ((await this._findKey()) && !this._gone) {
      // Not awaited: the folder step shows the adoption as it goes.
      this._adopt();
    }
  },

  /**
   * Asks the panel for this user's key in the folder, and records whether
   * there is one: a found key skips the code step (`SvalFirstRunModel`).
   *
   * @returns {Promise<boolean>} whether a key was found.
   */
  async _findKey() {
    let found = false;
    try {
      found = !!(await this._actions.recoverKey())?.found;
    } catch (err) {
      SvalLog.warn(
        `first run: looking for a key failed (${SvalLog.errorName(err)})`
      );
    }
    if (!this._gone) {
      this._facts.keyRecovered = found;
    }
    return found;
  },

  /** @returns {string} the step a join is shown on, as the key came. */
  _joinStep() {
    return this._facts.keyRecovered ? STEPS.joinFolder : this._keyStep();
  },

  /** @returns {string} the step that takes the key: a code or a backup. */
  _keyStep() {
    return this._answers.joinWith === "backup"
      ? STEPS.joinBackup
      : STEPS.joinCode;
  },

  /**
   * Writes the join line of the step that takes the key, which a status
   * region reads out.
   *
   * @param {string} text
   * @param {string} [said] What it says, as its `data-said`: a key of
   *   `STRINGS.problems`, or the join's state.
   */
  _joinLine(text, said = "") {
    const step = this._keyStep();
    const line = this._in(".sval-fr-join", step);
    line.textContent = text;
    line.dataset.said = text ? said : "";
    if (step === STEPS.joinCode) {
      this._in(".sval-fr-note", step).textContent = "";
    }
  },

  /**
   * Shows the problem a join stopped on, and remembers what Try again
   * repeats.
   *
   * @param {string} retry `look`, `adopt` or `restore`; see `_retry`.
   * @param {string} problem A key of `STRINGS.problems`.
   */
  _fail(retry, problem) {
    this._join = "failed";
    this._retry = retry;
    this._problem = problem;
    const step = this._joinStep();
    const text = STRINGS.problems[problem].text;
    if (step === STEPS.joinFolder) {
      this._status(text, step, "warn", problem);
    } else {
      this._joinLine(text, problem);
    }
    this._syncIfShown(step);
  },

  /**
   * Repeats the join that failed, in place, with the same folder and code:
   * the user may have fixed the cause meanwhile, for example by reconnecting
   * a drive.
   */
  async _tryAgain() {
    if (this._busy || this._join !== "failed" || this._ended) {
      return;
    }
    const retry = this._retry;
    // Try again goes as the join restarts, so focus waits on the heading.
    if (document.activeElement === this._in(".sval-fr-retry")) {
      this._in("h1").focus();
    }
    this._problem = null;
    switch (retry) {
      case "look":
        this._startLooking();
        break;
      case "adopt":
        await this._adopt();
        break;
      case "restore":
        await this._restore();
        break;
    }
  },

  /**
   * The code step's way to the backup, for a user with no other device to
   * show a code. A code being looked for is given up.
   */
  _useBackup() {
    if (this._busy || ["adopting", "landed"].includes(this._join)) {
      return;
    }
    this._stopLooking();
    this._join = "idle";
    this._problem = null;
    this._joinLine("");
    this._status("", STEPS.joinCode);
    this._stopClaim();
    this._answers.joinWith = "backup";
    this._show(STEPS.joinBackup);
  },

  /**
   * Takes the sync key back from the typed backup through the panel, which
   * restores it as Settings does. A key the folder's workspaces refuse is
   * said under the field, to be typed again; a join that failed shows its
   * problem as a claimed code's does.
   */
  async _restore() {
    const step = STEPS.joinBackup;
    const text = this._in(".sval-fr-code", step).value;
    this._join = "adopting";
    this._problem = null;
    this._status("", step);
    this._joinLine(STRINGS.adopting, "adopting");
    this._syncIfShown(step);
    let result;
    try {
      result = await this._actions.restore(text);
    } catch (err) {
      SvalLog.warn(`first run: restoring failed (${SvalLog.errorName(err)})`);
      result = null;
    }
    if (this._gone) {
      return;
    }
    if (result?.refused) {
      this._join = "idle";
      this._joinLine("");
      this._syncIfShown(step);
      this._status(result.message, step, "warn", result.refused);
      this._in(".sval-fr-code", step).focus();
      return;
    }
    if (!result?.restored) {
      this._failure = result?.failure ?? "throw";
      this._fail("restore", this._problemOf(result ?? { failure: "throw" }));
      return;
    }
    await this._presetSyncedSearch();
    if (this._gone) {
      return;
    }
    this._joinLine(STRINGS.joined, "joined");
    this._join = "landed";
    this._syncIfShown(step);
  },

  /**
   * Opens Kagi's sign-in, where an account can also be made, in a window of
   * its own over the dialog, and follows it: the notice says where to sign
   * in, with Open Again for a window closed by mistake, then that it is done.
   * A window closed unsigned leaves the sign-in for the end of the flow, in a
   * tab.
   */
  async _signInToKagi() {
    const words = STRINGS.steps.search;
    const asked = ++this._kagiAsks;
    this._kagiNote(words.kagiOpen, words.kagiOpenAgain);
    let signedIn = false;
    try {
      ({ signedIn } = await this._actions.signInToKagi(SvalKagi.SIGNIN_URL));
    } catch (err) {
      SvalLog.warn(
        `first run: Kagi's sign-in did not open (${SvalLog.errorName(err)})`
      );
    }
    // Open Again closes the window this call opened; the later call says
    // what follows.
    if (this._gone || asked !== this._kagiAsks) {
      return;
    }
    this._kagiSignedIn = !!signedIn;
    this._kagiNote();
    this._syncIfShown(STEPS.search);
  },

  /** Learns whether a normal window is already signed in to Kagi. */
  async _checkKagi() {
    try {
      this._kagiSignedIn = !!(await this._actions.kagiSignedIn?.());
    } catch (err) {
      SvalLog.warn(
        `first run: Kagi's sign-in was not read (${SvalLog.errorName(err)})`
      );
    }
    if (!this._gone) {
      this._kagiNote();
      this._syncIfShown(STEPS.search);
    }
  },

  /**
   * Writes the Kagi notice's line and its button, in place of their own,
   * since the sheet keeps one size.
   *
   * @param {string} [text] What to say; otherwise what the sign-in state says.
   * @param {string} [label] The button's words; otherwise Sign in.
   */
  _kagiNote(text, label) {
    const words = STRINGS.steps.search;
    const notice = this._in(".sval-fr-kagi", STEPS.search);
    notice.dataset.tone = this._kagiSignedIn ? "ok" : "info";
    let state = "needs-account";
    if (text) {
      state = "opened";
    } else if (this._kagiSignedIn) {
      state = "signed-in";
    }
    notice.dataset.state = state;
    notice.querySelector(".sval-fr-kagi-then").textContent =
      text ?? (this._kagiSignedIn ? words.kagiSignedIn : words.kagi);
    notice.querySelector(".sval-fr-kagi-signin").textContent =
      label ?? words.kagiSignIn;
  },

  /**
   * Looks for the other device's offer until it is claimed, the code is
   * refused, or looking stops.
   *
   * `waiting` is not a failure: nothing has arrived yet, and the code may be
   * good, so only `no-match` is reported as a wrong code (spec §3.2). The
   * line names the service that carries the folder, when Sval knows it.
   */
  _startLooking() {
    this._stopLooking();
    this._join = "looking";
    this._problem = null;
    this._status("", STEPS.joinCode);
    const folder = this._answers.folder ?? "";
    // Sval reads and writes an SMB or Dropbox folder itself, so no service
    // on this computer has a copy to catch up.
    const service = isRemoteRoot(folder) ? null : cloudServiceOf(folder);
    this._joinLine(STRINGS.waitingFor(service), "waiting");
    this._sync();
    this._noteTimer = window.setTimeout(() => {
      this._noteTimer = null;
      if (this._claims.looking) {
        this._in(".sval-fr-note", STEPS.joinCode).textContent =
          STRINGS.waitingNote(service, this._folderName(folder));
      }
    }, FIRST_RUN_NOTE_AFTER_MS);
    this._claims.start(
      () => this._actions.claim(this._code),
      answer => this._answered(answer)
    );
  },

  _stopLooking() {
    this._claims?.stop();
    if (this._noteTimer !== null) {
      window.clearTimeout(this._noteTimer);
      this._noteTimer = null;
    }
  },

  /** @param {object} answer A `SvalPairingLook` answer. */
  async _answered(answer) {
    if (this._gone || answer.status === "waiting") {
      return;
    }
    this._stopLooking();
    switch (answer.status) {
      case "claimed":
        await this._adopt();
        return;
      case "no-match":
        this._join = "idle";
        this._joinLine("");
        this._show(STEPS.joinCode);
        this._status(STRINGS.codeWrong, this._step, "warn", "code-wrong");
        this._in(".sval-fr-code").focus();
        return;
      case "failed":
        SvalLog.warn(
          `first run: claiming failed (${SvalLog.errorName(answer.error)})`
        );
        this._fail("look", "offline");
    }
  },

  /**
   * Hands the claimed or found key to the panel and shows how it went, in
   * the page's words, which name the folder's problem when the join says
   * one.
   */
  async _adopt() {
    // A key found in the folder opens the workspaces on the folder step; a
    // claimed code's key does it on the code step.
    const step = this._joinStep();
    this._join = "adopting";
    if (step === STEPS.joinCode) {
      this._joinLine(STRINGS.adopting, "adopting");
    } else {
      this._status(STRINGS.adopting, step, "info", "adopting");
    }
    this._syncIfShown(step);
    let adopted;
    try {
      adopted = await this._actions.adopt();
    } catch (err) {
      SvalLog.warn(`first run: adopting failed (${SvalLog.errorName(err)})`);
      adopted = null;
    }
    if (this._gone) {
      return;
    }
    if (!adopted || adopted.outcome === "unchanged") {
      // The failure is reported by what the panel names alone; the code
      // step cannot fix a key that is already right.
      this._failure = adopted?.failure ?? "throw";
      this._fail("adopt", this._problemOf(adopted ?? { failure: "throw" }));
      return;
    }
    await this._presetSyncedSearch();
    if (this._gone) {
      return;
    }
    if (step === STEPS.joinCode) {
      this._joinLine(STRINGS.joined, "joined");
    } else {
      this._status(STRINGS.joined, step, "ok", "joined");
    }
    this._join = "landed";
    this._syncIfShown(step);
  },

  /**
   * Presets the search step to the engine the workspaces use, which pairing
   * brought, for a joining device to review. An engine sync has not brought
   * yet leaves the preset as it was.
   */
  async _presetSyncedSearch() {
    let engine = null;
    try {
      engine = await this._actions.syncedSearch?.();
    } catch (err) {
      SvalLog.warn(
        `first run: the synced engine was not read (${SvalLog.errorName(err)})`
      );
    }
    if (engine && !this._gone) {
      this._facts.syncedSearch = engine;
      this._answers.search = engine;
    }
  },

  _syncIfShown(step) {
    if (this._step === step) {
      this._sync();
    }
  },

  /**
   * The answers the dialog reports. `done` reports them as they stand.
   * `later` reports Skip setup's, with what an interrupted run applied and
   * each step continued through keeping its answer from its Continue. On
   * the join path neither carries `search` or `adblock`: those arrive with
   * pairing, and first run never writes them there (spec §3.2).
   *
   * @param {string} outcome `done` or `later`.
   * @returns {{answers: object, completed: string[]}}
   */
  _report(outcome) {
    const completed = [...this._confirmed.keys()];
    let answers;
    if (outcome === "done") {
      answers = this._copy();
    } else {
      answers = {
        ...SvalFirstRunModel.setUpLaterAnswers(this._copy()),
        ...this._earlier,
      };
      // The question chose the path, which is no step's answer.
      answers.path = this._answers.path;
      for (const confirmed of this._confirmed.values()) {
        Object.assign(answers, confirmed);
      }
    }
    if (answers.path === "join") {
      delete answers.search;
      delete answers.adblock;
    }
    return { answers, completed };
  },

  /**
   * Ends the flow (2026-11-09 spec §4): the opener applies what is left and,
   * on the new path, makes the first workspace, and the welcome shows, with
   * the import running under the card. A step being applied as the user
   * leaves is waited for, for a bounded time, so the report says whether it
   * was.
   *
   * @param {string} outcome `done` or `later`.
   * @param {object} [options]
   * @param {boolean} [options.welcome] Whether the welcome follows.
   */
  async _end(outcome, { welcome = true } = {}) {
    if (this._ended) {
      return;
    }
    this._ended = outcome;
    if (this._applying) {
      await raceTimeout(
        this._applying.catch(() => {}),
        FIRST_RUN_APPLY_WAIT_MS,
        window
      );
    }
    let importing = false;
    try {
      ({ importing } = await this._actions.end({
        outcome,
        ...this._report(outcome),
      }));
    } catch (err) {
      SvalLog.warn(`first run's end failed (${SvalLog.errorName(err)})`);
    }
    if (this._gone || !welcome) {
      return;
    }
    await this._showWelcome(importing);
  },

  /**
   * Shows the welcome: the card, as it stands once the import's Arc card has
   * been taken, and the import running under it.
   *
   * @param {boolean} importing Whether an import is to run.
   */
  async _showWelcome(importing) {
    const section = this._section(STEPS.welcome);
    const words = STRINGS.steps.welcome;
    const card = readCard();
    let variant = "new";
    if (this._answers.path === "join") {
      variant = "synced";
    } else if (card?.arc) {
      variant = "arc";
    }
    section.dataset.card = variant;
    section.dataset.path = this._answers.path;
    section.querySelector("h1").textContent = card
      ? words.heading(card.title)
      : STRINGS.title;
    section.querySelector(".sval-fr-body").textContent = words.cards[variant];
    section.querySelector(".sval-fr-sync-text").textContent =
      words.sync[this._answers.path];
    section.querySelector(".sval-fr-set-up-sync").hidden =
      this._answers.path !== "new";
    if (importing) {
      this._import = {
        items: this._plan().map(entry => ({
          entry,
          state: "running",
          kind: null,
        })),
        report: { workspaces: [], tabs: 0, favorites: 0, history: 0 },
        // Start browsing waits from the welcome's first showing.
        running: true,
      };
    }
    this._show(STEPS.welcome);
    if (card) {
      try {
        const box = await renderCard(document, card, { reveal: true });
        if (!this._gone) {
          section.querySelector(".sval-fr-card-slot").append(box);
        }
      } catch (err) {
        SvalLog.warn(
          `first run: the card could not be drawn (${SvalLog.errorName(err)})`
        );
      }
    }
    if (importing) {
      await this._runImport(this._import.items);
    }
  },

  /** @returns {object[]} the import plan the import step's Continue kept. */
  _plan() {
    return (
      this._confirmed.get(STEPS.import)?.importPlan ??
      this._answers.importPlan ??
      []
    );
  },

  /**
   * Runs `items`' entries through the opener, stepping the row on as each
   * browser finishes (`runImport`'s per-source progress), then shows what
   * arrived, or the import page's own lines for what failed. Start browsing
   * waits for it (2026-11-09 spec §3.7).
   *
   * @param {object[]} items
   */
  async _runImport(items) {
    const imp = this._import;
    imp.running = true;
    for (const item of items) {
      item.state = "running";
    }
    this._syncIfShown(STEPS.welcome);
    let report = null;
    try {
      report = await this._actions.runImport(
        items.map(item => item.entry),
        progress => {
          const item = items[progress.done - 1];
          if (item) {
            item.kind = progress.kind;
            item.error = progress.error;
            item.state = progress.ok ? "done" : "failed";
          }
          if (!this._gone) {
            this._syncIfShown(STEPS.welcome);
          }
        }
      );
    } catch (err) {
      SvalLog.error(
        `first run: the import stopped (${SvalLog.errorName(err)})`
      );
      // The run stopped short: what it did not finish did not arrive.
      for (const item of items) {
        if (item.state === "running") {
          item.kind = importFailureKind(err);
          item.error = err?.name ?? "Error";
          item.state = "failed";
        }
      }
    }
    if (report) {
      imp.report.workspaces.push(...report.workspaces);
      imp.report.tabs += report.tabs;
      imp.report.favorites += report.favorites;
      imp.report.history += report.history;
    }
    imp.running = false;
    if (this._gone) {
      return;
    }
    this._syncIfShown(STEPS.welcome);
    if (this._step === STEPS.welcome) {
      this._focusStep();
    }
  },

  /**
   * Acts on a failed import line's button, as the import page does.
   *
   * @param {string} command
   * @param {Element} button
   * @param {object} item
   */
  async _importAct(command, button, item) {
    if (this._import.running) {
      return;
    }
    switch (command) {
      case "retrySource":
        await this._runImport([item]);
        return;
      case "importBookmarksFile":
        await this._importFile();
        return;
      case "sendReport":
        this._close({ report: SvalImportPicker.reportContext(item) });
    }
  },

  /**
   * Asks for a bookmarks file and imports it to Favorites, where a picker
   * row's bookmarks go unless the user chooses otherwise.
   */
  async _importFile() {
    const path = await SvalImportPicker.pickBookmarksFile(window);
    if (!path || this._gone) {
      return;
    }
    const { browser, bookmarksName } = SvalImportPicker.fileBrowser(path);
    const entry = {
      browser,
      harvest: null,
      windows: [],
      bookmarks: BOOKMARKS_TO.favorites,
      bookmarksName,
      history: false,
      autoArchive: null,
    };
    const item = { entry, state: "running", kind: null };
    this._import.items.push(item);
    try {
      entry.harvest = await harvestBrowser(browser);
    } catch (err) {
      SvalLog.warn(
        `first run: a bookmarks file failed (${SvalLog.errorName(err)})`
      );
      item.kind = importFailureKind(err);
      item.error = err?.name ?? "Error";
      item.state = "failed";
      this._syncIfShown(STEPS.welcome);
      return;
    }
    await this._runImport([item]);
  },

  /**
   * Draws the welcome's import row and Start browsing from the import as it
   * stands: the browsers' logos and the one being brought in; then what
   * arrived, or, when something failed, the import page's result lines.
   *
   * @param {Element} section The welcome's section.
   */
  _syncWelcome(section) {
    const row = section.querySelector(".sval-fr-import");
    const start = section.querySelector(".sval-fr-start");
    const imp = this._import;
    row.hidden = !imp;
    start.disabled = !!imp?.running;
    if (!imp) {
      return;
    }
    const words = STRINGS.steps.welcome;
    const { items } = imp;
    const names = items.map(item => SvalImportPicker.entryName(item.entry));
    const logos = row.querySelector(".sval-fr-import-logos");
    if (logos.childElementCount !== items.length) {
      logos.replaceChildren(
        ...items.map(item =>
          SvalImportPicker.logo(
            document,
            item.entry.browser.source,
            "sval-fr-import-logo"
          )
        )
      );
    }
    const finished = items.filter(item => item.state !== "running").length;
    const failed = items.some(item => item.state === "failed");
    let state = "running";
    if (!imp.running) {
      state = failed ? "failed" : "done";
    }
    row.dataset.state = state;
    row
      .querySelector(".sval-fr-import-bar")
      .style.setProperty(
        "--sval-fr-share",
        String(items.length ? finished / items.length : 1)
      );
    const text = row.querySelector(".sval-fr-import-text");
    const result = row.querySelector(".sval-fr-import-result");
    if (state === "running") {
      const current = items.findIndex(item => item.state === "running");
      text.textContent = words.importing(names[Math.max(current, 0)]);
      result.replaceChildren();
    } else if (state === "done") {
      text.textContent = words.imported(
        new Intl.ListFormat("en", { type: "conjunction" }).format(names)
      );
      result.replaceChildren();
    } else {
      text.textContent = "";
      result.replaceChildren(
        ...SvalImportPicker.resultLines(
          document,
          items,
          imp.report,
          (command, button, item) => this._importAct(command, button, item)
        )
      );
    }
  },

  /**
   * Set up sync: the dialog closes and the opener opens Settings › Sync and
   * devices, which chooses the folder (2026-11-09 spec §3.7).
   */
  async _setUpSync() {
    try {
      await this._actions.openSyncSettings();
    } catch (err) {
      SvalLog.warn(
        `first run: Sync settings were not asked for (${SvalLog.errorName(err)})`
      );
    }
    this._close();
  },

  /**
   * Answers and closes the dialog, once the flow has ended.
   *
   * @param {object} [options]
   * @param {string} [options.report] What Send report… tells the feedback
   *   form, which the opener opens once the dialog has gone.
   */
  _close({ report = null } = {}) {
    if (this._finishing) {
      return;
    }
    this._finishing = true;
    const outcome = this._ended ?? "later";
    const { answers, completed } = this._report(outcome);
    // With Kagi chosen, its sign-in opens as the flow ends unless the user is
    // signed in already (spec §5).
    const kagi =
      answers.search === "kagi" && completed.includes(STEPS.search)
        ? { page: outcome === "done" && !this._kagiSignedIn ? "signIn" : null }
        : null;
    this._args.result = { outcome, answers, completed, kagi, report };
    window.close();
  },
};

// Not `defer`: a chrome page served as XHTML runs its scripts as the parser
// reaches them, so this script runs before the body exists.
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => SvalFirstRunPage.start(), {
    once: true,
  });
} else {
  SvalFirstRunPage.start();
}
