#!/usr/bin/env python3
"""Pretty-print a MindNode storage blob (base snapshot or operationBatch)
as a raw protobuf tree. Handles the f12345/f678910 envelope and Apple LZ4
framing via /usr/bin/compression_tool.

Usage:
  tools/spelunk.py <blob-file>
  sqlite3 Content.sqlite3 "select writefile('/tmp/b', serializedData) from operationBatch limit 1" && tools/spelunk.py /tmp/b
"""

import subprocess
import sys
import tempfile


def read_varint(b, i):
    result = 0
    shift = 0
    while True:
        byte = b[i]
        i += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, i
        shift += 7


def parse(b, depth=0, maxdepth=40):
    i = 0
    out = []
    while i < len(b):
        try:
            tag, i = read_varint(b, i)
        except Exception:
            return None
        field, wire = tag >> 3, tag & 7
        if field == 0:
            return None
        if wire == 0:
            try:
                v, i = read_varint(b, i)
            except Exception:
                return None
            out.append((field, "varint", v))
        elif wire == 1:
            if i + 8 > len(b):
                return None
            out.append((field, "64bit", b[i : i + 8].hex()))
            i += 8
        elif wire == 5:
            if i + 4 > len(b):
                return None
            out.append((field, "32bit", b[i : i + 4].hex()))
            i += 4
        elif wire == 2:
            try:
                ln, i = read_varint(b, i)
            except Exception:
                return None
            if i + ln > len(b):
                return None
            chunk = b[i : i + ln]
            i += ln
            sub = parse(chunk, depth + 1, maxdepth) if depth < maxdepth and len(chunk) > 1 else None
            if sub:
                out.append((field, "msg", sub))
            else:
                try:
                    s = chunk.decode("utf-8")
                    if s and all(c.isprintable() or c in "\n\t" for c in s):
                        out.append((field, "str", s))
                        continue
                except Exception:
                    pass
                out.append((field, "bytes", chunk.hex()))
        else:
            return None
    return out


def show(tree, indent=0):
    for field, kind, val in tree:
        pad = "  " * indent
        if kind == "msg":
            print(f"{pad}f{field}:")
            show(val, indent + 1)
        else:
            if kind == "bytes" and len(val) > 64:
                val = val[:64] + f"... ({len(val)//2} bytes)"
            print(f"{pad}f{field} {kind}: {val}")


def unwrap_envelope(b):
    """Return the f678910 payload, LZ4-decoding when Apple-framed."""
    i = 0
    payload = None
    while i < len(b):
        tag, i = read_varint(b, i)
        field, wire = tag >> 3, tag & 7
        if wire == 0:
            _, i = read_varint(b, i)
        elif wire == 2:
            ln, i = read_varint(b, i)
            chunk = b[i : i + ln]
            i += ln
            if field == 678910:
                payload = chunk
        else:
            raise ValueError(f"unexpected wire type {wire} in envelope")
    if payload is None:
        return b  # not an envelope; treat as raw payload
    if payload[:3] == b"bv4":
        with tempfile.NamedTemporaryFile(suffix=".lz4") as src, tempfile.NamedTemporaryFile() as dst:
            src.write(payload)
            src.flush()
            subprocess.run(
                ["/usr/bin/compression_tool", "-decode", "-a", "lz4", "-i", src.name, "-o", dst.name],
                check=True,
            )
            return open(dst.name, "rb").read()
    return payload


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    blob = open(sys.argv[1], "rb").read()
    payload = unwrap_envelope(blob)
    print(f"# payload: {len(payload)} bytes (blob: {len(blob)})", file=sys.stderr)
    tree = parse(payload)
    if tree is None:
        print("failed to parse as protobuf", file=sys.stderr)
        sys.exit(2)
    show(tree)


if __name__ == "__main__":
    main()
