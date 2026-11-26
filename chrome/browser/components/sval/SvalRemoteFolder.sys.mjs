/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A shared folder Sval reaches over the network itself, with no help from
 * the operating system: a folder on an SMB share or in the user's Dropbox
 * (desktop connectors spec §2). The chosen folder is kept as a root string
 * the helper reads (`Location` in `tools/sval-folder/src/remote/mod.rs`):
 * `smb://[user@]host[:port]/share/folder...` or `dropbox:/folder...`, each
 * segment percent-encoded.
 *
 * **The password or token is kept with the sync key** (`SvalSecretStore`), never in
 * the root or the settings file, and goes to the helper in each request's
 * `auth`. One secret holds the sign-ins of the roots chosen, by root, so a
 * failed change of folder leaves the folder in use signed in.
 */

const lazy = {};

// Lazy, so the panel model can name a remote folder without loading the
// secret store.
ChromeUtils.defineESModuleGetters(lazy, {
  SvalSecretStore: "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs",
});

/** The secret that holds every remote root's sign-in. */
export const SIGN_INS_SECRET = "shared-folder-sign-ins";

const SMB = "smb://";
const DROPBOX = "dropbox:/";

/**
 * The sign-ins read from the secret store, by root, kept for the run: each
 * shared step asks for one, and on macOS a read may cost a Keychain prompt.
 * Null until first read.
 */
let signIns = null;

/**
 * Whether `root` names a remote folder. A root that does is never a path on
 * any platform.
 *
 * @param {string|null} root
 * @returns {boolean}
 */
export function isRemoteRoot(root) {
  return (
    typeof root === "string" &&
    (root.startsWith(SMB) || root.startsWith(DROPBOX))
  );
}

/**
 * The folder of a Dropbox root, `/`-separated and empty for the root of the
 * user's Dropbox, or null when `root` is not one.
 *
 * @param {string} root
 * @returns {?{folder: string}}
 */
export function parseDropboxRoot(root) {
  if (typeof root !== "string" || !root.startsWith(DROPBOX)) {
    return null;
  }
  try {
    const folder = root
      .slice(DROPBOX.length)
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent)
      .join("/");
    return { folder };
  } catch {
    return null;
  }
}

/**
 * The root for a folder in the user's Dropbox.
 *
 * @param {string} folder `/`-separated, empty for the root of the Dropbox.
 * @returns {string}
 */
export function dropboxRoot(folder) {
  return (
    DROPBOX + folder.split("/").filter(Boolean).map(encodeSegment).join("/")
  );
}

function encodeSegment(segment) {
  return encodeURIComponent(segment);
}

/**
 * The parts of an SMB root, or null when `root` is not one.
 *
 * @param {string} root
 * @returns {?{host: string, port: number, share: string, folder: string,
 *   username: string}} `folder` is `/`-separated, empty for the share.
 */
export function parseSmbRoot(root) {
  if (typeof root !== "string" || !root.startsWith(SMB)) {
    return null;
  }
  const rest = root.slice(SMB.length);
  const slash = rest.indexOf("/");
  if (slash < 0) {
    return null;
  }
  const authority = rest.slice(0, slash);
  const at = authority.lastIndexOf("@");
  let username = "";
  let hostport = authority;
  try {
    if (at >= 0) {
      username = decodeURIComponent(authority.slice(0, at));
      hostport = authority.slice(at + 1);
    }
    const colon = hostport.lastIndexOf(":");
    let host = hostport;
    let port = 445;
    if (colon >= 0 && !hostport.slice(colon).includes("]")) {
      host = hostport.slice(0, colon);
      port = Number(hostport.slice(colon + 1));
    }
    const segments = rest
      .slice(slash + 1)
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (!host || !segments.length || !Number.isInteger(port)) {
      return null;
    }
    return {
      host,
      port,
      share: segments[0],
      folder: segments.slice(1).join("/"),
      username,
    };
  } catch {
    return null;
  }
}

/**
 * The root for a folder on an SMB share. `server` is what the user typed: a
 * host name or address, with `:port` when the server does not listen on 445.
 * `folder` is `/`- or `\`-separated, and may start with the share's name.
 *
 * @param {object} where
 * @param {string} where.server
 * @param {string} where.share
 * @param {string} [where.folder]
 * @param {string} [where.username]
 * @returns {string|null} null when a part is missing or cannot be a name.
 */
export function smbRoot({ server, share, folder = "", username = "" }) {
  const host = server
    .trim()
    .replace(/^smb:\/\//i, "")
    .replace(/^[\\/]+/, "")
    .replace(/[\\/].*$/, "");
  const segments = [share, ...folder.split(/[\\/]+/)]
    .map(segment => segment.trim())
    .filter(Boolean);
  if (!host || !segments.length || /\s/.test(host)) {
    return null;
  }
  if (segments.some(segment => segment === "." || segment === "..")) {
    return null;
  }
  const user = username.trim();
  const authority = user ? `${encodeSegment(user)}@${host}` : host;
  return `${SMB}${authority}/${segments.map(encodeSegment).join("/")}`;
}

/**
 * The name the folder goes by: its own name, or the share's.
 *
 * @param {string} root
 * @returns {string}
 */
export function remoteFolderName(root) {
  const dropbox = parseDropboxRoot(root);
  if (dropbox) {
    return dropbox.folder.split("/").at(-1) || "Dropbox";
  }
  const smb = parseSmbRoot(root);
  if (!smb) {
    return root;
  }
  return smb.folder ? smb.folder.split("/").at(-1) : smb.share;
}

/**
 * Where the folder is, as the user would type it to find it again:
 * `smb://server/share/folder`, without the username, or `Dropbox/folder`.
 *
 * @param {string} root
 * @returns {string}
 */
export function remoteFolderPlace(root) {
  const dropbox = parseDropboxRoot(root);
  if (dropbox) {
    return ["Dropbox", dropbox.folder].filter(Boolean).join("/");
  }
  const smb = parseSmbRoot(root);
  if (!smb) {
    return root;
  }
  const server = smb.port === 445 ? smb.host : `${smb.host}:${smb.port}`;
  return `${SMB}${[server, smb.share, smb.folder].filter(Boolean).join("/")}`;
}

/**
 * The last segment of a remote root's folder, as `PathUtils.filename` gives a
 * path's. Null for a share's root, which has no folder above it.
 *
 * @param {string} root
 * @returns {string|null}
 */
export function remoteFilename(root) {
  const dropbox = parseDropboxRoot(root);
  if (dropbox) {
    return dropbox.folder.split("/").at(-1) || null;
  }
  const smb = parseSmbRoot(root);
  return smb?.folder ? smb.folder.split("/").at(-1) : null;
}

/**
 * The root of the folder that holds `root`'s, as `PathUtils.parent` gives a
 * path's. Null for a share's root.
 *
 * @param {string} root
 * @returns {string|null}
 */
export function remoteParent(root) {
  const dropbox = parseDropboxRoot(root);
  if (dropbox) {
    return dropbox.folder
      ? dropboxRoot(dropbox.folder.split("/").slice(0, -1).join("/"))
      : null;
  }
  const smb = parseSmbRoot(root);
  if (!smb?.folder) {
    return null;
  }
  const server = smb.port === 445 ? smb.host : `${smb.host}:${smb.port}`;
  return smbRoot({
    server,
    share: smb.share,
    folder: smb.folder.split("/").slice(0, -1).join("/"),
    username: smb.username,
  });
}

async function readSignIns() {
  if (!signIns) {
    const bytes = await lazy.SvalSecretStore.read(SIGN_INS_SECRET);
    let stored = {};
    if (bytes) {
      try {
        stored = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        stored = {};
      }
    }
    signIns = new Map(
      Object.entries(stored ?? {}).filter(
        ([, auth]) =>
          typeof auth?.password === "string" ||
          typeof auth?.refreshToken === "string"
      )
    );
  }
  return signIns;
}

async function writeSignIns(map) {
  signIns = map;
  if (!map.size) {
    await lazy.SvalSecretStore.remove(SIGN_INS_SECRET);
    return;
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify(Object.fromEntries(map))
  );
  await lazy.SvalSecretStore.write(SIGN_INS_SECRET, bytes);
}

export const SvalRemoteFolder = {
  isRemoteRoot,
  parseSmbRoot,
  smbRoot,
  parseDropboxRoot,
  dropboxRoot,
  remoteFolderName,
  remoteFolderPlace,
  remoteFilename,
  remoteParent,

  /**
   * The sign-in a request for `root` carries, or null for a local root or
   * one with no sign-in kept.
   *
   * @param {string} root
   * @returns {Promise<?{password: string}|{refreshToken: string}>}
   */
  async authFor(root) {
    if (!isRemoteRoot(root)) {
      return null;
    }
    return (await readSignIns()).get(root) ?? null;
  },

  /**
   * Keeps `auth` as the sign-in for the folder at `root`: `{ password }` for
   * an SMB folder, `{ refreshToken }` for a Dropbox one.
   *
   * @param {string} root
   * @param {{password: string}|{refreshToken: string}} auth
   */
  async keepSignIn(root, auth) {
    const map = new Map(await readSignIns());
    map.set(root, auth);
    await writeSignIns(map);
  },

  /**
   * Keeps the sign-in kept for `from` as `to`'s, for a folder the user named
   * by the folder inside it.
   *
   * @param {string} from
   * @param {string} to
   */
  async moveSignIn(from, to) {
    const map = new Map(await readSignIns());
    const auth = map.get(from);
    if (!auth) {
      return;
    }
    map.delete(from);
    map.set(to, auth);
    await writeSignIns(map);
  },

  /**
   * Drops every sign-in but `root`'s, once `root` is the folder in use, or
   * every one when no remote folder is.
   *
   * @param {string|null} root
   */
  async keepOnly(root) {
    const map = await readSignIns();
    const kept = new Map([...map].filter(([at]) => at === root));
    if (kept.size !== map.size) {
      await writeSignIns(kept);
    }
  },

  /** Forgets what was read, so a test starts from the store. */
  _reset() {
    signIns = null;
  },
};
