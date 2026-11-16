// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The name a failure is reported by. The browser reads only names, never a
//! path, and tells `NotAllowedError` apart (`folderProblem` in
//! `SvalSharedFolder.sys.mjs`), so an operating-system error is named as
//! `IOUtils` names the same failure: `RejectJSPromise` in
//! `xpcom/ioutils/IOUtils.cpp`, over `nsresultForErrno` in
//! `xpcom/io/nsLocalFile.h` on Unix and `ConvertWinError` in
//! `xpcom/io/nsLocalFileWin.cpp` on Windows.

use std::io;

/// Why an operation stopped, as the name the answer's `error` carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Failure(pub &'static str);

impl From<io::Error> for Failure {
    fn from(err: io::Error) -> Self {
        Failure(error_name(&err))
    }
}

/// The DOMException name `IOUtils` rejects with for `err`.
pub fn error_name(err: &io::Error) -> &'static str {
    match err.raw_os_error() {
        Some(code) => os_error_name(code),
        None => match err.kind() {
            io::ErrorKind::NotFound => "NotFoundError",
            io::ErrorKind::PermissionDenied => "NotAllowedError",
            io::ErrorKind::AlreadyExists => "NoModificationAllowedError",
            _ => "UnknownError",
        },
    }
}

#[cfg(unix)]
fn os_error_name(code: i32) -> &'static str {
    #[cfg(target_os = "macos")]
    if code == libc::ENOATTR {
        return "NotFoundError";
    }
    match code {
        libc::ENOENT | libc::ELOOP | libc::ENOLINK => "NotFoundError",
        libc::EPERM | libc::EACCES => "NotAllowedError",
        libc::ENOSPC | libc::EDQUOT | libc::EFBIG => "NotReadableError",
        libc::EEXIST => "NoModificationAllowedError",
        libc::ENAMETOOLONG | libc::ENOTEMPTY => "OperationError",
        libc::EROFS => "ReadOnlyError",
        libc::ENOTDIR | libc::EISDIR => "InvalidAccessError",
        _ => "UnknownError",
    }
}

#[cfg(windows)]
fn os_error_name(code: i32) -> &'static str {
    use windows_sys::Win32::Foundation::*;
    match code as u32 {
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND | ERROR_INVALID_DRIVE | ERROR_INVALID_NAME => {
            "NotFoundError"
        }
        ERROR_ACCESS_DENIED
        | ERROR_NOT_SAME_DEVICE
        | ERROR_CANNOT_MAKE
        | ERROR_CONTENT_BLOCKED
        | ERROR_SHARING_VIOLATION
        | ERROR_LOCK_VIOLATION => "NotAllowedError",
        ERROR_HANDLE_DISK_FULL
        | ERROR_DISK_FULL
        | ERROR_FILE_CORRUPT
        | ERROR_DISK_CORRUPT
        | ERROR_DEVICE_HARDWARE_ERROR
        | ERROR_DEVICE_NOT_CONNECTED
        | ERROR_DEV_NOT_EXIST
        | ERROR_INVALID_FUNCTION
        | ERROR_IO_DEVICE => "NotReadableError",
        ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS => "NoModificationAllowedError",
        ERROR_FILENAME_EXCED_RANGE | ERROR_DIR_NOT_EMPTY | ERROR_CURRENT_DIRECTORY => {
            "OperationError"
        }
        ERROR_WRITE_PROTECT => "ReadOnlyError",
        ERROR_DIRECTORY => "InvalidAccessError",
        _ => "UnknownError",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(code: i32) -> &'static str {
        error_name(&io::Error::from_raw_os_error(code))
    }

    #[cfg(unix)]
    #[test]
    fn unix_errors_take_the_names_ioutils_gives_them() {
        assert_eq!(os(libc::ENOENT), "NotFoundError");
        assert_eq!(os(libc::ELOOP), "NotFoundError");
        assert_eq!(os(libc::EACCES), "NotAllowedError");
        assert_eq!(os(libc::EPERM), "NotAllowedError");
        assert_eq!(os(libc::EEXIST), "NoModificationAllowedError");
        assert_eq!(os(libc::EROFS), "ReadOnlyError");
        assert_eq!(os(libc::ENOTDIR), "InvalidAccessError");
        assert_eq!(os(libc::EISDIR), "InvalidAccessError");
        assert_eq!(os(libc::ENOSPC), "NotReadableError");
        assert_eq!(os(libc::EDQUOT), "NotReadableError");
        assert_eq!(os(libc::ENOTEMPTY), "OperationError");
        assert_eq!(os(libc::EIO), "UnknownError");
        assert_eq!(os(libc::ETIMEDOUT), "UnknownError");
    }

    #[cfg(windows)]
    #[test]
    fn windows_errors_take_the_names_ioutils_gives_them() {
        use windows_sys::Win32::Foundation::*;
        assert_eq!(os(ERROR_FILE_NOT_FOUND as i32), "NotFoundError");
        assert_eq!(os(ERROR_PATH_NOT_FOUND as i32), "NotFoundError");
        assert_eq!(os(ERROR_ACCESS_DENIED as i32), "NotAllowedError");
        assert_eq!(os(ERROR_SHARING_VIOLATION as i32), "NotAllowedError");
        assert_eq!(os(ERROR_LOCK_VIOLATION as i32), "NotAllowedError");
        assert_eq!(
            os(ERROR_ALREADY_EXISTS as i32),
            "NoModificationAllowedError"
        );
        assert_eq!(os(ERROR_WRITE_PROTECT as i32), "ReadOnlyError");
        assert_eq!(os(ERROR_DIRECTORY as i32), "InvalidAccessError");
        assert_eq!(os(ERROR_DISK_FULL as i32), "NotReadableError");
        assert_eq!(os(ERROR_NOT_READY as i32), "UnknownError");
        assert_eq!(os(ERROR_BAD_NETPATH as i32), "UnknownError");
    }

    #[test]
    fn an_error_without_an_os_code_is_named_by_its_kind() {
        let named = |kind| error_name(&io::Error::from(kind));
        assert_eq!(named(io::ErrorKind::NotFound), "NotFoundError");
        assert_eq!(named(io::ErrorKind::PermissionDenied), "NotAllowedError");
        assert_eq!(named(io::ErrorKind::UnexpectedEof), "UnknownError");
    }
}
