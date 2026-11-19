/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Which files an agent may upload (agent-control spec §5.2): what a path
 * must be before Sval reads it for an agent, and whether a file lies in a
 * folder the user granted.
 *
 * A path is the agent's word, so each is resolved through every link, kept
 * to this computer's own drives, and refused inside any Sval or Gecko
 * profile, whose files hold the user's sign-ins and keys.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

import { AGENT_DIR } from "moz-src:///browser/components/sval/SvalAgentConst.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
});

/**
 * The file Sval keeps in each of its own profile directories, so a file
 * inside one is known by what its directories hold, however its path is
 * spelled (`inAProfile`). Gecko marks the profile itself
 * (`compatibility.ini`, `times.json`), but not the local one (`ProfLD`,
 * which holds the cache), so Sval marks both.
 */
export const PROFILE_MARK = ".sval-profile";

/**
 * Puts `PROFILE_MARK` in this profile's directory and its local directory
 * if it is not there. Called as the profile's first window starts
 * (`SvalAgents.start`) and again as a gate opens, before any upload can be
 * asked for. A directory that cannot be marked is logged and left: the
 * path and Gecko's own marks still cover it.
 */
export function markProfile() {
  for (const key of ["ProfD", "ProfLD"]) {
    try {
      const mark = Services.dirsvc.get(key, Ci.nsIFile);
      mark.append(PROFILE_MARK);
      if (!mark.exists()) {
        mark.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
      }
    } catch (err) {
      SvalLog.warn(`could not mark the profile: ${SvalLog.errorName(err)}`);
    }
  }
}

const badFile = () =>
  new ToolError(
    "bad_file",
    "Each path must be absolute and name a file you can read: not a directory, not a file that is missing, and not one of Sval's own profile files."
  );

/** How many links in a row a path may go through before it is refused. */
const MAX_LINKS = 16;

/**
 * @param {string} path An absolute path.
 * @returns {nsIFile} The file `path` names, as resolved as Gecko can. On
 *   macOS and Linux `normalize` resolves every symlink through `realpath`
 *   (xpcom/io/nsLocalFileUnix.cpp, `Normalize`), and a link left over is
 *   followed through its `target`. That still leaves other spellings of one
 *   file: macOS's firmlinks (`/System/Volumes/Data/...`), which realpath
 *   does not merge. On Windows `normalize` is only lexical
 *   (nsLocalFileWin.cpp, `Normalize`) and `isSymlink` is always false
 *   (`IsSymlink`), so junctions and 8.3 short names are not resolved at
 *   all. The profile check therefore does not rest on the spelling alone
 *   (`inAProfile`).
 */
function resolvedFile(path) {
  let file = new lazy.FileUtils.File(path);
  file.normalize();
  for (let i = 0; file.isSymlink(); i++) {
    if (i >= MAX_LINKS) {
      throw badFile();
    }
    file = new lazy.FileUtils.File(file.target);
    file.normalize();
  }
  return file;
}

/**
 * @param {string} path
 * @returns {string} `path` as directory containment compares it: the file
 *   systems macOS and Windows use by default ignore case.
 */
function comparable(path) {
  return AppConstants.platform == "macosx" || AppConstants.platform == "win"
    ? path.toLowerCase()
    : path;
}

/**
 * The directories no upload may come from: the profile Sval runs with, its
 * local (cache) directory, the directories profiles are made in, and every
 * profile the profile service knows (toolkit/profile/nsIToolkitProfileService
 * `profiles`). They hold the user's sessions (`cookies.sqlite`), saved
 * passwords (`logins.json`, `key4.db`) and the agents' own tokens
 * (`sval-agents/`), which would let a page take the user's accounts or drive
 * Sval. Each is resolved as the files are, so a link to it is caught.
 *
 * @returns {string[]} Their resolved, comparable paths.
 */
function profileRoots() {
  const dirs = [];
  for (const key of ["ProfD", "ProfLD", "DefProfRt", "DefProfLRt"]) {
    try {
      dirs.push(Services.dirsvc.get(key, Ci.nsIFile));
    } catch {}
  }
  try {
    const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
      Ci.nsIToolkitProfileService
    );
    for (const profile of service.profiles) {
      dirs.push(profile.rootDir, profile.localDir);
    }
  } catch {}
  const roots = [];
  for (const dir of dirs) {
    try {
      roots.push(comparable(resolvedFile(dir.path).path));
    } catch {
      if (dir?.path) {
        roots.push(comparable(dir.path));
      }
    }
  }
  return roots;
}

/**
 * What marks a directory as a profile, each entry a set of files that must
 * all be there: the file Gecko writes into every profile it starts
 * (`compatibility.ini`, toolkit/xre); the one Sval writes into its own
 * profile and local profile directories (`PROFILE_MARK`); and, for a Gecko
 * profile that has lost its `compatibility.ini`, `times.json`
 * (toolkit/modules/ProfileAge.sys.mjs) together with `prefs.js`. Either of
 * those last two alone is a name any project can hold.
 */
const PROFILE_MARKERS = [
  ["compatibility.ini"],
  [PROFILE_MARK],
  ["times.json", "prefs.js"],
];

/**
 * Whether `file` lies in a Gecko profile or in Sval's agents directory,
 * judged by what its ancestor directories hold rather than by how its path
 * is spelled, which the same file can be in more than one way
 * (`resolvedFile`).
 *
 * @param {nsIFile} file
 * @returns {boolean}
 */
function inAProfile(file) {
  for (let dir = file.parent; dir; dir = dir.parent) {
    if (comparable(dir.leafName) === comparable(AGENT_DIR)) {
      return true;
    }
    for (const marker of PROFILE_MARKERS) {
      try {
        if (
          marker.every(name => {
            const child = dir.clone();
            child.append(name);
            return child.exists();
          })
        ) {
          return true;
        }
      } catch {
        // An ancestor Sval cannot look into cannot be shown not to be one.
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {string} path A resolved, comparable path.
 * @param {string} root A resolved, comparable directory.
 * @returns {boolean} Whether `path` is `root` or lies inside it, as
 *   `nsIFile.contains` asks.
 */
function inside(path, root) {
  if (path === root) {
    return true;
  }
  const separator = AppConstants.platform == "win" ? "\\" : "/";
  const prefix = root.endsWith(separator) ? root : root + separator;
  return path.startsWith(prefix);
}

/** The most one `upload_file` call sends, all its files together. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const tooLarge = () =>
  new ToolError(
    "file_too_large",
    "Those files come to more than 100 MiB, the most one upload sends."
  );

/**
 * @param {nsIFile} file
 * @returns {string} The file's type as Firefox's MIME service reads it, or
 *   none.
 */
function typeOf(file) {
  try {
    return Cc["@mozilla.org/mime;1"]
      .getService(Ci.nsIMIMEService)
      .getTypeFromFile(file);
  } catch {
    return "";
  }
}

/**
 * The files an agent asked to upload, checked before the page or the user
 * hears of them. Each path must be absolute, and is resolved through every
 * symlink on it, because the file a link points at is what a page would
 * get: a link named `photo.jpg` can point at a key. The resolved file must be
 * a regular file outside Sval's profiles (`checkedFile`), and all of them
 * together no larger than `maxBytes` by their sizes now. Nothing is read
 * here: a call can wait hours for the user, and holds no file's bytes
 * meanwhile (`readCheckedFiles`).
 *
 * @param {string[]} paths
 * @param {number} maxBytes The most all of them may hold.
 * @returns {Promise<Array<{path: string, file: nsIFile, info: object}>>}
 *   Each path as asked, its resolved file, whose full path the user is
 *   shown, and its `IOUtils.stat`.
 */
export async function checkedFiles(paths, maxBytes) {
  if (!paths.length) {
    throw new ToolError("bad_file", "Give at least one path.");
  }
  const roots = profileRoots();
  const checked = [];
  let total = 0;
  for (const path of paths) {
    const { file, info } = await checkedFile(path, roots);
    total += info.size;
    if (total > maxBytes) {
      throw tooLarge();
    }
    checked.push({ path, file, info });
  }
  return checked;
}

/**
 * Reads files `checkedFiles` checked, once the user has allowed the upload,
 * and checks each path again after its read: it must still lead to the same
 * file, and pass every check. The page is given exactly the bytes read here.
 *
 * @param {Array<{path: string, file: nsIFile, info: object}>} checked
 * @param {number} maxBytes The most all of them may hold.
 * @returns {Promise<Array<{path: string, name: string, type: string, lastModified: number, bytes: Uint8Array}>>}
 *   Each file as read: its full path, and what the page is given.
 */
export async function readCheckedFiles(checked, maxBytes) {
  const roots = profileRoots();
  const files = [];
  let total = 0;
  for (const { path, file, info } of checked) {
    let bytes;
    try {
      // One byte past what is left, so a file that grew since its stat is
      // caught rather than cut short.
      bytes = await IOUtils.read(file.path, {
        maxBytes: maxBytes - total + 1,
      });
    } catch {
      throw badFile();
    }
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw tooLarge();
    }
    // A directory on the way swapped for a link, or a link pointed
    // elsewhere, between the check and the read would change what was read,
    // so the path is resolved and checked again: it must still lead to the
    // same file, and pass every check. This narrows the race and does not
    // close it, and only a local process able to make links can run it,
    // which can read the files directly anyway.
    const again = await checkedFile(path, roots);
    if (comparable(again.file.path) !== comparable(file.path)) {
      throw badFile();
    }
    files.push({
      path: file.path,
      name: file.leafName,
      type: typeOf(file),
      lastModified: info.lastModified,
      bytes,
    });
  }
  return files;
}

/** Windows' `GetDriveTypeW` answers for drives on this computer. */
const LOCAL_DRIVE_TYPES = new Set([
  2, // DRIVE_REMOVABLE
  3, // DRIVE_FIXED
  5, // DRIVE_CDROM
  6, // DRIVE_RAMDISK
]);

/**
 * Whether a Windows path names a file on one of this computer's own drives,
 * as Windows itself reads the path: `PathGetDriveNumberW` finds its drive
 * letter, and `GetDriveTypeW` says what that drive is. A UNC path
 * (`\\host\share`, `\\?\UNC\…`), a device path (`\\.\…`) and a mapped
 * network drive are not, and are refused before anything opens them,
 * because opening one makes Windows contact that host and offer it the
 * user's credentials. Neither call touches the file or the network. Gecko
 * keeps its own answer (`IsRemoteFilePath`, nsLocalFileWin.cpp) out of
 * reach of JS.
 *
 * @param {string} path A Windows path, spelled with backslashes.
 * @returns {boolean}
 */
function onLocalDrive(path) {
  const { ctypes } = ChromeUtils.importESModule(
    "resource://gre/modules/ctypes.sys.mjs"
  );
  const shlwapi = ctypes.open("shlwapi.dll");
  const kernel32 = ctypes.open("kernel32.dll");
  try {
    const driveNumber = shlwapi.declare(
      "PathGetDriveNumberW",
      ctypes.winapi_abi,
      ctypes.int,
      ctypes.char16_t.ptr
    );
    const driveType = kernel32.declare(
      "GetDriveTypeW",
      ctypes.winapi_abi,
      ctypes.uint32_t,
      ctypes.char16_t.ptr
    );
    const drive = driveNumber(path);
    if (drive < 0 || drive > 25) {
      return false;
    }
    const root = `${String.fromCharCode(65 + drive)}:\\`;
    return LOCAL_DRIVE_TYPES.has(driveType(root));
  } finally {
    shlwapi.close();
    kernel32.close();
  }
}

/** `FILE_ATTRIBUTE_REPARSE_POINT` (winnt.h). */
const REPARSE_POINT = 0x400;

/** `ERROR_FILE_NOT_FOUND` and `ERROR_PATH_NOT_FOUND` (winerror.h). */
const NOT_FOUND_ERRORS = new Set([2, 3]);

/**
 * The reparse tags that keep a file where it is (`reparse_tag_redirects` in
 * tools/sval-folder/src/links.rs): `IO_REPARSE_TAG_DEDUP`, and the
 * cloud-files family, `IO_REPARSE_TAG_CLOUD` with any value in the bits
 * `IO_REPARSE_TAG_CLOUD_MASK` covers.
 *
 * @param {number} tag
 * @returns {boolean}
 */
const tagStaysPut = tag =>
  tag === 0x80000013 || (tag & 0xffff0fff) >>> 0 === 0x9000001a;

/**
 * Whether a Windows path passes through a link: the file, or a directory on
 * the way to it, is a reparse point whose tag can send the path elsewhere.
 * Gecko follows none of them for Sval (`resolvedFile`), so through one the
 * page would get another file than the alert showed, and a link to a
 * network share would make Windows offer that host the user's credentials
 * when anything opened the path. Each entry is read from the drive down
 * through `FindFirstFileW`, which reports an entry's own attributes and
 * reparse tag (`dwReserved0`) from its directory without following it, so
 * nothing below a link is reached before the link is found. Every tag but
 * those `tagStaysPut` names counts. An entry that cannot be read counts as a
 * link, and one that does not exist ends the walk, since nothing below it
 * exists either.
 *
 * @param {string} path An absolute local-drive path, normalized
 *   (`resolvedFile`).
 * @returns {boolean}
 */
function throughALink(path) {
  const root = /^(\\\\\?\\)?[A-Za-z]:\\/.exec(path)?.[0];
  // Windows reserves these in a name, and `FindFirstFileW` reads them as
  // wildcards.
  if (!root || /[*?<>"]/.test(path)) {
    return true;
  }
  const { ctypes } = ChromeUtils.importESModule(
    "resource://gre/modules/ctypes.sys.mjs"
  );
  const FILETIME = new ctypes.StructType("FILETIME", [
    { low: ctypes.uint32_t },
    { high: ctypes.uint32_t },
  ]);
  const WIN32_FIND_DATAW = new ctypes.StructType("WIN32_FIND_DATAW", [
    { dwFileAttributes: ctypes.uint32_t },
    { ftCreationTime: FILETIME },
    { ftLastAccessTime: FILETIME },
    { ftLastWriteTime: FILETIME },
    { nFileSizeHigh: ctypes.uint32_t },
    { nFileSizeLow: ctypes.uint32_t },
    { dwReserved0: ctypes.uint32_t },
    { dwReserved1: ctypes.uint32_t },
    { cFileName: ctypes.ArrayType(ctypes.char16_t, 260) },
    { cAlternateFileName: ctypes.ArrayType(ctypes.char16_t, 14) },
  ]);
  const kernel32 = ctypes.open("kernel32.dll");
  try {
    const findFirst = kernel32.declare(
      "FindFirstFileW",
      ctypes.winapi_abi,
      ctypes.voidptr_t,
      ctypes.char16_t.ptr,
      WIN32_FIND_DATAW.ptr
    );
    const findClose = kernel32.declare(
      "FindClose",
      ctypes.winapi_abi,
      ctypes.int32_t,
      ctypes.voidptr_t
    );
    const invalid = String(ctypes.cast(ctypes.int64_t(-1), ctypes.voidptr_t));
    let prefix = root.slice(0, -1);
    for (const name of path.slice(root.length).split("\\")) {
      if (!name) {
        continue;
      }
      prefix += `\\${name}`;
      const data = new WIN32_FIND_DATAW();
      const handle = findFirst(prefix, data.address());
      if (String(handle) == invalid) {
        return !NOT_FOUND_ERRORS.has(ctypes.winLastError);
      }
      findClose(handle);
      if (
        data.dwFileAttributes & REPARSE_POINT &&
        !tagStaysPut(data.dwReserved0)
      ) {
        return true;
      }
    }
    return false;
  } finally {
    kernel32.close();
  }
}

/**
 * One path an agent asked to upload, resolved and checked: absolute, on
 * one of this computer's own drives on Windows (`onLocalDrive`), through no
 * link on Windows (`throughALink`), a regular file once every link on it is
 * followed elsewhere, and outside Sval's profiles, by
 * path (`profileRoots`) and by what its directories hold (`inAProfile`).
 *
 * @param {string} path
 * @param {string[]} roots From `profileRoots`.
 * @returns {Promise<{file: nsIFile, info: object}>} The resolved file and
 *   its `IOUtils.stat`.
 */
async function checkedFile(path, roots) {
  // Windows takes either slash as a separator, and Gecko aborts the process
  // when PathUtils is handed a Windows path holding a forward one
  // (`InitFileWithPath`), so the path is spelled with backslashes first.
  const native =
    AppConstants.platform == "win" ? path.replaceAll("/", "\\") : path;
  if (!PathUtils.isAbsolute(native)) {
    throw badFile();
  }
  if (AppConstants.platform == "win" && !onLocalDrive(native)) {
    throw new ToolError(
      "bad_file",
      "Each path must be on one of this computer's own drives: not a network share or a mapped network drive."
    );
  }
  let file;
  let info;
  try {
    file = resolvedFile(native);
  } catch {
    throw badFile();
  }
  if (AppConstants.platform == "win" && throughALink(file.path)) {
    throw new ToolError(
      "bad_file",
      "Each path must reach its file through no link or junction."
    );
  }
  try {
    info = await IOUtils.stat(file.path);
  } catch {
    throw badFile();
  }
  if (info.type !== "regular") {
    throw badFile();
  }
  const where = comparable(file.path);
  if (roots.some(root => inside(where, root)) || inAProfile(file)) {
    throw badFile();
  }
  return { file, info };
}

/**
 * @param {nsIFile} entry
 * @returns {boolean} Whether `entry` is hidden: its name starts with a dot,
 *   or Gecko's `nsIFile.isHidden` says so. A dot counts on Windows too,
 *   where `isHidden` reads only the hidden attribute (nsLocalFileWin.cpp,
 *   `IsHidden`), because cross-platform tools keep the same dotfiles in a
 *   Windows home folder without setting it. On Windows a name holding a
 *   tilde and a digit counts too: an 8.3 short name (`GIT-CR~1`) names a
 *   dotfile with no dot, and Gecko gives JS no way to read the long name
 *   (`Normalize` in nsLocalFileWin.cpp is lexical). An entry Gecko cannot
 *   read counts as hidden.
 */
function isHiddenEntry(entry) {
  if (
    entry.leafName.startsWith(".") ||
    (AppConstants.platform == "win" && /~\d/.test(entry.leafName))
  ) {
    return true;
  }
  try {
    return entry.isHidden();
  } catch {
    return true;
  }
}

/**
 * Whether every file lies in one of the folders an upload grant names
 * (decision 0129): directly in a folder, or, for a folder whose grant covers
 * the folders inside it, anywhere under it as Gecko's `nsIFile.contains`
 * judges it. A grant never covers a hidden file, or a file in a hidden
 * folder below the granted one, because the home folder keeps its keys and
 * tokens there. Each folder is normalized as the files were
 * (`resolvedFile`), so a link on its way is followed. A folder Gecko cannot
 * read as a path holds nothing.
 *
 * @param {string[]} paths Resolved full paths of files.
 * @param {Array<{path: string, subfolders: boolean}>} folders From
 *   `uploadFoldersFor`.
 * @returns {boolean}
 */
export function inUploadFolders(paths, folders) {
  const dirs = folders.flatMap(({ path, subfolders }) => {
    try {
      const dir = new lazy.FileUtils.File(path);
      dir.normalize();
      return [{ dir, subfolders }];
    } catch {
      return [];
    }
  });
  return paths.every(path => {
    const file = new lazy.FileUtils.File(path);
    const parent = file.parent;
    return dirs.some(({ dir, subfolders }) => {
      if (subfolders ? !dir.contains(file) : !parent?.equals(dir)) {
        return false;
      }
      for (let entry = file; entry && !entry.equals(dir); ) {
        if (isHiddenEntry(entry)) {
          return false;
        }
        entry = entry.parent;
      }
      return true;
    });
  });
}
