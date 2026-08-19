// Reconstruct a readable node tree from MindNode's CRDT storage:
// base snapshot + operation batches, each wrapped in the same envelope
// (field 12345 = format version varint, field 678910 = payload) where the
// payload may be Apple-LZ4 framed. See docs/FORMAT.md for the field map.
//
// This is a best-effort reader for the reverse-engineered format: node
// creation ops give us the hierarchy, text ops give us title runs. Text that
// was heavily edited (deletions, mid-string inserts) may come back slightly
// scrambled until the CRDT position encoding is fully mapped.

import type { ProtoField } from "./proto.ts";
import {
  getBytes,
  getMessage,
  readVarint,
  tryParseMessage,
  walkMessages,
} from "./proto.ts";
import { appleLz4Decode } from "./lz4.ts";
import type { MindMapDoc } from "./library.ts";
import { getBaseSnapshot, getOperationBatches } from "./library.ts";

const ENVELOPE_VERSION_FIELD = 12345;
const ENVELOPE_PAYLOAD_FIELD = 678910;

// Unwrap the {f12345: version, f678910: payload} envelope, LZ4-decoding the
// payload when it carries the Apple "bv4…" frame magic.
export function unwrapEnvelope(buf: Buffer): Buffer {
  let pos = 0;
  let payload: Buffer | null = null;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    pos = afterTag;
    if (wire === 0) {
      const [, next] = readVarint(buf, pos);
      pos = next;
      if (field !== ENVELOPE_VERSION_FIELD) continue;
    } else if (wire === 2) {
      const [len, afterLen] = readVarint(buf, pos);
      const start = afterLen;
      const end = start + Number(len);
      if (field === ENVELOPE_PAYLOAD_FIELD) payload = buf.subarray(start, end);
      pos = end;
    } else {
      throw new Error(`unexpected wire type ${wire} in envelope`);
    }
  }
  if (!payload) throw new Error("envelope has no payload field");
  if (payload.length >= 4 && payload.subarray(0, 3).toString("latin1") === "bv4") {
    return appleLz4Decode(payload);
  }
  return payload;
}

export interface MindNode {
  id: string;
  text: string;
  children: MindNode[];
}

const UUID_LEN = 16;

function hexId(b: Buffer | undefined): string | undefined {
  return b && b.length === UUID_LEN ? b.toString("hex") : undefined;
}

interface Extraction {
  // child -> parent
  parents: Map<string, string>;
  // child -> sibling sort key (snapshot relations carry one)
  order: Map<string, number>;
  // node -> ordered text runs
  texts: Map<string, string[]>;
  // node ids in first-seen order (for stable sibling ordering)
  seen: string[];
  // nodes whose text came from the op stream: their snapshot-era title is a
  // stale template value ("Mind Map") that the edit replaced — drop it
  opText: Set<string>;
  // true while extracting operation batches (vs the base snapshot)
  inOps: boolean;
}

function note(seen: string[], known: Set<string>, id: string) {
  if (!known.has(id)) {
    known.add(id);
    seen.push(id);
  }
}

// We pattern-match three record shapes that appear in both snapshots and
// operation batches (documentID passed in so doc-level links become roots):
//  * parent link: a message whose f1 and f2 are both 16-byte ids, carrying
//    either an origin message (f3, in ops) or a sort key (f4.f1.f2, in
//    snapshot relations) -> (child f1, parent f2)
//  * node body: a message {f1: 16-byte id, f2: {f11: ...}} where
//    f11's subtree holds title runs as f4.f1 strings
//  * text op: a message tagged f16 whose f1 is a 16-byte id; its subtree
//    holds the inserted text runs as f4 strings.
function extract(root: ProtoField[], out: Extraction, known: Set<string>, documentID: string) {
  const docId = documentID.replaceAll("-", "").toLowerCase();
  for (const msg of walkMessages(root)) {
    for (const f of msg) {
      if (f.field === 16 && f.value.kind === "message") {
        const nodeId = hexId(getBytes(f.value.value, 1));
        if (nodeId) {
          note(out.seen, known, nodeId);
          let runs = out.texts.get(nodeId) ?? [];
          if (out.inOps && !out.opText.has(nodeId) && runs.length) {
            runs = []; // first op-run for this node supersedes its snapshot title
          }
          collectTextRuns(f.value.value, runs);
          if (runs.length) {
            out.texts.set(nodeId, runs);
            if (out.inOps) out.opText.add(nodeId);
          }
        }
      }
    }
    const id = hexId(getBytes(msg, 1));
    if (!id) continue;

    // node body with title (snapshot shape)
    const body = getMessage(msg, 2);
    const f11 = body && getMessage(body, 11);
    if (f11) {
      note(out.seen, known, id);
      const runs = out.texts.get(id) ?? [];
      collectTitleRuns(f11, runs);
      if (runs.length) out.texts.set(id, runs);
      continue;
    }

    // parent link
    const parent = hexId(getBytes(msg, 2));
    const origin = getMessage(msg, 3);
    const sortKey = getMessage(msg, 4);
    if (parent && (origin || sortKey)) {
      if (parent === docId) {
        // doc-level link: the child is a root node — record it as seen with
        // no parent so buildTree treats it as a root
        note(out.seen, known, id);
      } else if (!out.parents.has(id)) {
        out.parents.set(id, parent);
        note(out.seen, known, parent);
        note(out.seen, known, id);
      }
      const skInner = sortKey && getMessage(sortKey, 1);
      const sk = skInner?.find((f) => f.field === 2 && f.value.kind === "varint");
      if (sk && sk.value.kind === "varint") out.order.set(id, Number(sk.value.value));
    }
  }
}

// Title runs inside a node body: f11 -> repeated f1 -> f4 -> f1 strings.
function collectTitleRuns(f11: ProtoField[], runs: string[]) {
  for (const f of f11) {
    if (f.field !== 1 || f.value.kind !== "message") continue;
    const f4 = getMessage(f.value.value, 4);
    if (!f4) continue;
    for (const g of f4) {
      if (g.field === 1 && g.value.kind === "string") runs.push(g.value.value);
    }
  }
}

function collectTextRuns(msg: ProtoField[], runs: string[]) {
  for (const f of msg) {
    if (f.value.kind === "message") {
      collectTextRuns(f.value.value, runs);
    } else if (f.field === 4 && f.value.kind === "string") {
      runs.push(f.value.value);
    }
  }
}

export function buildTree(doc: MindMapDoc, libraryPath: string): MindNode[] {
  const out: Extraction = {
    parents: new Map(),
    order: new Map(),
    texts: new Map(),
    seen: [],
    opText: new Set(),
    inOps: false,
  };
  const known = new Set<string>();

  const snapshot = getBaseSnapshot(libraryPath, doc.documentID);
  if (snapshot) {
    const parsed = tryParseMessage(unwrapEnvelope(snapshot));
    if (parsed) extract(parsed, out, known, doc.documentID);
  }

  out.inOps = true;
  for (const batch of getOperationBatches(libraryPath, doc.documentID)) {
    const parsed = tryParseMessage(unwrapEnvelope(batch.data));
    if (parsed) extract(parsed, out, known, doc.documentID);
  }

  const nodes = new Map<string, MindNode>();
  const nodeFor = (id: string): MindNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, text: (out.texts.get(id) ?? []).join(""), children: [] };
      nodes.set(id, n);
    }
    return n;
  };

  const roots: MindNode[] = [];
  for (const id of out.seen) {
    const node = nodeFor(id);
    const parentId = out.parents.get(id);
    if (parentId && out.seen.includes(parentId)) {
      nodeFor(parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Stable-sort siblings by snapshot sort key where known (unknown keys keep
  // first-seen order, which matches creation order in the op stream).
  const sortChildren = (n: MindNode) => {
    // nodes without a key (op-created) sort after keyed ones, keeping
    // first-seen order among themselves (Array.prototype.sort is stable)
    const key = (n: MindNode) => out.order.get(n.id) ?? Number.MAX_SAFE_INTEGER;
    n.children.sort((a, b) => key(a) - key(b));
    for (const c of n.children) sortChildren(c);
  };
  for (const r of roots) sortChildren(r);

  // Drop structural roots whose entire subtree is textless (e.g. the
  // template node from the base snapshot when the real root replaced it).
  const hasAnyText = (n: MindNode): boolean =>
    n.text.trim().length > 0 || n.children.some(hasAnyText);
  return roots.filter(hasAnyText);
}

export function treeToMarkdown(roots: MindNode[]): string {
  const lines: string[] = [];
  const emit = (node: MindNode, depth: number) => {
    // node text may contain line breaks; keep the outline one line per node
    const label = node.text.trim().replace(/\s*\n\s*/g, " / ") || "(untitled)";
    if (depth === 0) {
      lines.push(`# ${label}`);
    } else {
      lines.push(`${"  ".repeat(depth - 1)}- ${label}`);
    }
    for (const child of node.children) emit(child, depth + 1);
  };
  for (const root of roots) {
    emit(root, 0);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
