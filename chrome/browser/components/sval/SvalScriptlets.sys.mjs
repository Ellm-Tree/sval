/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The scriptlet library that `##+js(...)` rules call (protections spec §5.3).
 *
 * The library is uBlock Origin's scriptlets alone: Sval ships none. They are
 * GPL-3.0 and never enter Sval's tree. Sval fetches them from uBlock Origin's
 * own repository as data, at the one commit `UBO_PIN` names, and uses them
 * only when every file matches the SHA-256 the pin records. Scriptlets run as
 * code in every page, so nothing that Sval has not reviewed may run, and
 * moving the pin is a change to Sval. A rule that names a scriptlet the
 * library lacks injects nothing and reports nothing: adblock-rust's
 * `ResourceStorage::get_scriptlet_resources` drops it.
 *
 * uBlock Origin keeps its scriptlets as ES modules that register each
 * scriptlet's function. Brave builds its library from them by importing
 * `scriptlets.js` and serializing each registered function with its
 * dependencies; Sval does the same at runtime, in a sandbox with a null
 * principal, because Gecko evaluates no ES module in a sandbox.
 * `moduleScript` turns each module into a function that its importers call,
 * which is exact for the pinned files: they have no import cycle and use only
 * named imports and declaration exports, and anything else is refused.
 *
 * The download goes through the blocking lists' `download`, and like a
 * list it happens only while the blocking level uses lists, page rules are
 * on, and list updates are on, which test profiles turn off.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalScope } from "moz-src:///browser/components/sval/SvalScope.sys.mjs";
import {
  ALLOWED_DOMAINS_LIST,
  download,
  SvalBlockingLists,
  ENGINE_LISTS_PREF,
  UPDATES_PREF,
} from "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs";
import {
  SvalPageRules,
  PAGE_RULES_PREF,
} from "moz-src:///browser/components/sval/SvalPageRules.sys.mjs";
import { sha256Hex } from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/**
 * uBlock Origin 1.75.0. Each file's SHA-256 is of its bytes at the commit, as
 * `curl -s <base><commit>/<path> | shasum -a 256` prints it. The files are
 * `scriptlets.js` and every module it imports, directly or not.
 */
export const UBO_PIN = Object.freeze({
  base: "https://raw.githubusercontent.com/gorhill/uBlock/",
  commit: "21f0e686506bb21b514b451c8c6cb9bf8c82d232",
  files: Object.freeze({
    "src/js/arglist-parser.js":
      "57dbdf89705f59d79bb20189c8b1c784ea4105323d0bcd07eec74e818cc8c106",
    "src/js/jsonpath.js":
      "e540f29cc99c4c27a86711ad2ad2d61a4640c445595b97cf27160563acfc82db",
    "src/js/resources/abort-current-script.js":
      "820b2234576b91a7d71b8ff380a03d604a561a83a0ad7334900d146b616e380d",
    "src/js/resources/attribute.js":
      "c8cfbf5f44baa8d80f8150218540d50fce0a6d4f65823ec15648ae105603a90e",
    "src/js/resources/base.js":
      "5eb0f5c20866149f99537e64959c51c466f9b43cd4fde1682ae0534a4096a4b8",
    "src/js/resources/cookie.js":
      "31cf19e9dd0f6e5c957e9e952647e1bc7094ff603303924625c3c530a009a315",
    "src/js/resources/create-html.js":
      "0d8025aa3748395c6d0c7bd1b7487a2d2d8b1632e109b509576341cb7254fedf",
    "src/js/resources/href-sanitizer.js":
      "b17df68062d8d87240c970763c10e891224961759b6178cb7c58e1ade2ed7bfc",
    "src/js/resources/json-edit.js":
      "cff39a24d2ae6311bbd769785dd56bddecdb0e2a7d80a7e64d2b33869a03a1b7",
    "src/js/resources/json-prune.js":
      "e4f13cc99cb4ae8428de4889135ed5f62e30f02c397f3f5f4b2941189bd76ced",
    "src/js/resources/localstorage.js":
      "ea2ebb44b8189fb4c98e08a86c2ac6afde781c6b3d6af03195b8fcaeaef89ced",
    "src/js/resources/noeval.js":
      "0b42472114120bd586410d0bbfd912c198de1abb0b3b62d11183ff6b893e5731",
    "src/js/resources/object-prune.js":
      "fc68ac88bcadc6774c0a1a3d87b142a9062d804dc5f0f87bb18a7d48c690d135",
    "src/js/resources/parse-replace.js":
      "fca20f23d68dfc906a02838330e26d1123dce48fcdaa086b37dba5c0d5b38e57",
    "src/js/resources/prevent-addeventlistener.js":
      "ce919028953e4cb4a49db61e0649d475ccab7b3cf150c77aeb001305a384b8c8",
    "src/js/resources/prevent-bab.js":
      "ef5762c46a193211b335e0cb2ea439865cb98cb9cd4df8a90b159ddd35a66094",
    "src/js/resources/prevent-clipboard-write.js":
      "c16b573b6d91438ff0d16db9fcc336542ad38877e8e11ecfe8fc9e1f118156c1",
    "src/js/resources/prevent-dialog.js":
      "904fcae08eb72ea2e1624650c7e24741fc80f717f8c2438367807fbca195821d",
    "src/js/resources/prevent-fetch.js":
      "46ab941003b999cb506201c786eaf428e78a4c3e519656f45361d7b0a1b6c887",
    "src/js/resources/prevent-innerHTML.js":
      "18719306c7beb87b5f09d5b241cf2ec893638e3fb96a93d2218cbde217bbee2d",
    "src/js/resources/prevent-navigation.js":
      "bd7031b200172aca316b489e4b4e95a52e891b1098b83c483a45f8cf7995ac49",
    "src/js/resources/prevent-settimeout.js":
      "4a5152c4cc9715183bc9e49c4e4e27a87f02b978de89b71c6a1586cc9cc15f95",
    "src/js/resources/prevent-xhr.js":
      "3619684e46f0cfc7a9f48553cc8e8f193c807b61a07e4b9e9a7ff043c242d9bf",
    "src/js/resources/proxy-apply.js":
      "7fb12b6e29dcdae0dcaa5709e76271bf6152eb0dfc7e55894ffceb3eafd8a4ca",
    "src/js/resources/replace-argument.js":
      "667a602eee73ced208f9f42a6eba85300a0fb81b6dedbd6abbbc1a974a6cde10",
    "src/js/resources/run-at.js":
      "12daa1b79691095b8ba782b77122ef68923ff2dd1020f3b1b008fc33adf95a6c",
    "src/js/resources/safe-self.js":
      "e7b95af1ff71e4571c62339dc39fd530dce1599da27a887761a4dd25526aa35f",
    "src/js/resources/scriptlets.js":
      "8c414bbfa63fbd7d1e5586d9938f9ba97f4c61d7d1c6050764efd0b76126a215",
    "src/js/resources/set-constant.js":
      "827d8ca244d2fbcdb967592c9247958e9e6eb7ebbe7186d0165015093ced0ab9",
    "src/js/resources/shared.js":
      "26b04fa095d81230f46ac90addf6810a01bbf096f06afd14304dfbb9001995e2",
    "src/js/resources/spoof-css.js":
      "dd30b098802b23ef0b46c62d9242c0af49997a6d66afac54493791d7fbcee225",
    "src/js/resources/stack-trace.js":
      "7a912904f5816f09605cbafa6e40be595e520f96eeb8e267e4f628f29a9767db",
    "src/js/resources/utils.js":
      "17b876f443cbf999cfaef3c4f610f46d5e7ea719c8516aea8473c739d02e3fda",
    "src/js/resources/vod.js":
      "8de2a299d79f51336ebaa5ac66c2c8f73e0ca34dfe562e1e18da557d0b594899",
    "src/js/urlskip.js":
      "1d71ddafee30b70137e603e32c79b5ae65af65e7b71f4b61ae65301d76216d6d",
  }),
});

/** The module whose `builtinScriptlets` lists uBlock Origin's scriptlets. */
const UBO_ENTRY = "src/js/resources/scriptlets.js";

/**
 * The permission bit a uBlock Origin scriptlet marked `requiresTrust` needs:
 * the bit adblock-rust's `PermissionMask` documentation and Brave give uBlock
 * Origin's trusted scriptlets. A list gets it only through its parse options.
 */
const TRUSTED_PERMISSION = 1;

/** The most the pinned files may weigh together. */
const MAX_UBO_BYTES = 4 * 1024 * 1024;
const COPY_NAME = "ubo-scriptlets.json";
/** How long after start, or after lists are turned on, the fetch waits. */
const FETCH_DELAY = [5 * 1000, 30 * 1000];
/** A failed download is tried again after this. */
const RETRY_DELAY = 2 * 60 * 60 * 1000;

const IMPORT_RE = /^import\s*(?:\{([^}]*)\}\s*from\s*)?'([^']+)';?[ \t]*$/gm;
const EXPORT_RE =
  /^export\s+(?:(?:async\s+)?function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;
const IMPORT_NAME_RE = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/;

/**
 * An error whose reason is fixed text, safe for the log.
 *
 * @param {string} reason
 * @returns {Error}
 */
function scriptletError(reason) {
  const err = new Error(reason);
  err.reason = reason;
  return err;
}

/**
 * @param {string} text
 * @returns {string} base64 of the text's UTF-8 bytes.
 */
function base64(text) {
  return new TextEncoder().encode(text).toBase64();
}

/**
 * Whether `files` holds exactly the pinned files, each matching its hash.
 *
 * @param {object} pin As `UBO_PIN`.
 * @param {object} files Path to text.
 * @returns {Promise<boolean>}
 */
async function matchesPin(pin, files) {
  const paths = Object.keys(pin.files);
  if (
    !files ||
    typeof files != "object" ||
    Object.keys(files).length != paths.length
  ) {
    return false;
  }
  for (const path of paths) {
    if (
      typeof files[path] != "string" ||
      (await sha256Hex(files[path])) !== pin.files[path]
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A module path resolved against the module importing it.
 *
 * @param {string} from
 * @param {string} specifier
 * @returns {string}
 */
function resolveModule(from, specifier) {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part == "..") {
      parts.pop();
    } else if (part != ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
}

/**
 * One ES module as a script that defines it as a function of its importer:
 * named imports become bindings from the imported module's exports, and each
 * declaration's `export` is dropped and its name returned.
 *
 * @param {string} path
 * @param {string} text
 * @param {Set<string>} known Every path the library has.
 * @returns {string}
 */
export function moduleScript(path, text, known) {
  const names = [];
  const body = text
    .replace(IMPORT_RE, (line, list, specifier) => {
      const target = resolveModule(path, specifier);
      if (!known.has(target)) {
        throw scriptletError("an import outside the pinned files");
      }
      const call = `__import(${JSON.stringify(target)})`;
      if (list === undefined) {
        return `${call};`;
      }
      const bindings = list
        .split(",")
        .map(name => name.trim())
        .filter(Boolean)
        .map(name => {
          const match = IMPORT_NAME_RE.exec(name);
          if (!match) {
            throw scriptletError("an import sval cannot read");
          }
          return match[2] ? `${match[1]}: ${match[2]}` : match[1];
        });
      return `const { ${bindings.join(", ")} } = ${call};`;
    })
    .replace(EXPORT_RE, (declaration, name) => {
      names.push(name);
      return declaration.replace(/^export\s+/, "");
    });
  if (/^\s*(import|export)\b/m.test(body)) {
    throw scriptletError("a module form sval cannot read");
  }
  return (
    `__modules[${JSON.stringify(path)}] = function (__import) {\n` +
    `"use strict";\n${body}\nreturn { ${names.join(", ")} };\n};\n`
  );
}

/**
 * uBlock Origin's scriptlets as adblock-rust resources, from its verified
 * module files. Each registered scriptlet becomes a resource whose content is
 * its function's source, as Brave builds them; adblock-rust calls a function
 * by name with the rule's arguments, and includes its dependencies.
 *
 * @param {object} files Path to text, verified against the pin.
 * @returns {object[]}
 */
export function convertUbo(files) {
  const known = new Set(Object.keys(files));
  let script =
    "const __modules = {};\nconst __done = {};\n" +
    "function __import(path) {\n" +
    "  if (!(path in __done)) {\n" +
    "    __done[path] = null;\n" +
    "    __done[path] = __modules[path](__import);\n" +
    "  }\n" +
    "  return __done[path];\n}\n";
  for (const [path, text] of Object.entries(files)) {
    script += moduleScript(path, text, known);
  }
  script +=
    `JSON.stringify(__import(${JSON.stringify(UBO_ENTRY)})` +
    ".builtinScriptlets.map(s => ({ name: s.name, aliases: s.aliases," +
    " dependencies: s.dependencies, requiresTrust: s.requiresTrust," +
    " source: s.fn.toString() })));";
  const sandbox = Cu.Sandbox(
    Services.scriptSecurityManager.createNullPrincipal({}),
    { freshCompartment: true, sandboxName: "sval-ubo-scriptlets" }
  );
  let json;
  try {
    // The parent process runs scripts only under a chrome, resource or
    // moz-src name (nsContentSecurityUtils::ValidateScriptFilename).
    json = Cu.evalInSandbox(script, sandbox, "latest", import.meta.url);
  } finally {
    Cu.nukeSandbox(sandbox);
  }
  if (typeof json != "string") {
    throw scriptletError("the scriptlets did not convert");
  }
  const strings = value =>
    Array.isArray(value) ? value.filter(v => typeof v == "string") : [];
  return JSON.parse(json)
    .filter(s => typeof s?.name == "string" && typeof s.source == "string")
    .map(s => {
      const resource = {
        name: s.name,
        aliases: strings(s.aliases),
        // A `.fn` helper is only ever a dependency.
        kind: {
          mime: s.name.endsWith(".fn")
            ? "fn/javascript"
            : "application/javascript",
        },
        content: base64(s.source),
        dependencies: strings(s.dependencies),
      };
      if (s.requiresTrust === true) {
        resource.permission = TRUSTED_PERMISSION;
      }
      return resource;
    });
}

/** Keeps the scriptlet library and hands it to the engines. */
class Scriptlets {
  /** The pin the fetch and the stored copy are checked against. Tests replace it. */
  pin = UBO_PIN;
  #ubo = null;
  #started = false;
  #timer = null;
  #listening = new SvalScope();
  #running = null;

  get #copyPath() {
    return PathUtils.join(SvalBlockingLists.dir, COPY_NAME);
  }

  /**
   * Hands the engines uBlock Origin's scriptlets from the stored copy when it
   * matches the pin; schedules the fetch when it does not.
   */
  async start() {
    if (this.#started) {
      return;
    }
    this.#started = true;
    const schedule = () => this.schedule();
    this.#listening.pref(ENGINE_LISTS_PREF, schedule);
    this.#listening.pref(PAGE_RULES_PREF, schedule);
    this.#listening.pref(UPDATES_PREF, schedule);
    await this.reload();
    this.schedule();
  }

  /** Stops the schedule. */
  stop() {
    this.#listening.end();
    lazy.clearTimeout(this.#timer);
    this.#timer = null;
    this.#started = false;
  }

  /** Whether uBlock Origin's scriptlets are in the library. */
  get hasUbo() {
    return !!this.#ubo;
  }

  /**
   * Reads the stored uBlock Origin copy again, and hands the engines the
   * library. The copy keeps the files and what this
   * build converted them to, so a start of the build that wrote it converts
   * nothing; another build checks the files against the pin and converts them
   * again, since its conversion may differ.
   */
  async reload() {
    this.#ubo = null;
    try {
      const copy = await IOUtils.readJSON(this.#copyPath);
      const ofPin = copy?.commit === this.pin.commit;
      if (
        ofPin &&
        copy.build === Services.appinfo.appBuildID &&
        Array.isArray(copy.resources) &&
        copy.resources.length
      ) {
        this.#ubo = copy.resources;
      } else if (ofPin && (await matchesPin(this.pin, copy.files))) {
        this.#ubo = convertUbo(copy.files);
        await this.#store(copy.files).catch(err =>
          SvalLog.warn(
            `the converted scriptlets were not stored: ${SvalLog.errorName(err)}`
          )
        );
      }
    } catch (err) {
      if (err?.name != "NotFoundError") {
        SvalLog.warn(
          `the stored uBlock Origin scriptlets were not used: ${err?.reason ?? err?.name}`
        );
      }
    }
    this.#handOver();
  }

  /**
   * Fetches the pinned uBlock Origin files and uses them if every one
   * matches its hash. A failure keeps the library there is.
   *
   * @returns {Promise<boolean>} whether uBlock Origin's scriptlets are used.
   */
  update() {
    this.#running ??= this.#update().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #update() {
    const pin = this.pin;
    try {
      const budget = { remaining: MAX_UBO_BYTES };
      const files = {};
      for (const path of Object.keys(pin.files)) {
        const response = await download(`${pin.base}${pin.commit}/${path}`, {
          budget,
          user: false,
        });
        if (!response.ok) {
          throw scriptletError(`status ${Number(response.status)}`);
        }
        files[path] = await response.text();
      }
      if (!(await matchesPin(pin, files))) {
        // Fetching again cannot help: only a Sval change moves the pin.
        SvalLog.warn("uBlock Origin's scriptlets do not match Sval's pin");
        return false;
      }
      this.#ubo = convertUbo(files);
      await this.#store(files);
      this.#handOver();
      return true;
    } catch (err) {
      SvalLog.warn(
        `uBlock Origin's scriptlets could not be fetched: ${err?.reason ?? err?.name}`
      );
      this.schedule(RETRY_DELAY);
      return false;
    }
  }

  /**
   * Fetches uBlock Origin's scriptlets soon, if the library lacks them and
   * Sval would use them: page rules are on, the blocking level uses lists,
   * and list updates are on.
   *
   * @param {number} [delay] How long to wait; by default a short random time.
   */
  schedule(
    delay = FETCH_DELAY[0] + Math.random() * (FETCH_DELAY[1] - FETCH_DELAY[0])
  ) {
    if (
      !this.#started ||
      this.#ubo ||
      this.#timer ||
      !Services.prefs.getBoolPref(UPDATES_PREF, true) ||
      !Services.prefs.getBoolPref(PAGE_RULES_PREF, true) ||
      !SvalBlockingLists.enabledIds().some(id => id != ALLOWED_DOMAINS_LIST)
    ) {
      return;
    }
    this.#timer = lazy.setTimeout(() => {
      this.#timer = null;
      this.update();
    }, delay);
  }

  /**
   * Stores verified files with what this build converted them to.
   *
   * @param {object} files Path to text, verified against the pin.
   */
  async #store(files) {
    await IOUtils.makeDirectory(SvalBlockingLists.dir, {
      ignoreExisting: true,
    });
    await IOUtils.writeJSON(
      this.#copyPath,
      {
        commit: this.pin.commit,
        build: Services.appinfo.appBuildID,
        files,
        resources: this.#ubo,
      },
      { tmpPath: this.#copyPath + ".tmp" }
    );
  }

  #handOver() {
    SvalPageRules.setScriptletResources(JSON.stringify(this.#ubo ?? []));
  }

  /** Forgets the library and the pin a test set, and stops the schedule. */
  resetForTesting() {
    this.stop();
    this.pin = UBO_PIN;
    this.#ubo = null;
  }
}

export const SvalScriptlets = new Scriptlets();
