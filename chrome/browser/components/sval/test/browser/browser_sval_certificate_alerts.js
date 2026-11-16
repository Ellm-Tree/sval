/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The alerts certificate import raises from C++
 * (`nsNSSCertificateDB::DisplayCertificateAlert`) are titled Certificates,
 * the title the certificate manager's own errors take.
 */

// A self-signed certificate whose private key was discarded when it was
// made, so importing it as one's own raises the no-private-key alert.
const CERT_BASE64 =
  "MIIBczCCARqgAwIBAgIUEKDudjb/DQLbe0UW239lnxajqzowCgYIKoZIzj0EAwIw" +
  "IDEeMBwGA1UEAwwVU3ZhbCB0ZXN0IGNlcnRpZmljYXRlMB4XDTI2MTAzMDA0NTUx" +
  "OVoXDTM2MTAyNzA0NTUxOVowIDEeMBwGA1UEAwwVU3ZhbCB0ZXN0IGNlcnRpZmlj" +
  "YXRlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyg5L4oEN7MQUwdvf8UJUccx6" +
  "QRJVgKbI2jpABi2+0rrlDZIO/NplIjJETMNvNnEn3MmDLzxpMbUqTd7Faz3s6aMy" +
  "MDAwHQYDVR0OBBYEFJOiGinexlVZmih6Zb3CJ6roFwQxMA8GA1UdEwEB/wQFMAMB" +
  "Af8wCgYIKoZIzj0EAwIDRwAwRAIgPIfgFTzjAIBHI0tifcegaP/A1CJqjAUiPgLF" +
  "XOEB6l8CIDp/11rmi2GAEVnei/goAxfKrSJaLTkOM/9WTfCz7Rlq";

add_task(async function a_certificate_alert_is_titled_certificates() {
  const certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
    Ci.nsIX509CertDB
  );
  const der = certdb.constructX509FromBase64(CERT_BASE64).getRawDER();

  let title = null;
  const answered = BrowserTestUtils.promiseAlertDialog("accept", undefined, {
    callback(win) {
      title = win.document.title;
      // A callback replaces the press `promiseAlertDialog` would make.
      win.document.querySelector("dialog").getButton("accept").click();
    },
  });
  // The alert spins its own event loop until it is answered.
  Services.tm.dispatchToMainThread(() => {
    Assert.throws(
      () => certdb.importUserCertificate(der, der.length, null),
      e => e.result === Cr.NS_ERROR_FAILURE,
      "a certificate without its private key is not imported"
    );
  });
  await within(answered, 10_000, "the no-private-key alert, answered");
  // The title `nsNSSCertificateDB::DisplayCertificateAlert` reads.
  const pipnss = Services.strings.createBundle(
    "chrome://pipnss/locale/pipnss.properties"
  );
  Assert.equal(
    title,
    pipnss.GetStringFromName("CertAlertTitle"),
    "the alert's title"
  );
});
