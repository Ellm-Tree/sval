// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! How Sval and `sval-mcp` prove to each other that they can read the port file.
//!
//! The port file names a port and a token. A listener on that port can be
//! something else, because the file outlives a crashed Sval. And a client of
//! Sval's port can be any local process, so Sval must know the client read the
//! file too. The token is never sent. Each side sends the other a fresh nonce,
//! 64 lowercase hex characters, and gets back the hex HMAC-SHA256 of it, keyed
//! by the UTF-8 of the token's text:
//!
//! - Sval answers `sval-mcp`'s nonce with the MAC of `"sval:" + nonce`.
//! - `sval-mcp` answers Sval's nonce with the MAC of `"agent:" + nonce`.
//!
//! The two prefixes stop reflection. A MAC either side makes can never pass as
//! the other side's, so neither can be used to answer its own challenge. A
//! proof recorded for one nonce is useless against the next.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Hex characters in a token or a nonce: 32 bytes.
pub const HEX_LEN: usize = 64;

/// Which side a proof speaks for. Each signs under its own prefix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// Sval, answering `sval-mcp`'s challenge.
    Sval,
    /// `sval-mcp`, answering Sval's challenge.
    Agent,
}

impl Side {
    fn prefix(self) -> &'static str {
        match self {
            Side::Sval => "sval:",
            Side::Agent => "agent:",
        }
    }
}

/// Whether `text` is 64 lowercase hex characters, the only form a token or a
/// nonce takes.
pub fn is_hex64(text: &str) -> bool {
    text.len() == HEX_LEN && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

/// 32 fresh random bytes as 64 lowercase hex characters.
pub fn fresh_nonce() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; HEX_LEN / 2];
    getrandom::fill(&mut bytes)?;
    Ok(to_hex(&bytes))
}

fn mac_for(token: &str, side: Side, nonce: &str) -> HmacSha256 {
    let mut mac =
        HmacSha256::new_from_slice(token.as_bytes()).expect("HMAC accepts a key of any length");
    mac.update(side.prefix().as_bytes());
    mac.update(nonce.as_bytes());
    mac
}

/// What `side` answers to `nonce` when the port file's token is `token`.
pub fn proof_for(token: &str, side: Side, nonce: &str) -> String {
    to_hex(&mac_for(token, side, nonce).finalize().into_bytes())
}

/// Whether `proof` is `side`'s answer to `nonce` under `token`. The comparison
/// takes the same time wherever the proof differs, and a proof that is not
/// valid hex does not match.
pub fn verify(token: &str, side: Side, nonce: &str, proof: &str) -> bool {
    match from_hex(proof) {
        Some(bytes) => mac_for(token, side, nonce).verify_slice(&bytes).is_ok(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const NONCE: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    /// Computed with Python's hmac module, which Sval's WebCrypto must agree
    /// with: HMAC-SHA256 keyed by the token's text over `"sval:"` or `"agent:"`
    /// followed by the nonce's text.
    const SVAL_VECTOR: &str = "06bf7a6e23313d6e35442d7ca05118e5206f1511f65e0da0d14c719ea0b109d4";
    const AGENT_VECTOR: &str = "8250d82b0207bd5bf671b20aad92933ab149f5a1fdfa075771a9ba12fea34904";

    #[test]
    fn matches_an_independent_hmac_sha256_for_each_prefix() {
        assert_eq!(proof_for(TOKEN, Side::Sval, NONCE), SVAL_VECTOR);
        assert_eq!(proof_for(TOKEN, Side::Agent, NONCE), AGENT_VECTOR);
        assert!(verify(TOKEN, Side::Sval, NONCE, SVAL_VECTOR));
        assert!(verify(TOKEN, Side::Agent, NONCE, AGENT_VECTOR));
    }

    #[test]
    fn a_proof_for_one_side_never_passes_for_the_other() {
        assert!(!verify(TOKEN, Side::Agent, NONCE, SVAL_VECTOR), "reflected");
        assert!(!verify(TOKEN, Side::Sval, NONCE, AGENT_VECTOR), "reflected");
    }

    #[test]
    fn verifies_only_the_proof_for_that_nonce_and_token() {
        for side in [Side::Sval, Side::Agent] {
            let proof = proof_for(TOKEN, side, NONCE);
            assert!(verify(TOKEN, side, NONCE, &proof));
            assert!(
                !verify(TOKEN, side, &"a".repeat(64), &proof),
                "another nonce"
            );
            assert!(
                !verify(&"b".repeat(64), side, NONCE, &proof),
                "another token"
            );
            assert!(!verify(TOKEN, side, NONCE, "not hex"));
            assert!(!verify(TOKEN, side, NONCE, ""));
            assert!(!verify(TOKEN, side, NONCE, &proof[..62]), "truncated");
            assert!(
                !verify(TOKEN, side, NONCE, TOKEN),
                "the token is not a proof"
            );
        }
    }

    #[test]
    fn nonces_are_fresh_lowercase_hex() {
        let (a, b) = (fresh_nonce().unwrap(), fresh_nonce().unwrap());
        assert!(is_hex64(&a) && a == a.to_lowercase());
        assert_ne!(a, b);
    }

    #[test]
    fn a_token_or_nonce_must_be_64_lowercase_hex_characters() {
        assert!(is_hex64(TOKEN));
        assert!(!is_hex64(""));
        assert!(!is_hex64(&"g".repeat(64)));
        assert!(!is_hex64(&"a".repeat(63)));
        assert!(!is_hex64(&"A".repeat(64)), "uppercase");
        assert!(!is_hex64(&"+a".repeat(32)));
    }
}
