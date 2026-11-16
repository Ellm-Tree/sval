/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * On Windows, Sval finds a native messaging host through its own registry
 * key and never through Software\Mozilla, which Firefox reads
 * (decision 1738, patches/native-messaging-manifests.patch).
 */

const { MockRegistry } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistry.sys.mjs"
);
const { NativeManifests } = ChromeUtils.importESModule(
  "resource://gre/modules/NativeManifests.sys.mjs"
);
const { Schemas } = ChromeUtils.importESModule(
  "resource://gre/modules/Schemas.sys.mjs"
);
const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const ID = "native-key@tests.sval.app";

const context = {
  extension: { id: ID },
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

async function writeManifest(dir, name) {
  const path = PathUtils.join(dir, `${name}.json`);
  await IOUtils.writeJSON(path, {
    name,
    description: "test host",
    path: "C:\\host.exe",
    type: "stdio",
    allowed_extensions: [ID],
  });
  return path;
}

add_task(async function hosts_are_found_under_svals_own_key() {
  // Loading the schemas reads the extension startup cache in the profile
  // (StartupCache in ExtensionParent.sys.mjs).
  do_get_profile();
  await Schemas.load("chrome://extensions/content/schemas/manifest.json");
  const registry = new MockRegistry();
  registerCleanupFunction(() => registry.shutdown());
  const dir = await makeTempDir("sval-native-key");

  const own = "sval_own_key";
  registry.setValue(
    Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
    `Software\\Sval\\NativeMessagingHosts\\${own}`,
    "",
    await writeManifest(dir, own)
  );
  const mozillas = "sval_mozilla_key";
  registry.setValue(
    Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
    `Software\\Mozilla\\NativeMessagingHosts\\${mozillas}`,
    "",
    await writeManifest(dir, mozillas)
  );

  const found = await NativeManifests.lookupManifest("stdio", own, context);
  Assert.equal(
    found?.manifest.name,
    own,
    "a host under Software\\Sval is found"
  );
  Assert.equal(
    await NativeManifests.lookupManifest("stdio", mozillas, context),
    null,
    "a host under Software\\Mozilla is not"
  );
});
