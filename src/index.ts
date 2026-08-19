#!/usr/bin/env node
// mindnode-mcp — MCP server exposing the local MindNode (macOS) library.
// Reads go straight to MindNode's SQLite/CRDT store (read-only, no GUI);
// writes go through the app via file import and the mindnode:// URL scheme.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  findLibraryPath,
  listDocuments,
  getPreviewImage,
  resolveDocument,
} from "./library.ts";
import { buildTree, treeToMarkdown } from "./mindmap.ts";
import { importMarkdown, openDocumentById } from "./actions.ts";

const server = new McpServer({ name: "mindnode", version: "0.1.0" });

const docRef = z
  .string()
  .describe("Document reference: a documentID (UUID) or a document title");

server.registerTool(
  "list_mindmaps",
  {
    title: "List mind maps",
    description:
      "List all mind maps in the local MindNode library (title, documentID, last modified). Read-only.",
    inputSchema: {
      includeTrashed: z.boolean().optional().describe("Include trashed documents (default false)"),
    },
  },
  async ({ includeTrashed }) => {
    const docs = listDocuments(findLibraryPath(), includeTrashed ?? false);
    return { content: [{ type: "text", text: JSON.stringify(docs, null, 2) }] };
  },
);

server.registerTool(
  "get_mindmap",
  {
    title: "Read a mind map",
    description:
      "Read a mind map's content as a Markdown outline (root heading + nested bullets), reconstructed from MindNode's local store. Best-effort: heavily edited text may be imperfect — cross-check with get_mindmap_image when exactness matters.",
    inputSchema: { document: docRef },
  },
  async ({ document }) => {
    const lib = findLibraryPath();
    const doc = resolveDocument(lib, document);
    const tree = buildTree(doc, lib);
    const outline = treeToMarkdown(tree);
    const header = `<!-- ${doc.title} · ${doc.documentID} · modified ${doc.modified} -->`;
    return {
      content: [
        { type: "text", text: outline ? `${header}\n${outline}` : `${header}\n(empty mind map)` },
      ],
    };
  },
);

server.registerTool(
  "get_mindmap_image",
  {
    title: "Render a mind map image",
    description:
      "Return MindNode's own rendered preview (JPEG) of a mind map — the exact visual, useful to verify layout or ambiguous text.",
    inputSchema: {
      document: docRef,
      appearance: z.enum(["light", "dark"]).optional().describe("Preview appearance (default light)"),
    },
  },
  async ({ document, appearance }) => {
    const lib = findLibraryPath();
    const doc = resolveDocument(lib, document);
    const img =
      getPreviewImage(lib, doc.documentID, appearance ?? "light") ??
      getPreviewImage(lib, doc.documentID, appearance === "dark" ? "light" : "dark");
    if (!img) {
      return {
        content: [
          {
            type: "text",
            text: `no preview image cached for "${doc.title}" — open it once in MindNode to generate one`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "image", data: img.toString("base64"), mimeType: "image/jpeg" }],
    };
  },
);

server.registerTool(
  "create_mindmap",
  {
    title: "Create a mind map",
    description:
      "Create a new mind map in MindNode by importing Markdown. The first `#` heading becomes the central node; nested bullet lists (and deeper headings) become branches — write any consistent indentation, it is re-emitted at the four spaces per level MindNode requires. The document lands at the library root (placing it in a folder is not supported yet), and MindNode auto-renames the document if the title already exists — the central node keeps the requested title regardless.",
    inputSchema: {
      title: z.string().describe("Central node / document title"),
      markdown: z
        .string()
        .describe(
          "Markdown outline. Example: `# Title\\n- branch A\\n  - leaf\\n- branch B`. A missing `#` heading is added from the title.",
        ),
    },
  },
  async ({ title, markdown }) => {
    const path = await importMarkdown(title, markdown);
    return {
      content: [
        {
          type: "text",
          text: `Sent "${title}" to MindNode for import (source file: ${path}). It should open as a new mind map momentarily.`,
        },
      ],
    };
  },
);

server.registerTool(
  "open_mindmap",
  {
    title: "Open a mind map",
    description: "Open a mind map in the MindNode app (brings it to the foreground).",
    inputSchema: { document: docRef },
  },
  async ({ document }) => {
    const lib = findLibraryPath();
    const doc = resolveDocument(lib, document);
    await openDocumentById(doc.documentID);
    return { content: [{ type: "text", text: `Opened "${doc.title}" in MindNode.` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
