/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * The shared-folder helper (local-copy spec §4.2) never leaves the folder
 * through a link: a link below the root is never followed.
 */

/**
 * @param {string} target What the link points at.
 * @param {string} link Where the link goes.
 */
async function makeSymlink(target, link) {
  const proc = await Subprocess.call({
    command: await Subprocess.pathSearch("ln"),
    arguments: ["-s", target, link],
    stderr: "pipe",
  });
  Assert.equal((await proc.wait()).exitCode, 0, "ln made the link");
}

/** Creating symlinks needs a privilege on Windows, so those tests skip. */
const noSymlinks = () => AppConstants.platform == "win";

/**
 * A folder outside any shared root, holding a file a link could aim at.
 *
 * @param {string} name Tells the folders apart in a failure message.
 */
async function outsideFolder(name) {
  const outside = await makeTempDir(`sval-outside-${name}`);
  await IOUtils.writeUTF8(PathUtils.join(outside, "secret.json"), "secret");
  return outside;
}

function written(root, parts) {
  return IOUtils.exists(PathUtils.join(root, ...parts));
}

add_task(
  { skip_if: noSymlinks },
  async function a_symlinked_peer_file_is_listed_and_never_read() {
    const root = await makeTempDir("sval-peer-link");
    const outside = await outsideFolder("peer-link");
    const dir = PathUtils.join(root, "sval", "ws", "abc");
    await IOUtils.makeDirectory(dir);
    await IOUtils.writeUTF8(PathUtils.join(dir, "peer.json"), "peer");
    await makeSymlink(
      PathUtils.join(outside, "secret.json"),
      PathUtils.join(dir, "evil.json")
    );
    await makeSymlink(
      PathUtils.join(root, "does-not-exist"),
      PathUtils.join(dir, "dangling.json")
    );
    const read = await SvalSharedFolder.readDir({
      root,
      path: "sval/ws/abc",
      suffix: ".json",
      mine: "me.json",
      requireTop: "sval",
      deadline: deadline(),
    });
    Assert.equal(read.reachable, true, "a link is not an outage");
    Assert.deepEqual(
      read.entries.map(entry => entry.name),
      ["peer.json"],
      "neither link is a candidate"
    );
    Assert.deepEqual(
      read.unreadable.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: "dangling.json", reason: "Symlink" },
        { name: "evil.json", reason: "Symlink" },
      ]
    );
    Assert.ok(
      !JSON.stringify(read).includes(
        ChromeUtils.base64URLEncode(new TextEncoder().encode("secret"), {
          pad: true,
        })
      ),
      "and what the link points at is not in the answer"
    );

    // This device's own file being a link is listed first, and never read.
    await makeSymlink(
      PathUtils.join(outside, "secret.json"),
      PathUtils.join(dir, "me.json")
    );
    const own = await SvalSharedFolder.readDir({
      root,
      path: "sval/ws/abc",
      suffix: ".json",
      mine: "me.json",
      requireTop: "sval",
      deadline: deadline(),
    });
    Assert.deepEqual(
      own.entries.map(entry => entry.name),
      ["peer.json"]
    );
    Assert.deepEqual(own.unreadable[0], { name: "me.json", reason: "Symlink" });

    // A write onto a link at this device's file name changes nothing.
    Assert.deepEqual(
      reasonOf(
        await SvalSharedFolder.writeFile({
          root,
          path: "sval/ws/abc/me.json",
          bytes: new Uint8Array([9]),
          requireTop: "sval",
          deadline: deadline(),
        })
      ),
      { reachable: false, reason: "io-error" }
    );
    Assert.equal(
      await IOUtils.readUTF8(PathUtils.join(outside, "secret.json")),
      "secret",
      "the link's target is untouched"
    );
  }
);

add_task(
  { skip_if: noSymlinks },
  async function a_symlinked_directory_below_the_root_is_never_followed() {
    const root = await makeTempDir("sval-dir-link");
    const outside = await outsideFolder("dir-link");
    await IOUtils.writeUTF8(PathUtils.join(outside, "peer.json"), "outside");
    await IOUtils.makeDirectory(PathUtils.join(root, "sval", "ws"));
    // The document directory is a link to a folder outside the root.
    await makeSymlink(outside, PathUtils.join(root, "sval", "ws", "abc"));
    const refused = { reachable: false, reason: "io-error" };

    Assert.deepEqual(
      reasonOf(
        await SvalSharedFolder.readDir({
          root,
          path: "sval/ws/abc",
          suffix: ".json",
          mine: "me.json",
          requireTop: "sval",
          deadline: deadline(),
        })
      ),
      refused,
      "a listing does not go through the link"
    );
    Assert.deepEqual(
      reasonOf(
        await SvalSharedFolder.writeFile({
          root,
          path: "sval/ws/abc/me.json",
          bytes: new Uint8Array([1]),
          requireTop: "sval",
          deadline: deadline(),
        })
      ),
      refused,
      "a write does not go through it"
    );
    Assert.deepEqual(
      reasonOf(
        await SvalSharedFolder.remove({
          root,
          path: "sval/ws/abc/peer.json",
          deadline: deadline(),
        })
      ),
      refused,
      "a removal does not go through it"
    );
    Assert.deepEqual(
      reasonOf(
        await SvalSharedFolder.exists({
          root,
          path: "sval/ws/abc/peer.json",
          deadline: deadline(),
        })
      ),
      refused,
      "nor does an existence check"
    );
    Assert.deepEqual(
      (await IOUtils.getChildren(outside)).map(PathUtils.filename).sort(),
      ["peer.json", "secret.json"],
      "the folder outside gained and lost nothing"
    );
    Assert.equal(
      await IOUtils.readUTF8(PathUtils.join(outside, "peer.json")),
      "outside"
    );

    // A link higher up is no different.
    const upper = await makeTempDir("sval-upper-link");
    const elsewhere = await outsideFolder("upper-link");
    await makeSymlink(elsewhere, PathUtils.join(upper, "sval"));
    Assert.deepEqual(
      reasonOf(
        await SvalSharedFolder.writeFile({
          root: upper,
          path: "sval/ws/abc/me.json",
          bytes: new Uint8Array([1]),
          requireTop: "sval",
          deadline: deadline(),
        })
      ),
      refused
    );
    Assert.ok(
      !(await written(elsewhere, ["ws"])),
      "no directory was made through the link"
    );
  }
);

/**
 * Windows hides a junction from `nsIFile` and `IOUtils` (both report a
 * directory), so the helper reads its reparse tag. A junction needs no
 * privilege to create, unlike a symbolic link.
 */
add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function a_junction_below_the_root_is_never_followed() {
    const root = await makeTempDir("sval-junction");
    const outside = await outsideFolder("junction");
    await IOUtils.writeUTF8(PathUtils.join(outside, "peer.json"), "outside");
    await IOUtils.makeDirectory(PathUtils.join(root, "sval", "ws"));
    const junction = PathUtils.join(root, "sval", "ws", "abc");
    const cmd = (...args) =>
      Subprocess.call({
        command: Services.env.get("COMSPEC"),
        arguments: ["/c", ...args],
        stderr: "pipe",
      }).then(proc => proc.wait());
    const made = await cmd("mklink", "/J", junction, outside);
    if (made.exitCode != 0) {
      info(
        `mklink /J exited ${made.exitCode}: no junction, so nothing to test`
      );
      todo_check_true(false);
      return;
    }
    try {
      const refused = { reachable: false, reason: "io-error" };
      Assert.deepEqual(
        reasonOf(
          await SvalSharedFolder.readDir({
            root,
            path: "sval/ws/abc",
            suffix: ".json",
            mine: "me.json",
            requireTop: "sval",
            deadline: deadline(),
          })
        ),
        refused,
        "a listing does not go through the junction"
      );
      Assert.deepEqual(
        reasonOf(
          await SvalSharedFolder.writeFile({
            root,
            path: "sval/ws/abc/me.json",
            bytes: new Uint8Array([1]),
            requireTop: "sval",
            deadline: deadline(),
          })
        ),
        refused,
        "a write does not go through it"
      );
      Assert.deepEqual(
        reasonOf(
          await SvalSharedFolder.remove({
            root,
            path: "sval/ws/abc/peer.json",
            deadline: deadline(),
          })
        ),
        refused,
        "a removal does not go through it"
      );
      Assert.deepEqual(
        (await IOUtils.getChildren(outside)).map(PathUtils.filename).sort(),
        ["peer.json", "secret.json"],
        "the folder outside gained and lost nothing"
      );
      Assert.equal(
        await IOUtils.readUTF8(PathUtils.join(outside, "peer.json")),
        "outside"
      );
    } finally {
      // Removes the junction itself, never what it points at.
      await cmd("rmdir", junction);
    }
  }
);

/**
 * The folder the user chose may itself be a link, and is followed. No link
 * can be planted at the temporary file a write goes through: its name is
 * random and it is created exclusively (`writeAtomically`).
 */
add_task(
  { skip_if: noSymlinks },
  async function a_symlinked_root_is_followed() {
    const real = await makeTempDir("sval-real-root");
    const holder = await makeTempDir("sval-root-link");
    const root = PathUtils.join(holder, "chosen");
    await makeSymlink(real, root);
    Assert.deepEqual(
      await SvalSharedFolder.writeFile({
        root,
        path: "sval/ws/abc/me.json",
        bytes: new Uint8Array([4, 5]),
        requireTop: null,
        deadline: deadline(),
      }),
      { reachable: true },
      "the folder the user chose may itself be a link"
    );
    Assert.deepEqual(
      Array.from(
        await IOUtils.read(PathUtils.join(real, "sval", "ws", "abc", "me.json"))
      ),
      [4, 5]
    );
  }
);

/** A `sval/` that is a link is not the folder's: marking it is refused. */
add_task(
  { skip_if: noSymlinks },
  async function marking_a_folder_whose_sval_is_a_link_is_refused() {
    const root = await makeTempDir("sval-mark-link");
    const outside = await outsideFolder("mark-link");
    await makeSymlink(outside, PathUtils.join(root, "sval"));
    Assert.deepEqual(
      reasonOf(
        await SvalSharedFolder.makeDir({
          root,
          path: "sval",
          deadline: deadline(),
        })
      ),
      { reachable: false, reason: "io-error" }
    );
    Assert.deepEqual(
      (await IOUtils.getChildren(outside)).map(PathUtils.filename),
      ["secret.json"],
      "and nothing was made where it points"
    );
  }
);
