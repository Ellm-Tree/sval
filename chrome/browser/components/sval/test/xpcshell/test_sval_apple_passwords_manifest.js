/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * On macOS, Sval finds Apple's password helper through the manifest macOS
 * installs in the system Mozilla folder, the one file it reads from a folder
 * Firefox uses (decision 1738, patches/apple-passwords-manifest.patch).
 */

const { NativeManifests } = ChromeUtils.importESModule(
  "resource://gre/modules/NativeManifests.sys.mjs"
);
const { Schemas } = ChromeUtils.importESModule(
  "resource://gre/modules/Schemas.sys.mjs"
);
const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const NAME = "com.apple.passwordmanager";
const APPLES = `/Library/Application Support/Mozilla/NativeMessagingHosts/${NAME}.json`;

function contextFor(id) {
  return {
    extension: { id },
    manifestVersion: 2,
    envType: "addon_parent",
    url: null,
    jsonStringify(...args) {
      return JSON.stringify(...args);
    },
    cloneScope: globalThis,
    logError() {},
    preprocessors: {},
    callOnClose: () => {},
    forgetOnClose: () => {},
  };
}

add_task(async function apples_manifest_is_found_after_svals_own() {
  // Loading the schemas reads the extension startup cache in the profile
  // (StartupCache in ExtensionParent.sys.mjs).
  do_get_profile();
  await Schemas.load("chrome://extensions/content/schemas/manifest.json");

  // Sval's own folders are empty ones, so nothing this machine's user
  // installed answers the lookup.
  const own = await makeTempDir("sval-apple-passwords");
  const ownDir = await IOUtils.getDirectory(own);
  const provider = {
    getFile(property) {
      return property == "XREUserNativeManifests" ||
        property == "XRESysNativeManifests"
        ? ownDir.clone()
        : null;
    },
  };
  Services.dirsvc.registerProvider(provider);
  registerCleanupFunction(() => Services.dirsvc.unregisterProvider(provider));

  // macOS has shipped the file since 14. An older system has none, and then
  // the lookup finds nothing.
  const apples = (await IOUtils.exists(APPLES))
    ? await IOUtils.readJSON(APPLES)
    : null;
  const id = apples?.allowed_extensions[0] ?? "passwords@tests.sval.app";
  const context = contextFor(id);

  const found = await NativeManifests.lookupManifest("stdio", NAME, context);
  Assert.equal(
    found?.path ?? null,
    apples ? APPLES : null,
    "Apple's manifest is read from the system Mozilla folder when macOS has one"
  );
  Assert.equal(
    found?.manifest.path ?? null,
    apples?.path ?? null,
    "and it names the helper Apple's file names"
  );

  const hosts = PathUtils.join(own, "NativeMessagingHosts");
  await IOUtils.makeDirectory(hosts);
  const ownPath = PathUtils.join(hosts, `${NAME}.json`);
  await IOUtils.writeJSON(ownPath, {
    name: NAME,
    description: "test host",
    path: "/usr/bin/true",
    type: "stdio",
    allowed_extensions: [id],
  });
  Assert.equal(
    (await NativeManifests.lookupManifest("stdio", NAME, context))?.path,
    ownPath,
    "a manifest of that name in Sval's own folder is found first"
  );
});
