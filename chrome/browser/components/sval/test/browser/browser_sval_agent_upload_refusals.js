/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_upload_helpers.js */

/**
 * Which paths an upload refuses without asking the user (agent-control
 * spec §4.4, §5.2): paths that name no file on this computer's drives, an
 * element that takes no files, too much at once, and any file in Sval's
 * profile or in a directory holding a Gecko profile, however the path
 * reaches it; and the paths like those that are sent.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_upload_helpers.js",
  this
);

add_task(async function bad_files_and_other_elements_are_refused_unasked() {
  const { call, alerts, tab, many, one, plain } = await uploadSetup();
  const { dir, paths } = await filesNamed("a.txt", "b.txt");
  // A drive path with forward slashes is relative off Windows, and a
  // root-relative one is relative on Windows.
  const slashed =
    AppConstants.platform == "win"
      ? [
          ["a root-relative path", "/a.txt"],
          ["a root-relative path with backslashes", "\\a.txt"],
        ]
      : [
          ["a drive path with forward slashes", "C:/Users/a.txt"],
          ["a drive path with mixed slashes", "C:\\Users/a.txt"],
        ];
  for (const [what, args, code] of [
    ["a relative path", { ref: many, paths: ["a.txt"] }, "bad_file"],
    ...slashed.map(([name, path]) => [
      name,
      { ref: many, paths: [path] },
      "bad_file",
    ]),
    [
      "a missing file",
      { ref: many, paths: [PathUtils.join(dir, "missing.txt")] },
      "bad_file",
    ],
    ["a directory", { ref: many, paths: [dir] }, "bad_file"],
    ["two files for one", { ref: one, paths }, "bad_file"],
    ["no files", { ref: many, paths: [] }, "bad_file"],
    ["a button", { ref: plain, paths: [paths[0]] }, "not_file_input"],
  ]) {
    await Assert.rejects(
      call("upload_file", { tab, ...args }),
      e => e.code === code,
      `${what} is ${code}`
    );
  }
  Assert.equal(alerts.opened, 0, "none of them asked the user");
});

/** Windows takes a forward slash as a separator, so Sval does too. */
add_task(
  // Forward slashes separate a path elsewhere already.
  { skip_if: () => AppConstants.platform != "win" },
  async function a_windows_path_with_forward_slashes_uploads() {
    const { call, store, agent, tab, browser, many } = await uploadSetup();
    const { dir, paths } = await filesNamed("a.txt", "b.txt");
    await store.allowUploadFolders(agent.agentId, "example.com", [dir], false);
    const result = await call("upload_file", {
      tab,
      ref: many,
      paths: [paths[0].replaceAll("\\", "/"), `${dir}/b.txt`],
    });
    Assert.deepEqual(result.files, ["a.txt", "b.txt"]);
    Assert.deepEqual(await contentsIn(browser, "many"), [
      "contents of a.txt",
      "contents of b.txt",
    ]);
  }
);

/**
 * Opening a file on another computer makes Windows offer that host the
 * user's credentials, so a path that does not name one of this computer's
 * drives is refused before anything opens it, even one that leads back to
 * this computer.
 */
add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function a_network_path_is_refused_unasked() {
    const { call, alerts, tab, many } = await uploadSetup();
    const { paths } = await filesNamed("a.txt");
    const [drive, rest] = [paths[0].slice(0, 1), paths[0].slice(3)];
    for (const path of [
      `\\\\localhost\\${drive}$\\${rest}`,
      `//localhost/${drive}$/${rest.replaceAll("\\", "/")}`,
      `\\\\?\\UNC\\localhost\\${drive}$\\${rest}`,
      `\\\\.\\${drive}:\\${rest}`,
    ]) {
      await Assert.rejects(
        call("upload_file", { tab, ref: many, paths: [path] }),
        e => e.code === "bad_file" && /network share/.test(e.message ?? ""),
        `${path} is refused as off this computer's drives`
      );
    }
    Assert.equal(alerts.opened, 0, "none of them asked the user");
  }
);

/**
 * Sval's own profile is never sent: its files hold the user's sessions and
 * the agents' tokens.
 */
add_task(async function a_file_in_the_profile_is_refused() {
  const { call, store, agent, alerts, tab, many } = await uploadSetup();
  await store.allowUploadFolders(
    agent.agentId,
    "example.com",
    [PathUtils.profileDir],
    false
  );
  const inProfile = PathUtils.join(
    PathUtils.profileDir,
    `sval-upload-${crypto.randomUUID()}.txt`
  );
  await IOUtils.writeUTF8(inProfile, "profile data");
  atTaskEnd(() => IOUtils.remove(inProfile));
  await Assert.rejects(
    call("upload_file", { tab, ref: many, paths: [inProfile] }),
    e => e.code === "bad_file",
    "a file in the profile is refused"
  );
  Assert.equal(alerts.opened, 0);
});

/**
 * A symlink is the file it points at: that is what the page would get, so it
 * is what is checked, shown to the user and sent.
 */
add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function a_symlink_is_judged_and_sent_as_its_target() {
    const { call, win, tab, browser, many } = await uploadSetup();
    const { dir, paths } = await filesNamed("real.txt");
    const intoProfile = PathUtils.join(dir, "photo.jpg");
    const inProfile = PathUtils.join(
      PathUtils.profileDir,
      `sval-upload-${crypto.randomUUID()}.txt`
    );
    await IOUtils.writeUTF8(inProfile, "profile data");
    atTaskEnd(() => IOUtils.remove(inProfile));
    await symlink(inProfile, intoProfile);
    await Assert.rejects(
      call("upload_file", { tab, ref: many, paths: [intoProfile] }),
      e => e.code === "bad_file",
      "a symlink into the profile is refused"
    );

    const harmless = PathUtils.join(dir, "harmless.jpg");
    await symlink(paths[0], harmless);
    const uploading = call("upload_file", {
      tab,
      ref: many,
      paths: [harmless],
    });
    const doc = await alertIn(win);
    Assert.deepEqual(
      [...doc.querySelectorAll("#sval-aa-items li")].map(li => li.textContent),
      [resolved(paths[0])],
      "the alert names the file the link points at"
    );
    await choose(doc, "allow");
    Assert.deepEqual((await uploading).files, ["real.txt"]);
    Assert.deepEqual(
      await filesIn(browser, "many"),
      ["real.txt"],
      "the page got the target itself"
    );
    Assert.deepEqual(
      await contentsIn(browser, "many"),
      ["contents of real.txt"],
      "with the target's contents"
    );
  }
);

/** One call sends at most `MAX_UPLOAD_BYTES` in all. */
add_task(async function too_much_at_once_is_file_too_large() {
  const { MAX_UPLOAD_BYTES } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentUploads.sys.mjs"
  );
  Assert.equal(MAX_UPLOAD_BYTES, 100 * 1024 * 1024, "the cap is 100 MiB");
  const { call, store, agent, alerts, tab, many } = await uploadSetup();
  // Three files that are each under the cap and together over it.
  const { dir, paths } = await filesNamed("a.txt", "b.txt", "c.txt");
  const third = new Uint8Array(Math.ceil(MAX_UPLOAD_BYTES / 3) + 1);
  for (const path of paths) {
    await IOUtils.write(path, third);
  }
  await store.allowUploadFolders(agent.agentId, "example.com", [dir], false);
  await Assert.rejects(
    call("upload_file", { tab, ref: many, paths }),
    e => e.code === "file_too_large",
    "three files over the cap are refused"
  );
  const ok = await call("upload_file", { tab, ref: many, paths: [paths[0]] });
  Assert.deepEqual(ok.files, ["a.txt"], "one under it goes");
  Assert.equal(alerts.opened, 0);
});

/**
 * The profile is refused however its path is spelled: a file under any
 * directory that is a Gecko profile, or under the agents' directory that
 * `SvalAgents` writes its token in, is refused.
 */
add_task(async function a_profile_is_refused_by_what_it_holds() {
  const { call, store, agent, alerts, tab, many } = await uploadSetup();
  const { dir } = await filesNamed();
  await store.allowUploadFolders(agent.agentId, "example.com", [dir], true);
  for (const marker of ["compatibility.ini", ".sval-profile"]) {
    const profile = PathUtils.join(dir, `p-${marker}`);
    await IOUtils.makeDirectory(PathUtils.join(profile, "deep"), {
      createAncestors: true,
    });
    await IOUtils.writeUTF8(PathUtils.join(profile, marker), "{}");
    const inside = PathUtils.join(profile, "deep", "logins.json");
    await IOUtils.writeUTF8(inside, "secret");
    await Assert.rejects(
      call("upload_file", { tab, ref: many, paths: [inside] }),
      e => e.code === "bad_file",
      `a file under a directory holding ${marker} is refused`
    );
  }
  const agents = PathUtils.join(dir, AGENT_DIR);
  await IOUtils.makeDirectory(agents);
  const token = PathUtils.join(agents, "port.json");
  await IOUtils.writeUTF8(token, "{}");
  await Assert.rejects(
    call("upload_file", { tab, ref: many, paths: [token] }),
    e => e.code === "bad_file",
    "a file under the agents' directory is refused"
  );
  Assert.equal(alerts.opened, 0);
});

/**
 * macOS reaches the data volume by a second path (/System/Volumes/Data),
 * which realpath leaves as it is.
 */
add_task(
  { skip_if: () => AppConstants.platform != "macosx" },
  async function a_profile_file_by_its_data_volume_path_is_refused() {
    const { call, store, agent, tab, many } = await uploadSetup();
    await store.allowUploadFolders(
      agent.agentId,
      "example.com",
      [PathUtils.profileDir],
      false
    );
    const inProfile = PathUtils.join(
      PathUtils.profileDir,
      `sval-upload-${crypto.randomUUID()}.txt`
    );
    await IOUtils.writeUTF8(inProfile, "profile data");
    atTaskEnd(() => IOUtils.remove(inProfile));
    const other = "/System/Volumes/Data" + resolved(inProfile);
    Assert.ok(
      await IOUtils.exists(other),
      "the second spelling names the file"
    );
    await Assert.rejects(
      call("upload_file", { tab, ref: many, paths: [other] }),
      e => e.code === "bad_file",
      "it is refused"
    );
  }
);

/** A Windows junction into the profile is the profile. */
add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function a_junction_into_the_profile_is_refused() {
    const { call, store, agent, tab, many } = await uploadSetup();
    await store.allowUploadFolders(
      agent.agentId,
      "example.com",
      [PathUtils.profileDir],
      false
    );
    const inProfile = PathUtils.join(
      PathUtils.profileDir,
      `sval-upload-${crypto.randomUUID()}.txt`
    );
    await IOUtils.writeUTF8(inProfile, "profile data");
    atTaskEnd(() => IOUtils.remove(inProfile));
    const { dir } = await filesNamed();
    const junction = PathUtils.join(dir, "j");
    const cmd = await Subprocess.pathSearch("cmd.exe");
    const proc = await Subprocess.call({
      command: cmd,
      arguments: ["/c", "mklink", "/J", junction, PathUtils.profileDir],
    });
    Assert.equal((await proc.wait()).exitCode, 0, "the junction was made");
    atTaskEnd(() => IOUtils.remove(junction).catch(() => {}));
    await Assert.rejects(
      call("upload_file", {
        tab,
        ref: many,
        paths: [PathUtils.join(junction, PathUtils.filename(inProfile))],
      }),
      e => e.code === "bad_file",
      "a file reached through the junction is refused"
    );
  }
);

/**
 * Gecko follows no Windows link, so a path through one is refused before
 * anything opens it: a link to a share would offer that host the user's
 * credentials, and the page would get another file than the path names.
 * That holds for a folder the user allowed too.
 */
add_task(
  { skip_if: () => AppConstants.platform != "win" },
  async function a_path_through_a_junction_is_refused_unasked() {
    const { call, store, agent, alerts, tab, browser, many } =
      await uploadSetup();
    const target = await filesNamed("a.txt");
    const { dir } = await filesNamed();
    const junction = PathUtils.join(dir, "j");
    const cmd = await Subprocess.pathSearch("cmd.exe");
    const proc = await Subprocess.call({
      command: cmd,
      arguments: ["/c", "mklink", "/J", junction, target.dir],
    });
    Assert.equal((await proc.wait()).exitCode, 0, "the junction was made");
    atTaskEnd(() => IOUtils.remove(junction).catch(() => {}));
    await store.allowUploadFolders(
      agent.agentId,
      "example.com",
      [junction, target.dir],
      false
    );
    await Assert.rejects(
      call("upload_file", {
        tab,
        ref: many,
        paths: [PathUtils.join(junction, "a.txt")],
      }),
      e => e.code === "bad_file",
      "a file reached through the junction is refused"
    );
    Assert.equal(alerts.opened, 0, "unasked");
    Assert.deepEqual(
      (await call("upload_file", { tab, ref: many, paths: target.paths }))
        .files,
      ["a.txt"],
      "the same file by its own path goes"
    );
    Assert.deepEqual(await filesIn(browser, "many"), ["a.txt"]);
  }
);

/**
 * Sval marks its own profile directories, so the local one, which Gecko need
 * not mark, is known by what it holds too.
 */
add_task(async function svals_profile_directories_carry_its_mark() {
  await uploadSetup();
  for (const key of ["ProfD", "ProfLD"]) {
    const dir = Services.dirsvc.get(key, Ci.nsIFile).path;
    Assert.ok(
      await IOUtils.exists(PathUtils.join(dir, ".sval-profile")),
      `${key} carries .sval-profile`
    );
  }
});

/**
 * A Gecko profile that lost its `compatibility.ini` still holds `times.json`
 * and `prefs.js` together, and is refused.
 */
add_task(async function a_profile_without_compatibility_ini_is_refused() {
  const { call, store, agent, tab, many } = await uploadSetup();
  const { dir } = await filesNamed("times.json", "prefs.js");
  await store.allowUploadFolders(agent.agentId, "example.com", [dir], false);
  const file = PathUtils.join(dir, "logins.json");
  await IOUtils.writeUTF8(file, "secret");
  await Assert.rejects(
    call("upload_file", { tab, ref: many, paths: [file] }),
    e => e.code === "bad_file",
    "a file under times.json and prefs.js is refused"
  );
});

/**
 * A `times.json` alone is a file any project may hold, so it does not make
 * the directory a profile.
 */
add_task(async function a_project_with_a_times_json_is_no_profile() {
  const { call, store, agent, tab, many } = await uploadSetup();
  const { dir } = await filesNamed("times.json");
  await store.allowUploadFolders(agent.agentId, "example.com", [dir], false);
  const file = PathUtils.join(dir, "notes.txt");
  await IOUtils.writeUTF8(file, "notes");
  const result = await call("upload_file", { tab, ref: many, paths: [file] });
  Assert.deepEqual(result.files, ["notes.txt"], "the file is sent");
});
