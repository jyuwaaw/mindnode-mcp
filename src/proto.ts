// Minimal schema-less protobuf wire-format parser.
// MindNode's library format is protobuf-based but no .proto schema is
// published, so we parse raw wire data into a generic tree and let callers
// pattern-match field numbers (see docs/FORMAT.md for the mapping).

export type ProtoValue =
  | { kind: "varint"; value: bigint }
  | { kind: "fixed64"; value: Buffer }
  | { kind: "fixed32"; value: Buffer }
  | { kind: "bytes"; value: Buffer }
  | { kind: "string"; value: string }
  | { kind: "message"; value: ProtoField[] };

export interface ProtoField {
  field: number;
  value: ProtoValue;
}

export function readVarint(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new RangeError("varint past end of buffer");
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
    if (shift > 63n) throw new RangeError("varint too long");
  }
}

function isCleanText(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 && ch !== "\n" && ch !== "\t") return false;
    if (code === 0x7f || code === 0xfffd) return false;
  }
  return true;
}

// Parse a buffer as a protobuf message. Returns null when the bytes don't
// form a valid message (used to decide whether a length-delimited field is a
// nested message or a plain string/bytes payload).
export function tryParseMessage(buf: Buffer, depth = 0): ProtoField[] | null {
  if (depth > 40) return null;
  const fields: ProtoField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag: bigint;
    try {
      [tag, pos] = readVarint(buf, pos);
    } catch {
      return null;
    }
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 0) return null;
    switch (wire) {
      case 0: {
        let v: bigint;
        try {
          [v, pos] = readVarint(buf, pos);
        } catch {
          return null;
        }
        fields.push({ field, value: { kind: "varint", value: v } });
        break;
      }
      case 1: {
        if (pos + 8 > buf.length) return null;
        fields.push({ field, value: { kind: "fixed64", value: buf.subarray(pos, pos + 8) } });
        pos += 8;
        break;
      }
      case 5: {
        if (pos + 4 > buf.length) return null;
        fields.push({ field, value: { kind: "fixed32", value: buf.subarray(pos, pos + 4) } });
        pos += 4;
        break;
      }
      case 2: {
        let len: bigint;
        try {
          [len, pos] = readVarint(buf, pos);
        } catch {
          return null;
        }
        const n = Number(len);
        if (pos + n > buf.length) return null;
        const chunk = buf.subarray(pos, pos + n);
        pos += n;
        const sub = n > 1 ? tryParseMessage(chunk, depth + 1) : null;
        if (sub) {
          fields.push({ field, value: { kind: "message", value: sub } });
        } else {
          const s = chunk.toString("utf8");
          if (!s.includes("�") && isCleanText(s)) {
            fields.push({ field, value: { kind: "string", value: s } });
          } else {
            fields.push({ field, value: { kind: "bytes", value: chunk } });
          }
        }
        break;
      }
      default:
        return null;
    }
  }
  return fields;
}

// --- helpers for pattern-matching parsed trees ---

export function getFields(msg: ProtoField[], field: number): ProtoValue[] {
  return msg.filter((f) => f.field === field).map((f) => f.value);
}

export function getMessage(msg: ProtoField[], field: number): ProtoField[] | undefined {
  const v = msg.find((f) => f.field === field && f.value.kind === "message");
  return v && v.value.kind === "message" ? v.value.value : undefined;
}

export function getBytes(msg: ProtoField[], field: number): Buffer | undefined {
  const v = msg.find((f) => f.field === field);
  if (!v) return undefined;
  if (v.value.kind === "bytes") return v.value.value;
  if (v.value.kind === "string") return Buffer.from(v.value.value, "utf8");
  return undefined;
}

export function getString(msg: ProtoField[], field: number): string | undefined {
  const v = msg.find((f) => f.field === field && f.value.kind === "string");
  return v && v.value.kind === "string" ? v.value.value : undefined;
}

// Depth-first walk over every nested message.
export function* walkMessages(msg: ProtoField[]): Generator<ProtoField[]> {
  yield msg;
  for (const f of msg) {
    if (f.value.kind === "message") yield* walkMessages(f.value.value);
  }
}
