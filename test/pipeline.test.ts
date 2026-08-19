import { test } from "node:test";
import assert from "node:assert/strict";
import { appleLz4Decode, lz4BlockDecode } from "../src/lz4.ts";
import { tryParseMessage } from "../src/proto.ts";
import { unwrapEnvelope } from "../src/mindmap.ts";

test("apple LZ4 stored frame", () => {
  const raw = Buffer.from("hello mindnode");
  const frame = Buffer.concat([
    Buffer.from("bv4-"),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(raw.length);
      return b;
    })(),
    raw,
    Buffer.from("bv4$"),
  ]);
  assert.deepEqual(appleLz4Decode(frame), raw);
});

test("LZ4 block with overlapping match", () => {
  // literals "ab", then match offset 2 len 6 -> "abababab"
  const block = Buffer.from([0x22, 0x61, 0x62, 0x02, 0x00]);
  assert.equal(lz4BlockDecode(block, 8).toString(), "abababab");
});

test("protobuf raw parse", () => {
  // field 1 varint 150; field 2 string "hi!" (bytes that can't form a
  // valid nested message, so the parser must fall back to string)
  const buf = Buffer.from([0x08, 0x96, 0x01, 0x12, 0x03, 0x68, 0x69, 0x21]);
  const msg = tryParseMessage(buf);
  assert.ok(msg);
  assert.equal(msg.length, 2);
  assert.deepEqual(msg[0], { field: 1, value: { kind: "varint", value: 150n } });
  assert.deepEqual(msg[1], { field: 2, value: { kind: "string", value: "hi!" } });
});

test("envelope unwrap (uncompressed payload)", () => {
  const payload = Buffer.from([0x08, 0x01]);
  // f12345 varint 10 = tag 98760 -> [0xc8, 0x83, 0x06], value 0x0a
  // f678910 bytes = tag 5431282 -> [0xf2, 0xbf, 0xcb, 0x02], len, payload
  const envelope = Buffer.concat([
    Buffer.from([0xc8, 0x83, 0x06, 0x0a]),
    Buffer.from([0xf2, 0xbf, 0xcb, 0x02, payload.length]),
    payload,
  ]);
  assert.deepEqual(unwrapEnvelope(envelope), payload);
});
