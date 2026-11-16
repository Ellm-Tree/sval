/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* globals browser */

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
const { SubprocessImpl } = ChromeUtils.importESModule(
  "resource://gre/modules/subprocess/subprocess_unix.sys.mjs"
);
const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

AddonTestUtils.init(this);
AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "1",
  "42"
);
ExtensionTestUtils.init(this);

const ID = "native-host@tests.sval.app";
const HOST = "sval_closed_input";

/**
 * A native messaging host that closes its stdin has said it reads nothing
 * more, as one that exits has. An extension that writes to it then, as
 * password managers' extensions do whenever the selected tab changes, must
 * see its port end without the browser logging "File closed" as an error
 * (patches/native-messaging-closed-host.patch).
 */
add_task(async function a_write_to_a_host_that_stopped_reading_ends_quietly() {
  const dir = await makeTempDir("sval-native-hosts");
  const hosts = PathUtils.join(
    dir,
    AppConstants.platform == "linux"
      ? "native-messaging-hosts"
      : "NativeMessagingHosts"
  );
  await IOUtils.makeDirectory(hosts);
  // Closes stdin, then sends "ready" (a native-endian length of 7 and the
  // JSON string), and stays up until the port's cleanup kills it.
  const script = PathUtils.join(hosts, `${HOST}.sh`);
  await IOUtils.writeUTF8(
    script,
    "#!/bin/sh\nexec 0<&-\nprintf '\\007\\000\\000\\000\"ready\"'\nexec sleep 60\n"
  );
  await IOUtils.setPermissions(script, 0o755);
  await IOUtils.writeJSON(PathUtils.join(hosts, `${HOST}.json`), {
    name: HOST,
    description: "a host that closed its stdin",
    path: script,
    type: "stdio",
    allowed_extensions: [ID],
  });
  const provider = {
    getFile(property) {
      return property == "XREUserNativeManifests" ||
        property == "XRESysNativeManifests"
        ? new FileUtils.File(dir)
        : null;
    },
  };
  Services.dirsvc.registerProvider(provider);
  registerCleanupFunction(() => Services.dirsvc.unregisterProvider(provider));

  const errors = [];
  const listener = {
    observe(message) {
      if (
        message instanceof Ci.nsIScriptError &&
        !(message.flags & Ci.nsIScriptError.warningFlag)
      ) {
        errors.push(message.errorMessage);
      }
    },
  };
  Services.console.registerListener(listener);
  registerCleanupFunction(() => Services.console.unregisterListener(listener));

  const extension = ExtensionTestUtils.loadExtension({
    background() {
      const port = browser.runtime.connectNative("sval_closed_input");
      port.onMessage.addListener(() => port.postMessage("after ready"));
      port.onDisconnect.addListener(ended =>
        browser.test.sendMessage("disconnected", ended.error?.message ?? null)
      );
    },
    manifest: {
      browser_specific_settings: { gecko: { id: ID } },
      permissions: ["nativeMessaging"],
    },
  });
  await extension.startup();

  Assert.equal(
    await within(extension.awaitMessage("disconnected"), 10_000, "the port"),
    null,
    "the extension hears its port end, with no error"
  );
  await extension.unload();
  await within(
    SubprocessImpl.Process.getWorker().call("waitForNoProcesses", []),
    20_000,
    "the host's exit"
  );
  Assert.deepEqual(errors, [], "nothing logged a console error");
});
