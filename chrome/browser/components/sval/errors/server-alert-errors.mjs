/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * TLS alerts the server sends to end the handshake. Unregistered, each falls
 * back to the `nssFailure2` entry, whose intro says the data's authenticity
 * could not be verified: the server sent no certificate to verify, and there
 * is nothing to override. The alerts about the client's own certificate,
 * malformed alert records and the protocol version alert, which has its own
 * entry in `ssl-errors.mjs`, keep their pages.
 */
const SERVER_ALERT_CODES = [
  "SSL_ERROR_BAD_MAC_ALERT",
  "SSL_ERROR_CLOSE_NOTIFY_ALERT",
  "SSL_ERROR_DECODE_ERROR_ALERT",
  "SSL_ERROR_DECOMPRESSION_FAILURE_ALERT",
  "SSL_ERROR_DECRYPTION_FAILED_ALERT",
  "SSL_ERROR_DECRYPT_ERROR_ALERT",
  "SSL_ERROR_EXPORT_RESTRICTION_ALERT",
  "SSL_ERROR_HANDSHAKE_FAILURE_ALERT",
  "SSL_ERROR_HANDSHAKE_UNEXPECTED_ALERT",
  "SSL_ERROR_ILLEGAL_PARAMETER_ALERT",
  "SSL_ERROR_INSUFFICIENT_SECURITY_ALERT",
  "SSL_ERROR_INTERNAL_ERROR_ALERT",
  "SSL_ERROR_MISSING_EXTENSION_ALERT",
  "SSL_ERROR_NO_RENEGOTIATION_ALERT",
  "SSL_ERROR_RECORD_OVERFLOW_ALERT",
  "SSL_ERROR_UNRECOGNIZED_NAME_ALERT",
  "SSL_ERROR_UNSUPPORTED_EXTENSION_ALERT",
  "SSL_ERROR_USER_CANCELED_ALERT",
];

export const SVAL_SERVER_ALERT_ERRORS = SERVER_ALERT_CODES.map(errorCode => ({
  id: errorCode,
  errorCode,
  category: "cert",
  bodyTitleL10nId: "nssFailure2-title",
  introContent: {
    dataL10nId: "fp-neterror-connection-intro",
    dataL10nArgs: { hostname: null },
  },
  buttons: {
    showTryAgain: true,
    showGoBack: false,
  },
  customNetError: {
    titleL10nId: "nssFailure2-title",
    whatCanYouDoL10nId: "certerror-bad-cert-domain-what-can-you-do-about-it",
  },
  hasNoUserFix: true,
}));
