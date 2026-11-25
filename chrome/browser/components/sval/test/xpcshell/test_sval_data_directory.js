/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// The profile service starts on Sval's one data directory, whatever
// profiles.ini and installs.ini say, and never writes either file.

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

do_get_profile();

/**
 * A profile database as a Firefox build leaves it: a group profile marked to
 * show the selector, set as this install's default, and a second profile.
 *
 * @param {string} hash This install's hash.
 * @returns {{profiles: string, installs: string}}
 */
function firefoxDatabase(hash) {
  return {
    profiles: [
      "[General]",
      "StartWithLastProfile=0",
      "Version=2",
      "",
      "[Profile0]",
      "Name=default-release",
      "IsRelative=1",
      "Path=Profiles/abc.default-release",
      "StoreID=8736440c",
      "ShowSelector=1",
      "Default=1",
      "",
      "[Profile1]",
      "Name=other",
      "IsRelative=1",
      "Path=Profiles/def.other",
      "",
      `[Install${hash}]`,
      "Default=Profiles/abc.default-release",
      "Locked=1",
      "",
    ].join("\n"),
    installs: [`[${hash}]`, "Default=Profiles/abc.default-release", ""].join(
      "\n"
    ),
  };
}

add_task(async function test_starts_on_the_data_directory() {
  const appData = await makeTempDir("sval-data-directory-");
  const localData = await makeTempDir("sval-data-directory-local-");
  // scripts/test.sh sets these on macOS, and they take precedence over the
  // provider's own directories (nsXREDirProvider::GetUserDataDirectory).
  const saved = ["MOZ_APP_DATA", "MOZ_LOCAL_APP_DATA"].map(name => [
    name,
    Services.env.get(name),
  ]);
  registerCleanupFunction(() => {
    for (const [name, value] of saved) {
      Services.env.set(name, value);
    }
  });
  Services.env.set("MOZ_APP_DATA", appData);
  Services.env.set("MOZ_LOCAL_APP_DATA", localData);
  const provider = Cc["@mozilla.org/xre/directory-provider;1"].getService(
    Ci.nsIXREDirProvider
  );

  const database = firefoxDatabase(provider.getInstallHash());
  const profilesIni = PathUtils.join(appData, "profiles.ini");
  const installsIni = PathUtils.join(appData, "installs.ini");
  await IOUtils.writeUTF8(profilesIni, database.profiles);
  await IOUtils.writeUTF8(installsIni, database.installs);

  const service = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
    Ci.nsIToolkitProfileService
  );
  Assert.equal(service.profileCount, 1, "the service knows one profile");
  Assert.ok(service.startWithLastProfile, "no profile manager is asked for");

  const data = service.defaultProfile;
  Assert.equal(data.name, "default");
  Assert.equal(data.rootDir.path, PathUtils.join(appData, "Data"));
  Assert.equal(data.localDir.path, PathUtils.join(localData, "Data"));

  const rootDir = {};
  const localDir = {};
  const profile = {};
  const didCreate = service.selectStartupProfile(
    ["xpcshell"],
    false,
    AppConstants.MOZ_UPDATE_CHANNEL,
    "",
    rootDir,
    localDir,
    profile
  );
  Assert.ok(!didCreate, "no profile is made");
  Assert.strictEqual(profile.value, data, "Sval starts on its data directory");
  Assert.equal(rootDir.value.path, data.rootDir.path);
  Assert.equal(localDir.value.path, data.localDir.path);
  Assert.ok(
    await IOUtils.exists(data.rootDir.path),
    "starting on the data directory makes it"
  );

  service.flush();
  await service.asyncFlush();
  Assert.equal(
    await IOUtils.readUTF8(profilesIni),
    database.profiles,
    "profiles.ini is left as it was"
  );
  Assert.equal(
    await IOUtils.readUTF8(installsIni),
    database.installs,
    "installs.ini is left as it was"
  );
});
