// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Encryption and hashing primitives for workspace data at rest and in sync payloads.
//!
//! # Threat model
//!
//! This protects the contents of a [`crate::types::Document`] from the storage
//! provider (iCloud, OneDrive, a plain folder) and from anyone who obtains the
//! stored files directly. It does **not** protect against someone with the
//! unlocked device: the key lives there, unencrypted, for the crate to use.
//! The provider still sees file sizes, counts and write times, so activity is
//! observable to it even though content is not; [`hashed_name`] keeps it from
//! also reading workspace names off the directory listing.
//!
//! # Keys
//!
//! A [`Key`] is the 256-bit root a user stores. Nothing uses it directly:
//! HKDF-SHA256 derives one subkey for [`seal`]/[`open`] and another for
//! [`hashed_name`], so no key ever serves two algorithms.

use aes_gcm::{
    Aes256Gcm,
    aead::{
        Aead, AeadCore, Generate, Key as AeadKey, KeyInit, Nonce, Payload, array::typenum::Unsigned,
    },
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::types::Error;

/// The first bytes of every sealed file, so [`open`] can tell a Sval file
/// from arbitrary bytes before trusting its version.
const MAGIC: &[u8; 3] = b"svl";

/// The byte after [`MAGIC`]. Raise it for any change to the layout, the
/// associated data, or how the subkeys are derived.
const FORMAT_VERSION: u8 = 1;

/// [`MAGIC`] then [`FORMAT_VERSION`]: the plain header every sealed file
/// starts with.
const HEADER: [u8; 4] = [MAGIC[0], MAGIC[1], MAGIC[2], FORMAT_VERSION];

const NONCE_LEN: usize = 12;

/// The length of what [`seal`] makes of `plaintext_len` bytes.
pub(crate) const fn sealed_len(plaintext_len: usize) -> usize {
    HEADER.len() + NONCE_LEN + plaintext_len + <Aes256Gcm as AeadCore>::TagSize::USIZE
}

/// HKDF `info` labels, one per subkey.
const SEAL_INFO: &[u8] = b"sval seal v1";
const NAME_INFO: &[u8] = b"sval name v1";

/// `N` bytes from the host's entropy source, or [`Error::NoEntropy`] if that
/// source fails at this call. On `wasm32-unknown-unknown` the `wasm_js`
/// `getrandom` backend can fail per call, and [`seal`]'s nonce says why a
/// panic there is unacceptable.
pub(crate) fn random_bytes<const N: usize>() -> Result<[u8; N], Error> {
    <[u8; N]>::try_generate().map_err(|_| Error::NoEntropy)
}

/// A 256-bit root key, with the subkeys derived from it.
///
/// Opaque: callers move key bytes only through [`Key::to_bytes`] and
/// [`Key::from_bytes`] at the edges (secure storage, key exchange).
pub struct Key {
    root: [u8; 32],
    seal: AeadKey<Aes256Gcm>,
    name: [u8; 32],
}

impl Key {
    /// Generates a fresh random key from the host's entropy source, panicking
    /// if that source fails (see [`Key::try_generate`]).
    pub fn generate() -> Self {
        Self::derive(AeadKey::<Aes256Gcm>::generate().into())
    }

    /// Generates a fresh random key, failing instead of panicking if the
    /// host's entropy source fails at call time.
    ///
    /// Prefer this over [`Key::generate`] on any path a host can reach
    /// repeatedly at runtime, such as pairing a device. On
    /// `wasm32-unknown-unknown` the `wasm_js` `getrandom` backend can fail
    /// per call, and `generate()` panics on that failure. [`seal`]'s nonce
    /// says why a panic there is unacceptable.
    pub fn try_generate() -> Result<Self, Error> {
        random_bytes().map(Self::derive)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        let root = <[u8; 32]>::try_from(bytes)
            .map_err(|_| Error::InvalidKeyLength { got: bytes.len() })?;
        Ok(Self::derive(root))
    }

    /// Exports the raw root key bytes, for callers that persist or exchange keys.
    pub fn to_bytes(&self) -> [u8; 32] {
        self.root
    }

    fn derive(root: [u8; 32]) -> Self {
        let hkdf = Hkdf::<Sha256>::new(None, &root);
        let mut seal = [0u8; 32];
        let mut name = [0u8; 32];
        // 32 bytes is far below HKDF-SHA256's 8160-byte output limit.
        hkdf.expand(SEAL_INFO, &mut seal)
            .expect("32 bytes is a valid HKDF-SHA256 length");
        hkdf.expand(NAME_INFO, &mut name)
            .expect("32 bytes is a valid HKDF-SHA256 length");
        Self {
            root,
            seal: seal.into(),
            name,
        }
    }
}

fn associated_data(context: &[u8]) -> Vec<u8> {
    [&HEADER[..], context].concat()
}

/// Encrypts `plaintext` under `key`, bound to `context`, using a fresh
/// random nonce.
///
/// The sealed layout is the 4-byte `HEADER`, a 12-byte nonce, then the GCM
/// ciphertext and tag. The header and `context` are authenticated as
/// associated data, so [`open`] fails unless it is given
/// the same `context`. For a stored document that is its storage path, which
/// stops a provider passing one device's or one workspace's file off as
/// another's.
///
/// The nonce is not secret; it must never repeat under one key, so a fresh
/// one is drawn on every call. A counter can be reset by a reinstalled app,
/// and a truncated timestamp can collide.
pub fn seal(key: &Key, context: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, Error> {
    let cipher = Aes256Gcm::new(&key.seal);
    // On `wasm32-unknown-unknown` the `wasm_js` `getrandom` backend can fail
    // at call time (the host has no `crypto.getRandomValues`, or the call
    // throws), and `generate()` panics on that failure. This runs on every
    // write `sync` makes, so an `Err` lets `sync` report it instead of
    // taking down the module.
    let nonce = Nonce::<Aes256Gcm>::try_generate().map_err(|_| Error::NoEntropy)?;
    let aad = associated_data(context);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| Error::EncryptionFailed)?;
    let mut out = Vec::with_capacity(HEADER.len() + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&HEADER);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypts bytes produced by [`seal`] with the same `context`.
///
/// Fails if `key` or `context` is wrong or `sealed` was tampered with: the
/// GCM tag covers the whole ciphertext and the associated data, so a single
/// flipped bit anywhere rejects it. A Sval file whose version is newer than
/// this build's is [`Error::SchemaTooNew`], so a caller can say "update Sval"
/// instead of "this file is damaged".
pub fn open(key: &Key, context: &[u8], sealed: &[u8]) -> Result<Vec<u8>, Error> {
    let Some(rest) = sealed.strip_prefix(&MAGIC[..]) else {
        return Err(Error::DecryptionFailed);
    };
    let Some((&version, rest)) = rest.split_first() else {
        return Err(Error::DecryptionFailed);
    };
    if version > FORMAT_VERSION {
        return Err(Error::SchemaTooNew {
            major: u32::from(version),
            supported: u32::from(FORMAT_VERSION),
        });
    }
    if version != FORMAT_VERSION || rest.len() < NONCE_LEN {
        return Err(Error::DecryptionFailed);
    }
    let (nonce_bytes, ciphertext) = rest.split_at(NONCE_LEN);
    let nonce = Nonce::<Aes256Gcm>::try_from(nonce_bytes).map_err(|_| Error::DecryptionFailed)?;
    let aad = associated_data(context);
    Aes256Gcm::new(&key.seal)
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| Error::DecryptionFailed)
}

/// Derives a filename-safe, deterministic name for `name`: HMAC-SHA256 under
/// `key`'s name subkey, as lowercase hex.
///
/// This is what a workspace's cloud-storage directory is named. Keying the
/// hash means someone with only the directory listing cannot confirm a
/// guessed workspace name by hashing their guess and comparing.
pub fn hashed_name(key: &Key, name: &str) -> String {
    let mut mac = <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(&key.name)
        .expect("HMAC accepts keys of any length");
    mac.update(name.as_bytes());
    crate::hex::encode(&mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTEXT: &[u8] = b"sval/ws/abc/0001.json";

    /// `bytes(range(32))`: the root key the known-answer vectors below were
    /// computed from, with Python's `hmac` and `hashlib`, outside this crate.
    fn fixed_key() -> Key {
        let bytes: Vec<u8> = (0u8..32).collect();
        Key::from_bytes(&bytes).unwrap()
    }

    fn hex(text: &str) -> Vec<u8> {
        crate::hex::decode(text).unwrap()
    }

    #[test]
    fn seal_then_open_round_trips() {
        let key = Key::generate();
        let sealed = seal(&key, CONTEXT, b"workspace tree").unwrap();
        assert_eq!(open(&key, CONTEXT, &sealed).unwrap(), b"workspace tree");
    }

    #[test]
    fn sealed_len_is_the_length_seal_makes() {
        let key = Key::generate();
        for len in [0, 1, 32, 1000] {
            let sealed = seal(&key, CONTEXT, &vec![7; len]).unwrap();
            assert_eq!(sealed.len(), sealed_len(len));
        }
    }

    #[test]
    fn random_bytes_differ_between_draws() {
        let a: [u8; 32] = random_bytes().unwrap();
        let b: [u8; 32] = random_bytes().unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn sealing_twice_gives_different_bytes() {
        // Reusing a nonce under the same key breaks GCM's confidentiality and
        // integrity.
        let key = Key::generate();
        let a = seal(&key, CONTEXT, b"same input").unwrap();
        let b = seal(&key, CONTEXT, b"same input").unwrap();
        assert_ne!(a, b, "nonce appears to be reused");
    }

    #[test]
    fn the_wrong_key_fails_rather_than_returning_garbage() {
        let sealed = seal(&Key::generate(), CONTEXT, b"secret").unwrap();
        assert!(matches!(
            open(&Key::generate(), CONTEXT, &sealed),
            Err(Error::DecryptionFailed)
        ));
    }

    #[test]
    fn every_truncation_of_a_sealed_file_fails_to_open() {
        // A cut inside the nonce must be refused before the nonce is split
        // off, and a cut anywhere after it must fail the tag.
        let key = fixed_key();
        let sealed = seal(&key, CONTEXT, b"secret").unwrap();
        for len in 0..sealed.len() {
            assert!(
                matches!(
                    open(&key, CONTEXT, &sealed[..len]),
                    Err(Error::DecryptionFailed)
                ),
                "a file cut to {len} bytes opened"
            );
        }
    }

    #[test]
    fn tampering_is_detected() {
        let key = Key::generate();
        let mut sealed = seal(&key, CONTEXT, b"secret").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert!(
            matches!(open(&key, CONTEXT, &sealed), Err(Error::DecryptionFailed)),
            "GCM tag did not reject tampering"
        );
    }

    #[test]
    fn a_file_moved_to_another_context_does_not_open() {
        let key = Key::generate();
        let sealed = seal(&key, CONTEXT, b"secret").unwrap();
        assert!(matches!(
            open(&key, b"sval/ws/abc/0002.json", &sealed),
            Err(Error::DecryptionFailed)
        ));
    }

    #[test]
    fn the_layout_is_version_nonce_ciphertext_under_the_derived_seal_key() {
        let sealed = seal(&fixed_key(), CONTEXT, b"workspace tree").unwrap();
        assert_eq!(&sealed[..4], b"svl\x01");
        assert_eq!(sealed.len(), 4 + 12 + b"workspace tree".len() + 16);

        let seal_key = hex("51f786d1222ccfb8d99697bd1498bdb1b620dcf3f9460090d690207e44bce8cb");
        let cipher = Aes256Gcm::new_from_slice(&seal_key).unwrap();
        let nonce = Nonce::<Aes256Gcm>::try_from(&sealed[4..16]).unwrap();
        let aad = [&b"svl\x01"[..], CONTEXT].concat();
        let plaintext = cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &sealed[16..],
                    aad: &aad,
                },
            )
            .unwrap();
        assert_eq!(plaintext, b"workspace tree");
    }

    #[test]
    fn a_newer_format_version_is_reported_as_too_new() {
        let key = Key::generate();
        let mut sealed = seal(&key, CONTEXT, b"secret").unwrap();
        sealed[3] = FORMAT_VERSION + 1;
        assert!(matches!(
            open(&key, CONTEXT, &sealed),
            Err(Error::SchemaTooNew { major, supported })
                if major == u32::from(FORMAT_VERSION) + 1
                    && supported == u32::from(FORMAT_VERSION)
        ));
    }

    #[test]
    fn an_older_or_absent_version_fails_to_open() {
        let key = Key::generate();
        let mut sealed = seal(&key, CONTEXT, b"secret").unwrap();
        sealed[3] = 0;
        assert!(matches!(
            open(&key, CONTEXT, &sealed),
            Err(Error::DecryptionFailed)
        ));
        assert!(matches!(
            open(&key, CONTEXT, &[]),
            Err(Error::DecryptionFailed)
        ));
    }

    #[test]
    fn bytes_without_the_magic_are_undecryptable_rather_than_too_new() {
        assert!(matches!(
            open(&Key::generate(), CONTEXT, b"not encrypted"),
            Err(Error::DecryptionFailed)
        ));
    }

    #[test]
    fn hashed_names_hide_workspace_names_and_are_stable() {
        let key = Key::generate();
        let a = hashed_name(&key, "Client A");
        assert_eq!(a, hashed_name(&key, "Client A"), "not deterministic");
        assert_ne!(a, hashed_name(&key, "Client B"));
        assert!(!a.contains("Client"));
        assert!(
            a.chars().all(|c| c.is_ascii_alphanumeric()),
            "must be filename-safe"
        );
    }

    #[test]
    fn hashed_name_is_hmac_sha256_under_the_derived_name_key() {
        assert_eq!(
            hashed_name(&fixed_key(), "ws-1"),
            "920782d219eee4893c56213c70e397bc6c791f3d785902c92facec237bbbfb50"
        );
    }

    #[test]
    fn key_survives_a_bytes_round_trip() {
        let key = Key::generate();
        let restored = Key::from_bytes(&key.to_bytes()).unwrap();
        let sealed = seal(&key, CONTEXT, b"x").unwrap();
        assert_eq!(open(&restored, CONTEXT, &sealed).unwrap(), b"x");
    }

    proptest::proptest! {
        /// Whatever a provider hands back, opening it answers `Ok` or `Err`
        /// and never panics.
        #[test]
        fn opening_any_bytes_never_panics(
            bytes in proptest::collection::vec(proptest::num::u8::ANY, 0..256),
            context in proptest::collection::vec(proptest::num::u8::ANY, 0..64),
        ) {
            let _ = open(&fixed_key(), &context, &bytes);
        }

        /// A sealed file with one byte changed never opens.
        #[test]
        fn a_sealed_file_with_any_byte_changed_does_not_open(at in 0usize..64, flip in 1u8..=255) {
            let key = fixed_key();
            let mut sealed = seal(&key, CONTEXT, b"workspace tree").unwrap();
            let at = at % sealed.len();
            sealed[at] ^= flip;
            // A flip in the version byte can raise it past ours, which is
            // refused as too new before the tag is ever checked.
            let opened = open(&key, CONTEXT, &sealed);
            proptest::prop_assert!(
                matches!(opened, Err(Error::DecryptionFailed | Error::SchemaTooNew { .. })),
                "{:?}",
                opened
            );
        }
    }
}
