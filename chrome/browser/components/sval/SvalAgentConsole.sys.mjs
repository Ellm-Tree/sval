/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What one page in an agent's tab writes to the console, kept in the page's
 * own process for `get_console_messages` (agent-control spec §4.5): its
 * `console` calls and its uncaught exceptions and unhandled rejections, and
 * nothing of any other document, its frames' included.
 *
 * Gecko keeps both for every window already: `ConsoleAPIStorage` holds a
 * window's console calls from its first one until the window goes, and the
 * console service holds the process's latest script errors, each with the
 * inner window id of the document that raised it. A watch starts from those,
 * so what the page logged before the watch began is kept too, then listens
 * for what comes after. The process's script errors are a ring shared by
 * every document in it (`nsConsoleService` `mMaximumSize`), so the parent
 * starts a watch as each page in an agent's tab is created
 * (`SvalAgentGate`).
 *
 * Console text is the page's content, and sites log tokens, account details
 * and what the user typed. It goes only to the agent the user allowed
 * (`SvalAgentGate.allowConsole`), and never to a log line.
 */

/** The most messages one page keeps; the oldest go first. */
export const MAX_CONSOLE_MESSAGES = 500;

/** The most characters of a message's text kept. */
export const MAX_CONSOLE_TEXT = 2000;

/** The most characters of a message's source address kept. */
const MAX_SOURCE = 2048;

/** How deep `textOf` reads into an array or an object. */
const MAX_DEPTH = 2;

/** How many of an array's items or an object's properties `textOf` names. */
const MAX_PARTS = 20;

const ConsoleAPIStorage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
  Ci.nsIConsoleAPIStorage
);

/**
 * @param {string} text
 * @param {number} max
 * @returns {string} `text` cut to `max` characters, at a whole character.
 */
function cut(text, max) {
  return text.length <= max ? text : [...text].slice(0, max).join("");
}

/**
 * A console argument as text. The value is the page's, seen through an
 * Xray, so reading it runs none of the page's code: no getter, `toString`
 * or `toJSON` of the page's is called.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 */
export function textOf(value, depth = 0) {
  switch (typeof value) {
    case "string":
      return value;
    case "undefined":
      return "undefined";
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
      return String(value);
    case "function":
      return `function ${value.name ?? ""}`.trim();
  }
  if (value === null) {
    return "null";
  }
  let className;
  try {
    className = ChromeUtils.getClassName(value, true);
  } catch {
    return "[object]";
  }
  try {
    if (className === "Error" || className === "DOMException") {
      return `${value.name ?? "Error"}: ${value.message ?? ""}`;
    }
    if (depth >= MAX_DEPTH) {
      return Array.isArray(value) ? "[…]" : `[object ${className}]`;
    }
    if (Array.isArray(value)) {
      const items = Array.from(value.slice(0, MAX_PARTS), item =>
        textOf(item, depth + 1)
      );
      if (value.length > MAX_PARTS) {
        items.push("…");
      }
      return `[${items.join(", ")}]`;
    }
    if (className === "Object") {
      const keys = Object.keys(value);
      const parts = keys
        .slice(0, MAX_PARTS)
        .map(key => `${key}: ${textOf(value[key], depth + 1)}`);
      if (keys.length > MAX_PARTS) {
        parts.push("…");
      }
      return `{${parts.join(", ")}}`;
    }
  } catch {}
  return `[object ${className}]`;
}

/**
 * The text of one console call: its arguments joined by spaces, with the
 * first one's format specifiers filled as the console fills them (`%s`,
 * `%d`, `%i`, `%f`, `%o`, `%O`, and `%c`, whose style is dropped).
 *
 * @param {unknown[]} args
 * @returns {string}
 */
export function formatArguments(args) {
  const rest = Array.from(args ?? []);
  const parts = [];
  if (typeof rest[0] === "string" && rest.length > 1) {
    const format = rest.shift();
    parts.push(
      format.replace(/%([sdifoOc%])/g, (whole, spec) => {
        if (spec === "%") {
          return "%";
        }
        if (!rest.length) {
          return whole;
        }
        const value = rest.shift();
        switch (spec) {
          case "c":
            return "";
          case "d":
          case "i":
            return typeof value === "number"
              ? String(Math.trunc(value))
              : "NaN";
          case "f":
            return typeof value === "number" ? String(value) : "NaN";
          default:
            return textOf(value);
        }
      })
    );
  }
  for (const value of rest) {
    parts.push(textOf(value));
  }
  return parts.join(" ");
}

/**
 * @param {string} [url]
 * @param {number} [line]
 * @param {number} [column]
 * @returns {object} The message's source, the fields Gecko gave.
 */
function sourceOf(url, line, column) {
  const out = {};
  if (typeof url === "string" && url) {
    out.url = cut(url, MAX_SOURCE);
  }
  if (Number.isSafeInteger(line) && line > 0) {
    out.line = line;
  }
  if (Number.isSafeInteger(column) && column > 0) {
    out.column = column;
  }
  return out;
}

/**
 * A console call of the page's, as a message, or null for one the page did
 * not make: a call from chrome code or from an extension's content script,
 * which logs to the page's window too (`ConsoleAPI.addonId`).
 *
 * @param {object} event A `ConsoleEvent`.
 * @returns {object|null}
 */
function fromConsoleCall(event) {
  if (event.chromeContext || event.addonId) {
    return null;
  }
  return {
    kind: "console",
    level: String(event.level ?? "log"),
    text: cut(formatArguments(event.arguments), MAX_CONSOLE_TEXT),
    ...sourceOf(event.filename, event.lineNumber, event.columnNumber),
    time: Number(event.timeStamp) || Date.now(),
  };
}

/**
 * @param {nsIConsoleMessage} message
 * @param {number} innerWindowId
 * @returns {boolean} Whether `message` is an uncaught exception or an
 *   unhandled rejection of the document `innerWindowId`: an error, as
 *   `xpc::ErrorReport::LogToConsoleWithStack` logs those, of content script.
 *   Warnings, CSS, network and security reports are left out.
 */
function isPageError(message, innerWindowId) {
  return (
    message instanceof Ci.nsIScriptError &&
    message.innerWindowID === innerWindowId &&
    !message.isFromChromeContext &&
    message.category === "content javascript" &&
    !(
      message.flags &
      (Ci.nsIScriptError.warningFlag | Ci.nsIScriptError.infoFlag)
    )
  );
}

/**
 * @param {nsIScriptError} message
 * @returns {object}
 */
function fromScriptError(message) {
  return {
    kind: message.isPromiseRejection
      ? "unhandled_rejection"
      : "uncaught_exception",
    level: "error",
    text: cut(String(message.errorMessage ?? ""), MAX_CONSOLE_TEXT),
    ...sourceOf(message.sourceName, message.lineNumber, message.columnNumber),
    time: Number(message.timeStamp) || Date.now(),
  };
}

/**
 * The console of one document, from Gecko's record of it on.
 */
export class ConsoleWatch {
  #innerWindowId;
  /** @type {Array<object>} Oldest first, each with its `seq`. */
  #messages = [];
  #nextSeq = 1;
  #onCall = event => this.#onConsoleCall(event);
  #listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIConsoleListener"]),
    observe: message => this.#onScriptError(message),
  };
  /** The errors read from the console service as the watch began. */
  #seen = new WeakSet();
  #stopped = false;

  /**
   * @param {number} innerWindowId The document's.
   */
  constructor(innerWindowId) {
    this.#innerWindowId = innerWindowId;
    const id = innerWindowId;
    const earlier = [];
    for (const event of ConsoleAPIStorage.getEvents(String(id))) {
      const message = fromConsoleCall(event);
      if (message) {
        earlier.push(message);
      }
    }
    for (const message of Services.console.getMessageArray() ?? []) {
      if (isPageError(message, id)) {
        this.#seen.add(message);
        earlier.push(fromScriptError(message));
      }
    }
    earlier.sort((a, b) => a.time - b.time);
    for (const message of earlier) {
      this.#keep(message);
    }
    // Registered in the same turn as the reads, so nothing falls between
    // the two. The console service tells its listeners on a later turn
    // (`nsConsoleService::LogMessageRunnable`), so an error the read found
    // can still reach the listener, and `#seen` drops it.
    ConsoleAPIStorage.addLogEventListener(
      this.#onCall,
      Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal)
    );
    Services.console.registerListener(this.#listener);
  }

  /** Stops listening. The document is going away. */
  stop() {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    try {
      ConsoleAPIStorage.removeLogEventListener(this.#onCall);
    } catch {}
    try {
      Services.console.unregisterListener(this.#listener);
    } catch {}
    this.#messages = [];
  }

  /**
   * @param {object} event
   */
  #onConsoleCall(event) {
    if (String(event.innerID) !== String(this.#innerWindowId)) {
      return;
    }
    const message = fromConsoleCall(event);
    if (message) {
      this.#keep(message);
    }
  }

  /**
   * @param {nsIConsoleMessage} message
   */
  #onScriptError(message) {
    if (this.#seen.has(message) || !isPageError(message, this.#innerWindowId)) {
      return;
    }
    this.#keep(fromScriptError(message));
  }

  /**
   * @param {object} message
   */
  #keep(message) {
    this.#messages.push({ ...message, seq: this.#nextSeq++ });
    if (this.#messages.length > MAX_CONSOLE_MESSAGES) {
      this.#messages.shift();
    }
  }

  /**
   * The messages after `after`, oldest first.
   *
   * @param {object} options
   * @param {number} options.after The `seq` of the last message read
   *   before, 0 for none.
   * @param {number} options.limit The most messages answered.
   * @returns {{messages: object[], last: number, more: boolean, dropped: number}}
   *   `last` is the `seq` of the last message answered, or `after` when there
   *   is none. `dropped` counts the messages after `after` that the watch no
   *   longer holds.
   */
  read({ after, limit }) {
    const newer = this.#messages.filter(m => m.seq > after);
    const first = newer[0]?.seq ?? this.#nextSeq;
    const messages = newer.slice(0, limit);
    return {
      messages,
      last: messages.at(-1)?.seq ?? Math.max(after, first - 1),
      more: newer.length > messages.length,
      dropped: Math.max(first - after - 1, 0),
    };
  }
}
