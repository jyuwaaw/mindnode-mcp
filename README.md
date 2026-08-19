# mindnode-mcp

MCP server for [MindNode](https://mindnode.com) on macOS. Lets an AI agent
read your mind maps and create new ones — no AppleScript (MindNode has none),
no GUI scraping.

- **Reads** go straight to MindNode's local library (SQLite + reverse-
  engineered protobuf/LZ4 CRDT store), read-only, without launching the app.
- **Writes** go through the app itself: Markdown import for new documents,
  the `mindnode://` URL scheme for opening.

Requires macOS with MindNode 2024+ ("MindNode Next", the SQLite-library
generation; verified on 2026.4.4) and Node.js ≥ 24 (runs TypeScript
natively — no build step).

## Tools

| tool                | what it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `list_mindmaps`     | list documents in the library (title, id, modified)                 |
| `get_mindmap`       | read a document as a Markdown outline (best-effort CRDT decode)     |
| `get_mindmap_image` | MindNode's own rendered JPEG preview — pixel-perfect ground truth   |
| `create_mindmap`    | create a new mind map from a Markdown outline (imports via the app) |
| `open_mindmap`      | open a document in MindNode                                         |

## Install

```sh
npm install
claude mcp add --scope user mindnode -- node /path/to/mindnode-mcp/src/index.ts
```

Or run the inspector: `npm run inspect`.

## Caveats

- `get_mindmap` reconstructs text from a CRDT op stream whose position
  encoding isn't fully mapped yet: heavily edited strings can come back
  slightly scrambled, and deleted nodes may linger as `(untitled)`. Use
  `get_mindmap_image` when exactness matters. Documents created via
  `create_mindmap` (import → full snapshot) read back losslessly.
- `create_mindmap` launches MindNode (import happens in-app, silently).
- Node-level edits (add/rename/delete a single node) are planned via
  MindNode's App Intents wrapped in Shortcuts — see `docs/FORMAT.md`.

## Format documentation

The reverse-engineered storage format lives in [docs/FORMAT.md](docs/FORMAT.md);
`tools/spelunk.py` pretty-prints any library blob for further digging.
