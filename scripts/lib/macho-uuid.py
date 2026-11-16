# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# macho-uuid.py <executable> <name>: rewrites the LC_UUID of every slice of a
# 64-bit Mach-O executable, thin or universal, with a UUID derived from <name>
# and the slice's CPU type. The same name always gives the same UUIDs.
#
# Local Network privacy tracks a program by its main executable's UUID, and
# expects that UUID to be unique to the program (Apple's TN3179, "Build-time
# considerations"). Every artifact build on one Gecko has the same firefox
# executable, and a release built from that Gecko has it too.
#
# Rewriting the load command invalidates the executable's signature, so the
# caller signs it again.
import struct
import sys
import uuid

MH_MAGIC_64 = 0xFEEDFACF
FAT_MAGIC = 0xCAFEBABE
FAT_MAGIC_64 = 0xCAFEBABF
LC_UUID = 0x1B


def slices(data):
    """(offset, cputype) of each Mach-O image in the file."""
    (magic,) = struct.unpack_from(">I", data, 0)
    if magic in (FAT_MAGIC, FAT_MAGIC_64):
        (count,) = struct.unpack_from(">I", data, 4)
        entry, size = (">iiQQII", 32) if magic == FAT_MAGIC_64 else (">iiIII", 20)
        for i in range(count):
            fields = struct.unpack_from(entry, data, 8 + i * size)
            yield fields[2], fields[0]
    else:
        (cputype,) = struct.unpack_from("<i", data, 4)
        yield 0, cputype


def stamp(data, offset, new_uuid):
    magic, _, _, _, ncmds = struct.unpack_from("<IiiII", data, offset)
    if magic != MH_MAGIC_64:
        raise SystemExit(f"macho-uuid.py: no 64-bit Mach-O image at offset {offset}")
    cursor = offset + 32  # sizeof(struct mach_header_64)
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", data, cursor)
        if cmd == LC_UUID:
            data[cursor + 8 : cursor + 24] = new_uuid.bytes
            return
        cursor += cmdsize
    raise SystemExit(f"macho-uuid.py: the image at offset {offset} has no LC_UUID")


def main(path, name):
    with open(path, "rb") as f:
        data = bytearray(f.read())
    for offset, cputype in slices(data):
        stamp(data, offset, uuid.uuid5(uuid.NAMESPACE_DNS, f"{name}/{cputype}"))
    with open(path, "wb") as f:
        f.write(data)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: macho-uuid.py <executable> <name>")
    main(sys.argv[1], sys.argv[2])
