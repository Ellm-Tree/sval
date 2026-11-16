// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Sealing a document key under a twelve-character code, for a second device
//! to pick up by typing it (spec §6.7).
//!
//! The envelope on disk is plain JSON outside the seal itself. Schema, salt,
//! sealed key and the two timestamps are visible without the code, so a human
//! (or a host UI) can tell a file has expired without being able to open it. Only the 32-byte document key is secret, and it never appears
//! outside the AES-GCM ciphertext. The plain fields are the seal's associated
//! data, so editing `expiresAt` to revive a file breaks the tag.
//!
//! The wrapping key is derived from the code with Argon2id, so guessing is
//! bounded by a slow hash. A wrong code produces the wrong wrapping key, and
//! AES-GCM's tag then fails to verify: the seal is its own checksum, so there
//! is no separate "is this code right" check to drift from the real one.

use serde::{Deserialize, Serialize};

use crate::crypto::{self, Key};
use crate::hex::{decode as from_hex, encode as to_hex};
use crate::types::{Error, Timestamp};

/// Characters a pairing code is drawn from: uppercase alphanumeric, minus
/// `I`, `L`, `O` and `U`, each easy to misread against `1`, `1`, `0` and `V`
/// when read off one device and typed into another. Its length is a power of
/// two so five random bits map onto one character with no bias and no
/// rejection sampling.
pub const CODE_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const CODE_LEN: usize = 12;

const SCHEMA: u32 = 2;

/// The plain (unsealed) shape of a pairing file. Every field outside
/// `sealed` is visible without the code (see the module doc).
#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    schema: u32,
    salt: String,
    sealed: String,
    #[serde(rename = "createdAt")]
    created_at: Timestamp,
    #[serde(rename = "expiresAt")]
    expires_at: Timestamp,
}

/// Generates a fresh pairing code from [`CODE_ALPHABET`], ungrouped. A host
/// UI adds dashes for display.
///
/// Returns [`Error::NoEntropy`] if the host's entropy source fails at this
/// call.
pub fn generate_code() -> Result<String, Error> {
    let entropy: [u8; 8] = crypto::random_bytes()?;
    let alphabet: Vec<char> = CODE_ALPHABET.chars().collect();
    let mut bits: u64 = 0;
    for byte in &entropy {
        bits = (bits << 8) | u64::from(*byte);
    }
    let mut code = String::with_capacity(CODE_LEN);
    for i in 0..CODE_LEN {
        let shift = 64 - 5 * (i + 1);
        let index = ((bits >> shift) & 0x1F) as usize;
        code.push(alphabet[index]);
    }
    Ok(code)
}

/// Normalizes user-entered text into a code, or `None` if it cannot be one:
/// uppercases, drops dashes and spaces, and requires exactly twelve
/// characters remaining, every one of them in [`CODE_ALPHABET`].
pub fn normalize_code(input: &str) -> Option<String> {
    let cleaned: String = input
        .chars()
        .filter(|c| *c != '-' && !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if cleaned.chars().count() != CODE_LEN {
        return None;
    }
    if !cleaned.chars().all(|c| CODE_ALPHABET.contains(c)) {
        return None;
    }
    Some(cleaned)
}

/// Salt length, in bytes, a well-formed pairing file must carry.
const SALT_LEN: usize = 16;
/// Sealed-key length, in bytes: the 32-byte document key as
/// [`crypto::seal`] seals it.
const SEALED_LEN: usize = crypto::sealed_len(32);

/// The associated data a pairing file's seal is bound to: every plain field
/// of the envelope, so none can be changed without the code.
fn context(schema: u32, salt: &str, created_at: Timestamp, expires_at: Timestamp) -> Vec<u8> {
    format!("sval pairing\0{schema}\0{salt}\0{created_at}\0{expires_at}").into_bytes()
}

/// Argon2id cost parameters: 64 MiB, 2 passes, 1 lane, 32-byte output.
///
/// These are the whole security argument for the code: its 60 bits of entropy
/// are few enough that only an expensive guess stops an offline guesser.
/// **Do not lower them to speed up tests.**
/// `wrapping_key_matches_a_known_answer` pins the derivation's output, because
/// a round trip is symmetric and would not notice a matching change on both
/// sides.
const ARGON2_M_COST: u32 = 65_536;
const ARGON2_T_COST: u32 = 2;
const ARGON2_P_COST: u32 = 1;

/// Derives the 32-byte AES-256-GCM wrapping key for `code` and `salt` with
/// Argon2id. Parameters are fixed: a pairing file's cost has to match whatever
/// produced it exactly, and nothing on disk records parameters apart from the
/// schema version.
fn wrapping_key(code: &str, salt: &[u8]) -> Result<Key, Error> {
    let params = argon2::Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, Some(32))
        .map_err(|_| Error::MalformedPairingFile)?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(code.as_bytes(), salt, &mut out)
        .map_err(|_| Error::MalformedPairingFile)?;
    Key::from_bytes(&out)
}

/// Seals `key` so that only `code` opens it, until `now + ttl_ms`.
///
/// `code` is used exactly as given. Normalize user entry with
/// [`normalize_code`] first; [`generate_code`]'s output is already canonical.
///
/// A negative `ttl_ms` is clamped to zero, producing a file already expired at
/// `created_at`. A host may compute `ttl_ms` from a wall-clock deadline that
/// has already slipped, and that is no reason to fail the seal.
pub fn seal(key: &Key, code: &str, now: Timestamp, ttl_ms: i64) -> Result<Vec<u8>, Error> {
    // Fresh salt per seal: two seals of the same key must not let an observer
    // notice they share a wrapping key, and a reused salt undermines Argon2.
    let salt: [u8; SALT_LEN] = crypto::random_bytes()?;
    let wrap_key = wrapping_key(code, &salt)?;

    let salt = to_hex(&salt);
    let expires_at = now.saturating_add(ttl_ms.max(0) as u64);
    let sealed = crypto::seal(
        &wrap_key,
        &context(SCHEMA, &salt, now, expires_at),
        &key.to_bytes(),
    )?;
    let envelope = Envelope {
        schema: SCHEMA,
        salt,
        sealed: to_hex(&sealed),
        created_at: now,
        expires_at,
    };
    serde_json::to_vec(&envelope).map_err(Error::from)
}

/// Recovers the document key from a file produced by [`seal`], given the
/// code it was sealed under.
///
/// Fails with [`Error::MalformedPairingFile`] if `bytes` is not a
/// well-formed pairing file (bad JSON, unsupported schema, undecodable
/// hex, wrong-length fields), and with [`Error::BadPairingCode`] if the file
/// is well-formed but `code` does not open it. A host tells the user "this
/// file is broken" apart from "the code was wrong or this isn't the right
/// file" (spec §6.7).
pub fn open(bytes: &[u8], code: &str) -> Result<Key, Error> {
    let envelope: Envelope =
        serde_json::from_slice(bytes).map_err(|_| Error::MalformedPairingFile)?;
    check_schema(envelope.schema)?;
    let salt = from_hex(&envelope.salt).ok_or(Error::MalformedPairingFile)?;
    let sealed = from_hex(&envelope.sealed).ok_or(Error::MalformedPairingFile)?;
    // Reject before the Argon2id call: an attacker-supplied salt of arbitrary
    // length would otherwise be hashed in full at the 64 MiB cost.
    if salt.len() != SALT_LEN || sealed.len() != SEALED_LEN {
        return Err(Error::MalformedPairingFile);
    }

    let wrap_key = wrapping_key(code, &salt)?;
    let context = context(
        envelope.schema,
        &envelope.salt,
        envelope.created_at,
        envelope.expires_at,
    );
    let plaintext = crypto::open(&wrap_key, &context, &sealed).map_err(|err| match err {
        Error::SchemaTooNew { .. } => err,
        _ => Error::BadPairingCode,
    })?;
    Key::from_bytes(&plaintext).map_err(|_| Error::BadPairingCode)
}

/// Reads the expiry timestamp out of a pairing file without the code, so a
/// host can decide a code is stale before asking the user to type it.
pub fn expires_at(bytes: &[u8]) -> Result<Timestamp, Error> {
    let envelope: Envelope =
        serde_json::from_slice(bytes).map_err(|_| Error::MalformedPairingFile)?;
    check_schema(envelope.schema)?;
    Ok(envelope.expires_at)
}

/// Refuses a pairing file whose major schema is newer than this build knows
/// (`engine/CLAUDE.md` rule 11). `Error::SchemaTooNew` carries the two version
/// numbers a host needs to tell the user to update; `MalformedPairingFile`
/// means the file itself is broken.
fn check_schema(schema: u32) -> Result<(), Error> {
    if schema > SCHEMA {
        return Err(Error::SchemaTooNew {
            major: schema,
            supported: SCHEMA,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_codes_spread_over_every_character_and_position() {
        // A code's strength is its 60 random bits. If every character of the
        // alphabet appears, and every position varies, across 64 codes, the
        // bits reach each character; a miss by chance is below one in 10^9.
        let codes: Vec<String> = (0..64).map(|_| generate_code().unwrap()).collect();
        for code in &codes {
            assert_eq!(normalize_code(code).as_deref(), Some(code.as_str()));
        }
        for c in CODE_ALPHABET.chars() {
            assert!(codes.iter().any(|code| code.contains(c)), "{c} never drawn");
        }
        for at in 0..CODE_LEN {
            let first = codes[0].as_bytes()[at];
            assert!(
                codes.iter().any(|code| code.as_bytes()[at] != first),
                "position {at} never varies"
            );
        }
    }

    #[test]
    fn a_code_carries_the_key_and_a_wrong_one_does_not() {
        let key = Key::generate();
        let code = generate_code().unwrap();
        let file = seal(&key, &code, 1_000, 3_600_000).unwrap();

        assert_eq!(open(&file, &code).unwrap().to_bytes(), key.to_bytes());

        let wrong = normalize_code("K7Q4-8MTZ-3RJW").unwrap();
        assert!(matches!(open(&file, &wrong), Err(Error::BadPairingCode)));
    }

    #[test]
    fn a_tampered_seal_is_refused() {
        let key = Key::generate();
        let code = generate_code().unwrap();
        let file = seal(&key, &code, 1_000, 3_600_000).unwrap();

        let mut envelope: serde_json::Value = serde_json::from_slice(&file).unwrap();
        let sealed = envelope["sealed"].as_str().unwrap().to_string();
        let mut bytes = from_hex(&sealed).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        envelope["sealed"] = serde_json::Value::String(to_hex(&bytes));
        let tampered = serde_json::to_vec(&envelope).unwrap();

        assert!(matches!(open(&tampered, &code), Err(Error::BadPairingCode)));
    }

    #[test]
    fn an_extended_expiry_is_refused() {
        let key = Key::generate();
        let code = generate_code().unwrap();
        let file = seal(&key, &code, 1_000, 3_600_000).unwrap();

        let mut envelope: serde_json::Value = serde_json::from_slice(&file).unwrap();
        envelope["expiresAt"] = serde_json::Value::from(u64::MAX);
        let revived = serde_json::to_vec(&envelope).unwrap();

        assert!(matches!(open(&revived, &code), Err(Error::BadPairingCode)));
    }

    #[test]
    fn a_truncated_file_is_malformed_not_a_panic() {
        let key = Key::generate();
        let code = generate_code().unwrap();
        let file = seal(&key, &code, 1_000, 3_600_000).unwrap();

        // A body cut in half fails in the JSON parser, before the hex decode
        // and length checks in `open`. Truncating each valid field on its own
        // reaches every stage past the parse.
        let truncated = &file[..file.len() / 2];
        assert!(matches!(
            open(truncated, &code),
            Err(Error::MalformedPairingFile)
        ));

        let envelope: serde_json::Value = serde_json::from_slice(&file).unwrap();
        for field in ["salt", "sealed"] {
            let mut broken = envelope.clone();
            let full = broken[field].as_str().unwrap().to_string();
            broken[field] = serde_json::Value::String(full[..full.len() / 2].to_string());
            let bytes = serde_json::to_vec(&broken).unwrap();
            assert!(
                matches!(open(&bytes, &code), Err(Error::MalformedPairingFile)),
                "truncating {field} should be malformed, not reach the wrapping key or a panic"
            );
        }
    }

    #[test]
    fn the_code_alphabet_and_length_are_pinned() {
        // A code shown by one device is typed into another, which may run a
        // different build: both must agree on what a well-formed code is.
        assert_eq!(CODE_ALPHABET, "0123456789ABCDEFGHJKMNPQRSTVWXYZ");
        assert_eq!(CODE_LEN, 12);
    }

    #[test]
    fn entry_forgives_case_dashes_and_spaces() {
        assert_eq!(normalize_code(" k7q4-8mtz 3rjw ").unwrap(), "K7Q48MTZ3RJW");
    }

    #[test]
    fn ambiguous_letters_are_not_in_the_alphabet() {
        for bad in ['I', 'L', 'O', 'U'] {
            assert!(!CODE_ALPHABET.contains(bad));
        }
    }

    #[test]
    fn malformed_entry_is_rejected() {
        assert_eq!(normalize_code("too-short"), None);
        assert_eq!(normalize_code("k7q48mtz3rj!"), None);
    }

    #[test]
    fn two_seals_of_one_key_differ() {
        let key = Key::generate();
        let code = generate_code().unwrap();
        let a = seal(&key, &code, 1_000, 3_600_000).unwrap();
        let b = seal(&key, &code, 1_000, 3_600_000).unwrap();
        assert_ne!(a, b, "fresh salt and nonce should differ each seal");
    }

    #[test]
    fn two_seals_of_one_key_use_different_salts() {
        // A fresh nonce alone makes whole files differ, so the salt is checked
        // on its own: a constant salt lets an attacker pay Argon2id's cost once
        // and reuse the result against every pairing file the user writes.
        let key = Key::generate();
        let code = generate_code().unwrap();
        let a = seal(&key, &code, 1_000, 3_600_000).unwrap();
        let b = seal(&key, &code, 1_000, 3_600_000).unwrap();

        let salt_of = |file: &[u8]| -> String {
            let envelope: serde_json::Value = serde_json::from_slice(file).unwrap();
            envelope["salt"].as_str().unwrap().to_string()
        };
        assert_ne!(
            salt_of(&a),
            salt_of(&b),
            "salt must be fresh per seal, not reused across a user's files"
        );
    }

    #[test]
    fn expires_at_is_created_plus_ttl() {
        let key = Key::generate();
        let code = generate_code().unwrap();
        let file = seal(&key, &code, 1_000, 3_600_000).unwrap();
        assert_eq!(expires_at(&file).unwrap(), 1_000 + 3_600_000);
    }

    #[test]
    fn a_negative_ttl_clamps_to_an_already_expired_file() {
        let key = Key::generate();
        let code = generate_code().unwrap();
        let file = seal(&key, &code, 1_000, -1).unwrap();
        assert_eq!(
            expires_at(&file).unwrap(),
            1_000,
            "a negative ttl should clamp to zero, not underflow or propagate negative"
        );
    }

    #[test]
    fn an_unsupported_schema_says_to_update_not_that_the_file_is_broken() {
        let key = Key::generate();
        let code = generate_code().unwrap();
        let file = seal(&key, &code, 1_000, 3_600_000).unwrap();
        let mut envelope: serde_json::Value = serde_json::from_slice(&file).unwrap();
        envelope["schema"] = serde_json::Value::from(SCHEMA + 1);
        let future = serde_json::to_vec(&envelope).unwrap();

        assert!(matches!(
            open(&future, &code),
            Err(Error::SchemaTooNew {
                major: 3,
                supported: 2
            })
        ));
        assert!(matches!(
            expires_at(&future),
            Err(Error::SchemaTooNew {
                major: 3,
                supported: 2
            })
        ));
    }

    #[test]
    fn a_sealed_key_in_a_newer_format_says_to_update() {
        // The sealed field is a `crypto::seal` blob with its own version
        // byte, after the three-byte magic. A newer one is a reason to
        // update Sval, which the user must not be told is a wrong code.
        let key = Key::generate();
        let code = generate_code().unwrap();
        let file = seal(&key, &code, 1_000, 3_600_000).unwrap();
        let mut envelope: serde_json::Value = serde_json::from_slice(&file).unwrap();
        let mut sealed = from_hex(envelope["sealed"].as_str().unwrap()).unwrap();
        sealed[3] += 1;
        envelope["sealed"] = serde_json::Value::from(to_hex(&sealed));
        let future = serde_json::to_vec(&envelope).unwrap();

        assert!(matches!(
            open(&future, &code),
            Err(Error::SchemaTooNew {
                major: 2,
                supported: 1
            })
        ));
    }

    #[test]
    fn a_wrong_length_salt_is_rejected_before_hashing_it() {
        // An oversized, attacker-controlled salt must not be run through
        // Argon2id at all: letting the file dictate how much of that expense
        // is paid turns the KDF into a denial-of-service surface.
        let key = Key::generate();
        let code = generate_code().unwrap();
        let file = seal(&key, &code, 1_000, 3_600_000).unwrap();
        let mut envelope: serde_json::Value = serde_json::from_slice(&file).unwrap();
        envelope["salt"] = serde_json::Value::String(to_hex(&vec![0u8; 200_000]));
        let bloated = serde_json::to_vec(&envelope).unwrap();

        assert!(matches!(
            open(&bloated, &code),
            Err(Error::MalformedPairingFile)
        ));
    }

    #[test]
    fn a_wrong_length_sealed_field_is_rejected() {
        let key = Key::generate();
        let code = generate_code().unwrap();
        let file = seal(&key, &code, 1_000, 3_600_000).unwrap();
        let mut envelope: serde_json::Value = serde_json::from_slice(&file).unwrap();
        envelope["sealed"] = serde_json::Value::String(to_hex(&[0u8; 4]));
        let bytes = serde_json::to_vec(&envelope).unwrap();

        assert!(matches!(
            open(&bytes, &code),
            Err(Error::MalformedPairingFile)
        ));
    }

    #[test]
    fn wrapping_key_matches_a_known_answer() {
        // A round trip through `seal`/`open` cannot see the cost parameters:
        // the derivation is symmetric, so a lowered cost leaves it green. And
        // two devices on different builds derive the same wrapping key only
        // if both use the same parameters. This pins the derivation's output
        // for one fixed (code, salt) pair, so a change to the algorithm, the
        // cost parameters or the output length fails here, whether or not it
        // went through the named constants.
        //
        // This is the Argon2id output (`argon2::Algorithm::Argon2id`,
        // `Version::V0x13`) for code `"K7Q48MTZ3RJW"`, salt `[0x11; 16]`, and
        // the cost parameters m=65536 KiB, t=2, p=1, 32-byte output, produced
        // by this crate's own `wrapping_key`. A change to this vector is a
        // change to the KDF cost, which spec §6.7 decides.
        const EXPECTED: &str = "4a6a942e75d5ef3d93e45ce17d1c9e26d7301ca48ad619d3656591dcc697d179";

        let salt = [0x11u8; 16];
        let key = wrapping_key("K7Q48MTZ3RJW", &salt).unwrap();
        assert_eq!(to_hex(&key.to_bytes()), EXPECTED);
    }

    proptest::proptest! {
        /// A pairing file sits in a shared folder anyone with access can
        /// write: whatever it holds, opening it never panics.
        #[test]
        fn opening_any_bytes_never_panics(
            bytes in proptest::collection::vec(proptest::num::u8::ANY, 0..512),
        ) {
            let _ = open(&bytes, "K7Q48MTZ3RJW");
        }
    }

    proptest::proptest! {
        // Few cases: a damaged file whose fields keep their lengths reaches
        // the slow Argon2id derivation.
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(16))]

        /// A real pairing file with one byte changed never panics, and never
        /// hands back a key unless the change left the file meaning the same.
        #[test]
        fn a_damaged_pairing_file_never_panics(at in 0usize..1024, byte in 0u8..128) {
            let key = Key::generate();
            let code = generate_code().unwrap();
            let mut file = seal(&key, &code, 1_000, 3_600_000).unwrap();
            let at = at % file.len();
            file[at] = byte;
            if let Ok(opened) = open(&file, &code) {
                proptest::prop_assert_eq!(opened.to_bytes(), key.to_bytes());
            }
        }
    }
}
