/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Reads another browser's LevelDB database, read-only, for the import readers
 * (import spec §4.1). Edge keeps the names of its Workspaces only in its sync
 * database, a LevelDB under `Sync Data/LevelDB`.
 *
 * A database is its write-ahead logs (`*.log`) and its sorted tables
 * (`*.ldb`, or `*.sst` from older versions). Every record carries a sequence
 * number, and the newest record of a key is the key's value, so reading
 * every file and keeping the highest sequence gives the database as it
 * stands, whichever files compaction has written. A running browser leaves
 * its files readable. Formats are LevelDB's own: `doc/log_format.md`,
 * `doc/table_format.md`, `db/write_batch.cc` and `db/dbformat.h`, with
 * blocks compressed as Snappy's `format_description.txt` describes.
 */

/** A log is written in blocks of this size (`log::kBlockSize`). */
const LOG_BLOCK = 32768;

/** A log record's header: checksum, length and type (`log::kHeaderSize`). */
const LOG_HEADER = 7;

/** Log record types (`log::RecordType`). */
const FULL = 1;
const FIRST = 2;
const MIDDLE = 3;
const LAST = 4;

/** A table's footer: two block handles, padding and the magic number. */
const FOOTER = 48;

/** `kTableMagicNumber`, little-endian, as the footer's last eight bytes. */
const TABLE_MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];

/** A block's trailer: compression type and checksum. */
const BLOCK_TRAILER = 5;

/** Block compression types (`CompressionType`). */
const NO_COMPRESSION = 0;
const SNAPPY = 1;

/** Value types of a record (`ValueType`). */
const DELETION = 0;
const VALUE = 1;

const LATIN1 = new TextDecoder("latin1");

/**
 * Every live key of the database in `dir` that starts with `prefix`, with its
 * value. A file that cannot be read or parsed costs only its own records.
 *
 * @param {string} dir The database's directory.
 * @param {string} prefix Keys are compared as Latin-1 strings.
 * @returns {Promise<Map<string, Uint8Array>>} An empty map when `dir` holds no
 *   database.
 */
export async function readLevelDB(dir, prefix) {
  let children = [];
  try {
    children = await IOUtils.getChildren(dir);
  } catch {
    return new Map();
  }
  const newest = new Map();
  const take = (key, seq, type, value) => {
    const name = LATIN1.decode(key);
    if (!name.startsWith(prefix)) {
      return;
    }
    const known = newest.get(name);
    if (!known || seq > known.seq) {
      newest.set(name, { seq, type, value });
    }
  };
  for (const path of children) {
    const name = PathUtils.filename(path);
    let read;
    if (name.endsWith(".log")) {
      read = readLog;
    } else if (name.endsWith(".ldb") || name.endsWith(".sst")) {
      read = readTable;
    } else {
      continue;
    }
    try {
      read(await IOUtils.read(path), take);
    } catch {
      // Unreadable or damaged: the other files still answer.
    }
  }
  const out = new Map();
  for (const [key, { type, value }] of newest) {
    if (type === VALUE) {
      out.set(key, value);
    }
  }
  return out;
}

/**
 * Bytes read in order: varints, fixed-width integers and slices.
 */
class Cursor {
  constructor(bytes, at = 0, end = bytes.length) {
    this.bytes = bytes;
    this.at = at;
    this.end = end;
  }
  get done() {
    return this.at >= this.end;
  }
  byte() {
    if (this.at >= this.end) {
      throw new Error("LevelDB: past the end");
    }
    return this.bytes[this.at++];
  }
  /** A varint of up to 64 bits, as a Number; offsets and sizes fit. */
  varint() {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.byte();
      value += (b & 0x7f) * scale;
      if (!(b & 0x80)) {
        return value;
      }
      scale *= 128;
    }
    throw new Error("LevelDB: varint too long");
  }
  slice(length) {
    if (length < 0 || this.at + length > this.end) {
      throw new Error("LevelDB: past the end");
    }
    const out = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }
}

/**
 * A little-endian 64-bit integer as a BigInt.
 *
 * @param {Uint8Array} bytes
 * @param {number} at
 * @returns {bigint}
 */
function fixed64(bytes, at) {
  return new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigUint64(
    0,
    true
  );
}

/**
 * A write-ahead log's records: each a WriteBatch, whose puts and deletions
 * take sequence numbers from the batch's own, in order. A record cut short
 * by a crash ends the log.
 *
 * @param {Uint8Array} bytes
 * @param {Function} take `(key, seq, type, value)`.
 */
function readLog(bytes, take) {
  let pending = null;
  let at = 0;
  while (at + LOG_HEADER <= bytes.length) {
    const left = LOG_BLOCK - (at % LOG_BLOCK);
    if (left < LOG_HEADER) {
      at += left;
      continue;
    }
    const length = bytes[at + 4] | (bytes[at + 5] << 8);
    const type = bytes[at + 6];
    const start = at + LOG_HEADER;
    if (start + length > bytes.length) {
      return;
    }
    const fragment = bytes.subarray(start, start + length);
    at = start + length;
    if (type === FULL) {
      readBatch(fragment, take);
      pending = null;
    } else if (type === FIRST) {
      pending = [fragment];
    } else if (type === MIDDLE && pending) {
      pending.push(fragment);
    } else if (type === LAST && pending) {
      pending.push(fragment);
      readBatch(concat(pending), take);
      pending = null;
    }
  }
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * One WriteBatch: a 64-bit sequence, a 32-bit count, then each record as a
 * type byte, a length-prefixed key and, for a put, a length-prefixed value.
 *
 * @param {Uint8Array} bytes
 * @param {Function} take `(key, seq, type, value)`.
 */
function readBatch(bytes, take) {
  if (bytes.length < 12) {
    return;
  }
  let seq = fixed64(bytes, 0);
  const c = new Cursor(bytes, 12);
  while (!c.done) {
    const type = c.byte();
    const key = c.slice(c.varint());
    if (type === VALUE) {
      take(key, seq, VALUE, c.slice(c.varint()));
    } else if (type === DELETION) {
      take(key, seq, DELETION, null);
    } else {
      return;
    }
    seq++;
  }
}

/**
 * A sorted table's records, through its index block, whose values are the
 * handles of its data blocks. Each internal key is the user key followed by
 * eight bytes: the sequence shifted left by eight, or'd with the type.
 *
 * @param {Uint8Array} bytes
 * @param {Function} take `(key, seq, type, value)`.
 */
function readTable(bytes, take) {
  if (bytes.length < FOOTER) {
    return;
  }
  const footer = bytes.subarray(bytes.length - FOOTER);
  if (!TABLE_MAGIC.every((b, i) => footer[FOOTER - 8 + i] === b)) {
    return;
  }
  const handles = new Cursor(footer);
  handles.varint();
  handles.varint();
  const index = block(bytes, handles.varint(), handles.varint());
  for (const [, handle] of entries(index)) {
    const h = new Cursor(handle);
    const data = block(bytes, h.varint(), h.varint());
    for (const [internal, value] of entries(data)) {
      if (internal.length < 8) {
        continue;
      }
      const tag = fixed64(internal, internal.length - 8);
      take(
        internal.subarray(0, internal.length - 8),
        tag >> 8n,
        Number(tag & 0xffn),
        value
      );
    }
  }
}

/**
 * A block's contents, uncompressed, from its handle.
 *
 * @param {Uint8Array} bytes The table.
 * @param {number} offset
 * @param {number} size
 * @returns {Uint8Array}
 */
function block(bytes, offset, size) {
  if (offset + size + BLOCK_TRAILER > bytes.length) {
    throw new Error("LevelDB: block past the end");
  }
  const contents = bytes.subarray(offset, offset + size);
  const type = bytes[offset + size];
  if (type === NO_COMPRESSION) {
    return contents;
  }
  if (type === SNAPPY) {
    return unsnappy(contents);
  }
  throw new Error("LevelDB: unknown compression");
}

/**
 * A block's entries, in order, as `[key, value]`. Each key shares a prefix
 * with the one before it; the restart array at the block's end is not needed
 * to read every entry in turn.
 *
 * @param {Uint8Array} bytes The block's contents.
 * @yields {Uint8Array[]} `[key, value]`.
 */
function* entries(bytes) {
  if (bytes.length < 4) {
    return;
  }
  const restarts = new DataView(
    bytes.buffer,
    bytes.byteOffset + bytes.length - 4,
    4
  ).getUint32(0, true);
  const end = bytes.length - 4 - restarts * 4;
  const c = new Cursor(bytes, 0, end);
  let key = new Uint8Array(0);
  while (!c.done) {
    const shared = c.varint();
    const own = c.varint();
    const length = c.varint();
    if (shared > key.length) {
      throw new Error("LevelDB: shares more than the key before");
    }
    const next = new Uint8Array(shared + own);
    next.set(key.subarray(0, shared));
    next.set(c.slice(own), shared);
    key = next;
    yield [key, c.slice(length)];
  }
}

/**
 * Snappy's raw format: the uncompressed length as a varint, then literals and
 * back-references, each led by a tag whose low two bits give its kind.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function unsnappy(bytes) {
  const c = new Cursor(bytes);
  const size = c.varint();
  // The densest element is a three-byte copy of 64 bytes, so a size past
  // that ratio is one the input can't fill, and is refused before it is
  // allocated.
  if (size * 3 > bytes.length * 64) {
    throw new Error("Snappy: larger than its input can hold");
  }
  const out = new Uint8Array(size);
  let at = 0;
  const copy = (offset, length) => {
    if (offset < 1 || offset > at || at + length > out.length) {
      throw new Error("Snappy: bad copy");
    }
    for (let i = 0; i < length; i++, at++) {
      out[at] = out[at - offset];
    }
  };
  while (!c.done) {
    const tag = c.byte();
    switch (tag & 3) {
      case 0: {
        let length = tag >> 2;
        if (length >= 60) {
          const extra = length - 59;
          length = 0;
          for (let i = 0; i < extra; i++) {
            length += c.byte() * 2 ** (8 * i);
          }
        }
        length += 1;
        if (at + length > out.length) {
          throw new Error("Snappy: literal past the end");
        }
        out.set(c.slice(length), at);
        at += length;
        break;
      }
      case 1:
        copy(((tag >> 5) << 8) | c.byte(), 4 + ((tag >> 2) & 7));
        break;
      case 2:
        copy(c.byte() | (c.byte() << 8), (tag >> 2) + 1);
        break;
      default:
        copy(
          (c.byte() | (c.byte() << 8) | (c.byte() << 16) | (c.byte() << 24)) >>>
            0,
          (tag >> 2) + 1
        );
    }
  }
  if (at !== out.length) {
    throw new Error("Snappy: short output");
  }
  return out;
}
