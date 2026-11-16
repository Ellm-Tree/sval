// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The helper's frames on its stdin and stdout, sval-mcp's format
//! (`tools/sval-mcp/src/frame.rs`): a 4-byte big-endian length, then UTF-8
//! JSON, refused over `MAX_FRAME_BYTES` on both sides.

use serde_json::Value;
use std::io::{self, Read, Write};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// A message whose JSON is over `MAX_FRAME_BYTES`, which the browser refuses
/// to read.
#[derive(Debug, PartialEq, Eq)]
pub struct TooLarge;

/// `message` as one whole frame, header included.
pub fn encode_frame(message: &Value) -> Result<Vec<u8>, TooLarge> {
    let body = serde_json::to_vec(message).expect("a Value always serializes");
    if body.len() > MAX_FRAME_BYTES {
        return Err(TooLarge);
    }
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

pub fn write_frame(w: &mut impl Write, message: &Value) -> io::Result<()> {
    let frame = encode_frame(message).map_err(|TooLarge| {
        io::Error::new(io::ErrorKind::InvalidData, "frame exceeds the limit")
    })?;
    w.write_all(&frame)?;
    w.flush()
}

/// The next frame, or `None` at a clean end of stream between frames.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Value>> {
    let mut header = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match r.read(&mut header[got..])? {
            0 if got == 0 => return Ok(None),
            0 => return Err(io::ErrorKind::UnexpectedEof.into()),
            n => got += n,
        }
    }
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "declared frame exceeds the limit",
        ));
    }
    let mut body = vec![0u8; length];
    r.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(io::Error::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Cursor, Read};

    /// Reads one byte per call, as a pipe may.
    struct Trickle(Cursor<Vec<u8>>);
    impl Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = buf.len().min(1);
            self.0.read(&mut buf[..n])
        }
    }

    #[test]
    fn frames_survive_being_read_a_byte_at_a_time() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &json!({ "a": 1 })).unwrap();
        write_frame(&mut bytes, &json!({ "b": 2 })).unwrap();
        let mut r = Trickle(Cursor::new(bytes));
        assert_eq!(read_frame(&mut r).unwrap(), Some(json!({ "a": 1 })));
        assert_eq!(read_frame(&mut r).unwrap(), Some(json!({ "b": 2 })));
        assert_eq!(read_frame(&mut r).unwrap(), None, "clean end");
    }

    #[test]
    fn an_oversized_declared_length_is_an_error() {
        let header = ((MAX_FRAME_BYTES as u32) + 1).to_be_bytes();
        let error = read_frame(&mut Cursor::new(header.to_vec())).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn a_message_over_the_limit_is_too_large_to_encode() {
        let body = |len: usize| json!("x".repeat(len - 2));
        assert_eq!(encode_frame(&body(MAX_FRAME_BYTES + 1)), Err(TooLarge));
        let frame = encode_frame(&body(MAX_FRAME_BYTES)).unwrap();
        assert_eq!(frame.len(), 4 + MAX_FRAME_BYTES, "the limit itself fits");
    }

    #[test]
    fn end_of_stream_inside_a_frame_is_an_error() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &json!({ "a": 1 })).unwrap();
        bytes.truncate(bytes.len() - 1);
        let error = read_frame(&mut Cursor::new(bytes)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
    }
}
