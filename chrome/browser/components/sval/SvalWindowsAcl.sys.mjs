/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Windows access control for Sval's private directories, through ctypes.
 *
 * Gecko gives chrome JS no way to set an ACL: `IOUtils.setPermissions` and
 * `nsLocalFile::SetPermissions` (xpcom/io/nsLocalFileWin.cpp) only set or
 * clear read-only, and `IOUtils.setWindowsAttributes` sets attributes. The
 * update directory's ACL is built natively (`GeneratePermissions` in
 * toolkit/mozapps/update/common/commonupdatedir.cpp), out of reach of JS.
 */

import { ctypes } from "resource://gre/modules/ctypes.sys.mjs";

const TOKEN_QUERY = 0x0008;
const TOKEN_USER_CLASS = 1;
const SDDL_REVISION_1 = 1;
const SE_FILE_OBJECT = 1;
const DACL_SECURITY_INFORMATION = 0x00000004;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;

/** `TOKEN_USER`, whose `SID_AND_ATTRIBUTES` begins with the SID's pointer. */
const TOKEN_USER = new ctypes.StructType("TOKEN_USER", [
  { Sid: ctypes.voidptr_t },
  { Attributes: ctypes.uint32_t },
]);

function failed(name, code = ctypes.winLastError) {
  return new Error(`${name} failed with Windows error ${code}`);
}

/**
 * The SID of the user this process runs as, as a string such as
 * `S-1-5-21-…-1001`.
 *
 * @param {ctypes.Library} advapi32
 * @param {ctypes.Library} kernel32
 * @param {Function} localFree `LocalFree`, for the string Windows allocates.
 * @returns {string}
 */
function currentUserSid(advapi32, kernel32, localFree) {
  const getCurrentProcess = kernel32.declare(
    "GetCurrentProcess",
    ctypes.winapi_abi,
    ctypes.voidptr_t
  );
  const closeHandle = kernel32.declare(
    "CloseHandle",
    ctypes.winapi_abi,
    ctypes.int,
    ctypes.voidptr_t
  );
  const openProcessToken = advapi32.declare(
    "OpenProcessToken",
    ctypes.winapi_abi,
    ctypes.int,
    ctypes.voidptr_t,
    ctypes.uint32_t,
    ctypes.voidptr_t.ptr
  );
  const getTokenInformation = advapi32.declare(
    "GetTokenInformation",
    ctypes.winapi_abi,
    ctypes.int,
    ctypes.voidptr_t,
    ctypes.int,
    ctypes.voidptr_t,
    ctypes.uint32_t,
    ctypes.uint32_t.ptr
  );
  const sidToString = advapi32.declare(
    "ConvertSidToStringSidW",
    ctypes.winapi_abi,
    ctypes.int,
    ctypes.voidptr_t,
    ctypes.char16_t.ptr.ptr
  );

  const token = ctypes.voidptr_t();
  if (!openProcessToken(getCurrentProcess(), TOKEN_QUERY, token.address())) {
    throw failed("OpenProcessToken");
  }
  try {
    // The first call fails, and says how large the SID makes TOKEN_USER.
    const size = ctypes.uint32_t();
    getTokenInformation(token, TOKEN_USER_CLASS, null, 0, size.address());
    const buffer = ctypes.uint8_t.array(size.value)();
    if (
      !getTokenInformation(
        token,
        TOKEN_USER_CLASS,
        buffer.address(),
        size.value,
        size.address()
      )
    ) {
      throw failed("GetTokenInformation");
    }
    const user = ctypes.cast(buffer.address(), TOKEN_USER.ptr).contents;
    const text = ctypes.char16_t.ptr();
    if (!sidToString(user.Sid, text.address())) {
      throw failed("ConvertSidToStringSidW");
    }
    try {
      return text.readString();
    } finally {
      localFree(text);
    }
  } finally {
    closeHandle(token);
  }
}

/**
 * Gives the directory at `path` a protected DACL that allows only the current
 * user and SYSTEM, and that every file and directory inside it inherits.
 * Nothing is inherited from the directory's parent, so a profile anywhere,
 * however open its parent, keeps other local users out. Administrators are
 * left out: one can still take ownership, as root can read a 0700 directory.
 * `SetNamedSecurityInfoW` also passes the ACEs down to what the directory
 * already holds.
 *
 * Throws with the Windows error code when any step fails.
 *
 * @param {string} path
 */
export function restrictToCurrentUser(path) {
  const advapi32 = ctypes.open("advapi32.dll");
  const kernel32 = ctypes.open("kernel32.dll");
  try {
    const localFree = kernel32.declare(
      "LocalFree",
      ctypes.winapi_abi,
      ctypes.voidptr_t,
      ctypes.voidptr_t
    );
    const toDescriptor = advapi32.declare(
      "ConvertStringSecurityDescriptorToSecurityDescriptorW",
      ctypes.winapi_abi,
      ctypes.int,
      ctypes.char16_t.ptr,
      ctypes.uint32_t,
      ctypes.voidptr_t.ptr,
      ctypes.uint32_t.ptr
    );
    const getDacl = advapi32.declare(
      "GetSecurityDescriptorDacl",
      ctypes.winapi_abi,
      ctypes.int,
      ctypes.voidptr_t,
      ctypes.int.ptr,
      ctypes.voidptr_t.ptr,
      ctypes.int.ptr
    );
    const setNamedSecurityInfo = advapi32.declare(
      "SetNamedSecurityInfoW",
      ctypes.winapi_abi,
      ctypes.uint32_t,
      ctypes.char16_t.ptr,
      ctypes.int,
      ctypes.uint32_t,
      ctypes.voidptr_t,
      ctypes.voidptr_t,
      ctypes.voidptr_t,
      ctypes.voidptr_t
    );

    const sid = currentUserSid(advapi32, kernel32, localFree);
    // P: protected. OICI: inherited by files and directories. FA: full access.
    const sddl = `D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`;
    const descriptor = ctypes.voidptr_t();
    if (!toDescriptor(sddl, SDDL_REVISION_1, descriptor.address(), null)) {
      throw failed("ConvertStringSecurityDescriptorToSecurityDescriptorW");
    }
    try {
      const present = ctypes.int();
      const dacl = ctypes.voidptr_t();
      const defaulted = ctypes.int();
      if (
        !getDacl(
          descriptor,
          present.address(),
          dacl.address(),
          defaulted.address()
        )
      ) {
        throw failed("GetSecurityDescriptorDacl");
      }
      const error = setNamedSecurityInfo(
        path,
        SE_FILE_OBJECT,
        (DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION) >>> 0,
        null,
        null,
        dacl,
        null
      );
      if (error) {
        throw failed("SetNamedSecurityInfoW", error);
      }
    } finally {
      localFree(descriptor);
    }
  } finally {
    advapi32.close();
    kernel32.close();
  }
}
