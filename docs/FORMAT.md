# MindNode Next storage format (reverse-engineered)

Verified against MindNode 2026.4.4 (`com.ideasoncanvas.mindnode`) on macOS.
No AppleScript dictionary exists; this file documents the local library format
the read pipeline relies on, plus the app's other automation surfaces.

## Library location

```
~/Library/Containers/com.ideasoncanvas.mindnode/Data/Library/Application Support/
  MindNode/<environment>/MindNode Library.mindnodelibrary/
    Content.sqlite3        # GRDB database (WAL mode)
    Assets/                # base snapshots + preview JPEGs
    Caches/
```

`<environment>` is `production-v1_0` today; scan for any directory containing
a `.mindnodelibrary` with `Content.sqlite3`.

## SQLite tables that matter

- `document` — one row per mind map: `documentID` (UUID), `title`,
  `folderID`, `trashDate` (NULL = not trashed), `localModificationDate`,
  `baseSnapshotID`. `serializedData` is NULL in practice; content lives
  elsewhere. CloudKit sync bookkeeping fills the remaining columns.
- `operationBatch` — the CRDT edit stream: `documentID`,
  `creationHLCTimestampString` (orderable), `serializedData` (envelope, see
  below), `operationCount`, `peerID`.
- `snapshot` — snapshot metadata rows; the snapshot payload itself is the
  file `Assets/<snapshotID>` (today snapshotID == documentID).
- `operation` — empty in practice (ops arrive pre-batched).

Document state = base snapshot ⊕ operation batches in HLC order.

Open the DB **read-only, always** — MindNode owns it and syncs it to
CloudKit; a stray write could corrupt sync state.

## Envelope

Every stored blob (base snapshot file, operationBatch.serializedData) is a
tiny protobuf envelope:

| field  | type   | meaning                                   |
| ------ | ------ | ----------------------------------------- |
| 12345  | varint | format version (10 as of 2026.4.4)        |
| 678910 | bytes  | payload                                   |

(Field numbers 12345/678910 look like developer humor; they're stable.)

If the payload starts with `bv4` it is an Apple Compression-framework LZ4
frame: blocks of `"bv41" u32le_decodedSize u32le_encodedSize <lz4 block>` or
`"bv4-" u32le_size <raw>` terminated by `"bv4$"`. Small payloads (the 324-byte
template snapshot) skip compression entirely.

## Snapshot payload (protobuf, no published schema)

Top level:

- `f1` — document container
  - `f1` — doc-level record
  - repeated `f2` — **node records**: `{f1: nodeID(16B), f2: body}` where
    body has `f7` = ordinal, `f9` = style (RGBA doubles), `f11` = title
    (`f11.f1.f4.f1` = text run string, repeated), `f12`/`f13` = misc
  - `f3` — **relations**: repeated `f2` records
    `{f1: childID, f2: parentID, f4: {f1: {f1: peerID, f2: sortKey}}}`.
    The root node's parent is the documentID itself. Sort keys are spaced
    (200, 400, 600 …) for fractional insertion.
  - `f5`/`f6` — theme; `f6.f2` nests another LZ4 frame containing JSON
- `f2` — checksum/opaque
- `f3` — HLC clock state

A fresh document's snapshot is a 324-byte template with a single node titled
"Mind Map" (node UUID identical across documents). **Markdown/OPML imports
produce a full snapshot with all nodes and relations and zero op batches.**

## Operation batch payload

Top level: `f1` header (documentID), repeated `f2` op records:

- op record: `{f1: opID(16B), f2: <envelope again>}`; the inner payload has
  `f1` opID, `f2` meta (`f1` = HLC timestamp fixed64, `f3` = peerID), `f3` =
  the op body, keyed by op type:
  - `f3.f1…` structural group — contains **creation** records
    `{f1: newNodeID, f2: parentNodeID, f3: origin}` nested a few levels down
  - `f3.f16` — **text edit**: `f1` = nodeID, subtree holds inserted text runs
    as `f4` strings (CRDT position info sits in sibling varints — not yet
    mapped, so heavy mid-string edits can reassemble slightly out of order)
  - `f3.f18` — style ops; `f3.f8`/`f3.f10` — geometry/selection-ish; ignored

Deletions are not yet mapped (deleted nodes may linger in output as
`(untitled)`).

## Preview images

MindNode caches its own renders next to the snapshots:
`Assets/<documentID>_{fullSize|thumbnail}_{light|dark}_<hash>.jpeg` — a free,
pixel-perfect ground truth for any document that has been opened once.

## Other automation surfaces (write path)

- **File import**: `open -a MindNode <file>` with Markdown/OPML/FreeMind/
  TaskPaper/TextBundle/Xmind/iThoughts silently imports into the library as a
  new document (first `#` heading = central node). This is the current
  `create_mindmap` mechanism.
- **URL scheme**: `mindnode://documents/<documentID>/content/`,
  `mindnode://documents/by-name/<name>/content/`,
  `mindnode-next://newDocument?type=mindMap|outline`.
- **App Intents** (Shortcuts, 20 of them): CreateDocument, CreateNode,
  EditNode, DeleteNode, DeleteDocument, ExportDocument, ImportDocument,
  GetCurrentDocument, OpenDocument, OpenRecentDocument, RenameDocument,
  MoveDocuments, CreateFolder, MoveFolder, ShareViaWeb … Only reachable from
  the Shortcuts app / `shortcuts run <wrapper>`, so using them requires
  installing wrapper shortcuts once (planned phase 2 for node-level edits and
  lossless export).

## Research tooling

`tools/spelunk.py <blob-file>` pretty-prints any envelope/snapshot/op-batch
blob as a raw protobuf tree (handles the envelope and LZ4 framing).
