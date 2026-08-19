# MindNode MCP Server

[![npm](https://img.shields.io/npm/v/mindnode-mcp)](https://www.npmjs.com/package/mindnode-mcp)
[![license](https://img.shields.io/npm/l/mindnode-mcp)](LICENSE)
![node](https://img.shields.io/node/v/mindnode-mcp)
![platform](https://img.shields.io/badge/platform-macOS-lightgrey)

**Connect [MindNode](https://mindnode.com) to Claude and any AI agent — an
MCP server for the mind-mapping app that has no API, no AppleScript, and no
exportable files.**

MindNode Next (the 2024+ generation of MindNode) moved all documents into a
private SQLite/CRDT library and ships **zero automation surface**: no
AppleScript dictionary, no CLI, no cloud API, not even `.mindnode` files on
disk anymore. This project reverse-engineered the storage format so AI agents
can finally read and create mind maps:

- **Read** any mind map as a Markdown outline — straight from MindNode's
  local library (SQLite → protobuf → Apple LZ4 → CRDT decode), read-only,
  without even launching the app.
- **See** the exact rendered map — MindNode's own preview JPEGs, pixel-perfect.
- **Create** new mind maps from Markdown outlines (silent in-app import).
- **Open** any map by name via the `mindnode://` URL scheme.

Works with Claude Code, Claude Desktop, and any MCP client.

> Looking for the classic file-based MindNode? Older plist-based tools cover
> `.mindnode` documents; this server is for **MindNode Next (2024+)**, the
> SQLite-library generation where those approaches no longer work. Verified
> on MindNode 2026.4.4.

## Tools

| tool                | what it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `list_mindmaps`     | list all mind maps in the library (title, id, modified)             |
| `get_mindmap`       | read a mind map as a Markdown outline (best-effort CRDT decode)     |
| `get_mindmap_image` | MindNode's own rendered JPEG preview — pixel-perfect ground truth   |
| `create_mindmap`    | create a new mind map from a Markdown outline (imports via the app) |
| `open_mindmap`      | open a mind map in MindNode                                         |

## Install

Requires macOS with MindNode 2024+ and Node.js ≥ 24.

**Claude Code:**

```sh
claude mcp add --scope user mindnode -- npx -y mindnode-mcp
```

**Claude Desktop / any MCP client** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mindnode": {
      "command": "npx",
      "args": ["-y", "mindnode-mcp"]
    }
  }
}
```

**From source** (Node ≥ 24 runs the TypeScript directly, no build step):

```sh
git clone https://github.com/jyuwaaw/mindnode-mcp.git
cd mindnode-mcp && npm install
claude mcp add --scope user mindnode -- node /path/to/mindnode-mcp/src/index.ts
```

Debug with the MCP inspector: `npm run inspect`.

## How I use it

I keep a daily mind map (one per day, plus per-project maps) as my working
memory — Raycast is set up to summon MindNode with a single keystroke, so
capturing a thought costs nothing. This server closes the loop: at the end of
the day an agent reads the map, turns it into a work log or blog draft, and
can seed tomorrow's map from open threads. Ask Claude things like:

- *"list my mind maps"*
- *"read today's map and draft a standup update"*
- *"turn this outline into a mind map: …"*

## How it works

MindNode Next stores everything in a GRDB/SQLite library inside its sandbox
container. Each document is a protobuf **base snapshot** plus a stream of
CRDT **operation batches**, both wrapped in a tiny envelope (field 12345 =
version, field 678910 = payload — yes, really) and compressed with Apple's
LZ4 framing (`bv41`/`bv4-`/`bv4$` blocks).

This repo carries a schema-less protobuf parser, a pure-TypeScript Apple-LZ4
decoder, and a tree reconstructor that replays node-creation and text ops.
The full reverse-engineering notes live in [docs/FORMAT.md](docs/FORMAT.md) —
if you want to build your own MindNode tooling, start there.
[`tools/spelunk.py`](tools/spelunk.py) pretty-prints any library blob for
further digging.

Writes deliberately do **not** touch the database (it's CloudKit-synced;
corrupting it would be unforgivable). New documents go through MindNode's own
Markdown importer via `open -a MindNode`, which is silent and lossless.

## Caveats

- `get_mindmap` reconstructs text from a CRDT op stream whose position
  encoding isn't fully mapped: heavily edited strings can come back slightly
  scrambled, and deleted nodes may linger as `(untitled)`. Use
  `get_mindmap_image` when exactness matters. Documents created via
  `create_mindmap` read back losslessly.
- `create_mindmap` launches MindNode (import happens in-app, silently).
- The library is read **read-only, always**. Format verified on MindNode
  2026.4.4; a future MindNode update could shift field numbers — file an
  issue with `tools/spelunk.py` output if outlines come back empty.

## Roadmap

- Node-level edits (add/rename/delete a single node) and lossless export via
  MindNode's 20 App Intents (CreateNode, EditNode, ExportDocument, …) wrapped
  in Shortcuts
- Map the CRDT text-position encoding and deletions for exact reads
- Folder titles, tags/stickers, notes fields

## License

[MIT](LICENSE)
