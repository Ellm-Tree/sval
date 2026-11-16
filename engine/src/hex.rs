// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Lowercase hex: the one spelling Sval writes, and the only one it reads.
//!
//! Strict on purpose. A device id or a directory name that could be spelled
//! two ways would name one thing twice, so uppercase digits and anything
//! `u8::from_str_radix` would also forgive, such as a leading `+`, are refused.

pub(crate) fn encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

/// The bytes `text` spells, or `None` unless it is an even number of
/// lowercase hex digits.
pub(crate) fn decode(text: &str) -> Option<Vec<u8>> {
    fn digit(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            _ => None,
        }
    }
    let text = text.as_bytes();
    if !text.len().is_multiple_of(2) {
        return None;
    }
    text.chunks(2)
        .map(|pair| Some(digit(pair[0])? << 4 | digit(pair[1])?))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_byte() {
        let bytes: Vec<u8> = (0..=255).collect();
        assert_eq!(decode(&encode(&bytes)).unwrap(), bytes);
        assert_eq!(encode(&[0x0f, 0xa0]), "0fa0");
    }

    #[test]
    fn refuses_every_other_spelling() {
        for text in ["+f", "0F", "0", "0g", " 0", "-1", "\u{e9}"] {
            assert_eq!(decode(text), None, "{text:?}");
        }
        assert_eq!(decode(""), Some(vec![]));
    }

    proptest::proptest! {
        #[test]
        fn any_bytes_round_trip(bytes in proptest::collection::vec(proptest::num::u8::ANY, 0..64)) {
            proptest::prop_assert_eq!(decode(&encode(&bytes)), Some(bytes));
        }

        #[test]
        fn decoding_any_text_never_panics(text in ".*") {
            let _ = decode(&text);
        }
    }
}
