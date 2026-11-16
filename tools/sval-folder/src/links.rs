// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Whether an entry is a link: something that can carry a read or a write out
//! of the shared folder.

use std::io;
use std::path::Path;

/// Whether `path`, a file or a directory, is a link itself, judged without
/// following it. A path that does not exist is not a link. Any other failure
/// to tell is an error, and every caller fails the request on one, so nothing
/// is read or written through a path nobody checked.
#[cfg(unix)]
pub fn is_link(path: &Path) -> io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => Ok(meta.file_type().is_symlink()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

/// On Windows a link is a reparse point whose tag may send a path elsewhere
/// (`windows_entry_is_link`), read through `FindFirstFileW`, which reports
/// a reparse point's own attributes and tag without following it. Cloud-files
/// placeholders, which OneDrive and similar sync engines fill a synced folder
/// with, and deduplicated files are not links, so they stay readable.
#[cfg(windows)]
pub fn is_link(path: &Path) -> io::Result<bool> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{FindClose, FindFirstFileW, WIN32_FIND_DATAW};

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // `FindFirstFileW` treats these as wildcards. No name Sval writes has one.
    if wide
        .iter()
        .any(|&c| c == u16::from(b'*') || c == u16::from(b'?'))
    {
        return Ok(true);
    }
    // SAFETY: `wide` is NUL-terminated and `data` is a plain struct the call
    // fills; the handle is closed before it goes out of scope.
    unsafe {
        let mut data: WIN32_FIND_DATAW = std::mem::zeroed();
        let handle = FindFirstFileW(wide.as_ptr(), &mut data);
        if handle == INVALID_HANDLE_VALUE {
            let err = io::Error::last_os_error();
            return match err.raw_os_error().map(|code| code as u32) {
                Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) => Ok(false),
                _ => Err(err),
            };
        }
        FindClose(handle);
        Ok(windows_entry_is_link(
            data.dwFileAttributes,
            data.dwReserved0,
        ))
    }
}

/// `FILE_ATTRIBUTE_REPARSE_POINT` (winnt.h).
const WINDOWS_REPARSE_POINT: u32 = 0x400;

/// IO_REPARSE_TAG_DEDUP, 0x80000013 ([MS-FSCC] 2.1.2.1 "Reparse Tags"): "Used
/// by the Data Deduplication (Dedup) filter". It marks a file whose data the
/// filter stores elsewhere on the same volume.
const DEDUP_TAG: u32 = 0x8000_0013;

/// Whether a reparse point with `tag` may send a path elsewhere: true for
/// every tag except the deduplication tag and the cloud-files family. Every
/// other tag counts, including ones that do not exist yet: a reparse point is
/// a filter driver's own business, and Sval cannot know that an unknown one
/// stays inside the folder. [MS-FSCC] 2.1.2.1 lists the tags that are links:
/// IO_REPARSE_TAG_MOUNT_POINT 0xA0000003 (a junction), IO_REPARSE_TAG_SYMLINK
/// 0xA000000C, IO_REPARSE_TAG_LX_SYMLINK 0xA000001D (WSL), IO_REPARSE_TAG_NFS
/// 0x80000014, IO_REPARSE_TAG_AF_UNIX 0x80000023 and the Windows Container
/// Isolation tags.
///
/// The cloud-files family is IO_REPARSE_TAG_CLOUD and IO_REPARSE_TAG_CLOUD_1
/// to IO_REPARSE_TAG_CLOUD_F, 0x9000001A, 0x9000101A ... 0x9000F01A ("Used by
/// the Cloud Files filter, for files managed by a sync engine such as
/// OneDrive"). They differ only in the four bits under
/// `IO_REPARSE_TAG_CLOUD_MASK` (0x0000F000 in winnt.h).
pub fn reparse_tag_redirects(tag: u32) -> bool {
    tag != DEDUP_TAG && tag & 0xffff_0fff != 0x9000_001a
}

/// Whether a Windows directory entry with these `WIN32_FIND_DATAW` fields is
/// a link: it is a reparse point, and its tag is not a known harmless one.
/// `tag` is `dwReserved0`, the reparse tag when `attributes` says the entry
/// is a reparse point.
pub fn windows_entry_is_link(attributes: u32, tag: u32) -> bool {
    attributes & WINDOWS_REPARSE_POINT != 0 && reparse_tag_redirects(tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reparse_point_is_a_link_unless_its_tag_is_known_harmless() {
        let links = [
            ("a junction (IO_REPARSE_TAG_MOUNT_POINT)", 0xa000_0003),
            ("a symbolic link (IO_REPARSE_TAG_SYMLINK)", 0xa000_000c),
            (
                "a WSL symbolic link (IO_REPARSE_TAG_LX_SYMLINK)",
                0xa000_001d,
            ),
            ("an NFS link (IO_REPARSE_TAG_NFS)", 0x8000_0014),
            ("a UNIX socket (IO_REPARSE_TAG_AF_UNIX)", 0x8000_0023),
            ("a container link (IO_REPARSE_TAG_WCI_LINK)", 0xa000_0027),
            ("a tag that does not exist yet", 0xa000_00ff),
            ("a tag of zero", 0),
            ("the tag after the cloud family", 0x9000_001b),
            ("a cloud tag with another high half", 0x9001_001a),
        ];
        for (what, tag) in links {
            assert!(reparse_tag_redirects(tag), "{what} is a link");
        }
        assert!(
            !reparse_tag_redirects(0x8000_0013),
            "a deduplicated file is not"
        );
        assert!(
            !reparse_tag_redirects(0x9000_001a),
            "IO_REPARSE_TAG_CLOUD is not"
        );
        for digit in 1..=0xfu32 {
            assert!(
                !reparse_tag_redirects(0x9000_001a + digit * 0x1000),
                "IO_REPARSE_TAG_CLOUD_{digit:X} is not"
            );
        }
    }

    #[test]
    fn an_entry_is_a_link_only_with_the_reparse_attribute() {
        const REPARSE: u32 = 0x400;
        const DIRECTORY: u32 = 0x10;
        const ARCHIVE: u32 = 0x20;
        assert!(windows_entry_is_link(REPARSE | DIRECTORY, 0xa000_0003));
        assert!(
            !windows_entry_is_link(DIRECTORY, 0xa000_0003),
            "a tag means nothing without the reparse attribute"
        );
        assert!(!windows_entry_is_link(REPARSE | DIRECTORY, 0x9000_601a));
        assert!(!windows_entry_is_link(DIRECTORY, 0));
        assert!(
            windows_entry_is_link(REPARSE | ARCHIVE, 0xa000_000c),
            "a file symlink is a link"
        );
        assert!(
            windows_entry_is_link(REPARSE | ARCHIVE, 0xa000_001d),
            "and so is a WSL one"
        );
        assert!(
            !windows_entry_is_link(REPARSE | ARCHIVE, 0x9000_001a),
            "a placeholder is not"
        );
        assert!(!windows_entry_is_link(REPARSE | ARCHIVE, 0x9000_f01a));
        assert!(
            !windows_entry_is_link(REPARSE | ARCHIVE, 0x8000_0013),
            "nor a dedup file"
        );
        assert!(!windows_entry_is_link(ARCHIVE, 0), "nor an ordinary file");
    }
}
