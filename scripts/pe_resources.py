# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Replace the icon and version strings in a Windows PE file's resources.

generate-branding.sh rebrands Mozilla's 7-Zip installer stubs with it
(other-licenses/7zstub/firefox/7zSD.*.sfx). Mozilla ships them prebuilt from
resource.rc, which compiles in Firefox's setup.ico and names Mozilla and
Firefox in the version block, and rebuilding them needs Visual Studio
(other-licenses/7zstub/README.mozilla). This reads the resource tree,
replaces the RT_ICON frames, the RT_GROUP_ICON and the RT_VERSION strings,
keeps every other resource byte for byte, and writes the tree back as the
.rsrc section. Sections after .rsrc move to make room; only .reloc may
follow it, since nothing else refers to its address.

Python standard library only. The PE format is Microsoft's "PE Format"
specification (learn.microsoft.com/windows/win32/debug/pe-format), the
version block VS_VERSIONINFO's documentation.
"""

import struct

RT_ICON, RT_GROUP_ICON, RT_VERSION = 3, 14, 16


def _align(n, a):
    return (n + a - 1) // a * a


class _PE:
    def __init__(self, data):
        self.data = bytearray(data)
        d = self.data
        assert d[:2] == b"MZ", "not a PE file"
        self.pe = struct.unpack_from("<I", d, 0x3C)[0]
        assert d[self.pe:self.pe + 4] == b"PE\0\0", "not a PE file"
        self.nsec, = struct.unpack_from("<H", d, self.pe + 6)
        optsize, = struct.unpack_from("<H", d, self.pe + 20)
        self.opt = self.pe + 24
        magic, = struct.unpack_from("<H", d, self.opt)
        self.dirs = self.opt + (96 if magic == 0x10B else 112)
        self.salign, self.falign = struct.unpack_from("<II", d, self.opt + 32)
        self.shdr = self.opt + optsize

    def section(self, i):
        name, vsize, va, rsize, rptr = struct.unpack_from("<8sIIII", self.data, self.shdr + 40 * i)
        return name.rstrip(b"\0"), vsize, va, rsize, rptr

    def set_section(self, i, vsize, va, rsize, rptr):
        struct.pack_into("<IIII", self.data, self.shdr + 40 * i + 8, vsize, va, rsize, rptr)

    def directory(self, n):
        return struct.unpack_from("<II", self.data, self.dirs + 8 * n)

    def set_directory(self, n, rva, size):
        struct.pack_into("<II", self.data, self.dirs + 8 * n, rva, size)


def _rsrc_index(pe):
    rva, _ = pe.directory(2)
    for i in range(pe.nsec):
        _, vsize, va, _, _ = pe.section(i)
        if va == rva:
            return i
    raise AssertionError("no section holds the resource directory")


def read_resources(data):
    """{type: {name: {lang: (bytes, codepage)}}}; a key is an int id or a str."""
    pe = _PE(data)
    _, _, va, _, rptr = pe.section(_rsrc_index(pe))
    d = pe.data
    base = rptr

    def key(raw):
        if raw & 0x80000000:
            o = base + (raw & 0x7FFFFFFF)
            n, = struct.unpack_from("<H", d, o)
            return bytes(d[o + 2:o + 2 + 2 * n]).decode("utf-16-le")
        return raw

    def directory(off):
        named, ids = struct.unpack_from("<HH", d, base + off + 12)
        out = {}
        for e in range(named + ids):
            name, target = struct.unpack_from("<II", d, base + off + 16 + 8 * e)
            if target & 0x80000000:
                out[key(name)] = directory(target & 0x7FFFFFFF)
            else:
                drva, size, cp, _ = struct.unpack_from("<IIII", d, base + target)
                start = rptr + drva - va
                out[key(name)] = (bytes(d[start:start + size]), cp)
        return out

    return directory(0)


def _build_rsrc(tree, va):
    """The .rsrc section's bytes for tree, placed at virtual address va."""
    def ordered(level):
        named = sorted((k for k in level if isinstance(k, str)), key=str.upper)
        ids = sorted(k for k in level if isinstance(k, int))
        return named, ids

    # Layout: every directory table, then every data entry, then the name
    # strings, then the data, each datum on an 8-byte boundary.
    tables, leaves, names = [], [], []
    queue = [tree]
    while queue:
        level = queue.pop(0)
        tables.append(level)
        named, ids = ordered(level)
        for k in named + ids:
            if isinstance(k, str) and k not in names:
                names.append(k)
            child = level[k]
            if isinstance(child, dict):
                queue.append(child)
            else:
                leaves.append(child)
    table_off, off = {}, 0
    for t in tables:
        table_off[id(t)] = off
        off += 16 + 8 * len(t)
    leaf_off = {}
    for leaf in leaves:
        leaf_off[id(leaf)] = off
        off += 16
    name_off = {}
    for n in names:
        name_off[n] = off
        off += 2 + 2 * len(n)
    data_off = {}
    for leaf in leaves:
        off = _align(off, 8)
        data_off[id(leaf)] = off
        off += len(leaf[0])
    out = bytearray(off)
    for t in tables:
        o = table_off[id(t)]
        named, ids = ordered(t)
        struct.pack_into("<IIHHHH", out, o, 0, 0, 0, 0, len(named), len(ids))
        for e, k in enumerate(named + ids):
            name = (0x80000000 | name_off[k]) if isinstance(k, str) else k
            child = t[k]
            target = (0x80000000 | table_off[id(child)]) if isinstance(child, dict) else leaf_off[id(child)]
            struct.pack_into("<II", out, o + 16 + 8 * e, name, target)
    for leaf in leaves:
        blob, cp = leaf
        struct.pack_into("<IIII", out, leaf_off[id(leaf)], va + data_off[id(leaf)], len(blob), cp, 0)
        out[data_off[id(leaf)]:data_off[id(leaf)] + len(blob)] = blob
    for n in names:
        struct.pack_into("<H", out, name_off[n], len(n))
        out[name_off[n] + 2:name_off[n] + 2 + 2 * len(n)] = n.encode("utf-16-le")
    return bytes(out)


def _checksum(d, at):
    """The optional header's CheckSum, computed as imagehlp's CheckSumMappedFile does."""
    total = 0
    padded = bytes(d) + b"\0" * (len(d) % 2)
    for i in range(0, len(padded), 2):
        if i == at or i == at + 2:
            continue
        total += padded[i] | padded[i + 1] << 8
        total = (total & 0xFFFF) + (total >> 16)
    total = (total & 0xFFFF) + (total >> 16)
    return (total & 0xFFFF) + len(d)


def write_resources(data, tree):
    """data with its .rsrc section rebuilt from tree."""
    pe = _PE(data)
    i = _rsrc_index(pe)
    _, _, va, old_rsize, rptr = pe.section(i)
    rsrc = _build_rsrc(tree, va)
    rsize = _align(len(rsrc), pe.falign)
    later = [pe.section(j) for j in range(i + 1, pe.nsec)]
    assert all(s[0] == b".reloc" for s in later), "only .reloc may follow .rsrc"
    last_end = max(pe.section(j)[4] + pe.section(j)[3] for j in range(pe.nsec))
    assert last_end == len(pe.data), "the file has data past its last section"
    tail = [bytes(pe.data[s[4]:s[4] + s[3]]) for s in later]
    out = pe.data[:rptr] + rsrc + b"\0" * (rsize - len(rsrc))
    pe.data = out
    pe.set_section(i, len(rsrc), va, rsize, rptr)
    pe.set_directory(2, va, len(rsrc))
    next_va, next_ptr = _align(va + len(rsrc), pe.salign), rptr + rsize
    for j, (s, blob) in enumerate(zip(later, tail), start=i + 1):
        _, vsize, old_va, sraw, _ = s
        for n in range(16):
            drva, dsize = pe.directory(n)
            if old_va <= drva < old_va + vsize:
                pe.set_directory(n, drva - old_va + next_va, dsize)
        pe.set_section(j, vsize, next_va, sraw, next_ptr)
        pe.data += blob
        next_va, next_ptr = _align(next_va + vsize, pe.salign), next_ptr + sraw
    struct.pack_into("<I", pe.data, pe.opt + 56, next_va)  # SizeOfImage
    struct.pack_into("<I", pe.data, pe.opt + 64, 0)
    struct.pack_into("<I", pe.data, pe.opt + 64, _checksum(pe.data, pe.opt + 64))
    return bytes(pe.data)


def set_icon(tree, ico):
    """Replace the tree's one icon group, and every RT_ICON, with ico's frames."""
    groups = tree[RT_GROUP_ICON]
    assert len(groups) == 1, "expected one icon group"
    (gname, langs), = groups.items()
    (lang, (_, cp)), = langs.items()
    _, kind, count = struct.unpack_from("<HHH", ico, 0)
    assert kind == 1, "not an icon"
    group = struct.pack("<HHH", 0, 1, count)
    icons = {}
    for n in range(count):
        w, h, colors, res, planes, bits, size, off = struct.unpack_from("<BBBBHHII", ico, 6 + 16 * n)
        group += struct.pack("<BBBBHHIH", w, h, colors, res, planes, bits, size, n + 1)
        icons[n + 1] = {lang: (ico[off:off + size], cp)}
    tree[RT_ICON] = icons
    tree[RT_GROUP_ICON] = {gname: {lang: (group, cp)}}


def _node(key, value=b"", children=b"", text=False):
    """One VS_VERSIONINFO node: wLength, wValueLength, wType, szKey, padding,
    Value, padding, Children. A text value's length counts UTF-16 units."""
    head_len = 6 + 2 * (len(key) + 1)
    head = struct.pack("<HHH", 0, (len(value) // 2) if text else len(value), 1 if text else 0)
    body = head + (key + "\0").encode("utf-16-le")
    body += b"\0" * (_align(head_len, 4) - head_len)
    body += value
    if children:
        body += b"\0" * (_align(len(body), 4) - len(body)) + children
    return struct.pack("<H", len(body)) + body[2:]


def _pad4(b):
    return b + b"\0" * (_align(len(b), 4) - len(b))


def set_version_strings(tree, strings, block="040904b0"):
    """Rewrite the version block's StringFileInfo as strings, in the one
    language block, keeping its VS_FIXEDFILEINFO and translation."""
    (vname, langs), = tree[RT_VERSION].items()
    (lang, (old, cp)), = langs.items()
    assert old[6:6 + 32] == "VS_VERSION_INFO\0".encode("utf-16-le"), "not a version block"
    fixed_at = _align(6 + 32, 4)
    fixed_len, = struct.unpack_from("<H", old, 2)
    fixed = old[fixed_at:fixed_at + fixed_len]
    assert struct.unpack_from("<I", fixed)[0] == 0xFEEF04BD, "no VS_FIXEDFILEINFO"
    table = b"".join(_pad4(_node(k, (v + "\0").encode("utf-16-le"), text=True))
                     for k, v in strings.items())
    sfi = _node("StringFileInfo", children=_node(block, children=table), text=True)
    translation = struct.pack("<HH", int(block[:4], 16), int(block[4:], 16))
    vfi = _node("VarFileInfo", children=_node("Translation", translation), text=True)
    root = _node("VS_VERSION_INFO", fixed, _pad4(sfi) + vfi)
    tree[RT_VERSION] = {vname: {lang: (root, cp)}}


def version_strings(tree):
    """{key: value} of the version block's first string table."""
    (_, langs), = tree[RT_VERSION].items()
    (_, (blob, _)), = langs.items()

    def nodes(b, o, end):
        while o < end:
            length, vlen, kind = struct.unpack_from("<HHH", b, o)
            k_end = o + 6
            while b[k_end:k_end + 2] != b"\0\0":
                k_end += 2
            key = b[o + 6:k_end].decode("utf-16-le")
            v_at = _align(k_end + 2, 4)
            yield key, b, v_at, vlen, kind, o + length
            o = _align(o + length, 4)

    out = {}
    _, _, v_at, vlen, _, end = next(nodes(blob, 0, len(blob)))
    for key, b, at, _, _, e in nodes(blob, _align(v_at + vlen, 4), end):
        if key != "StringFileInfo":
            continue
        _, _, t_at, _, _, t_end = next(nodes(b, at, e))
        for k, _, val_at, val_len, _, _ in nodes(b, t_at, t_end):
            # Some compilers count wValueLength in bytes, others in UTF-16
            # units; the value ends at its terminator either way.
            out[k] = b[val_at:val_at + 2 * val_len].decode("utf-16-le").split("\0")[0]
    return out
