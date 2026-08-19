// Actions that go through the MindNode app itself (LaunchServices + the
// mindnode:// URL scheme). Creating documents works by handing MindNode a
// Markdown file to import — it opens as a new mind map in the library.
//
// Markdown is the only import format that works this way: MindNode registers
// as a Viewer for OPML/FreeMind/TaskPaper too, but `open`-ing those is
// silently ignored (no document created), so don't route writes through them.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[/\\:\0]/g, "-").trim();
  return cleaned.length > 0 && cleaned.length <= 200 ? cleaned : "Mind Map";
}

const LIST_ITEM = /^([ \t]*)([-*+]|\d+\.)[ \t]+(.*)$/;
const MINDNODE_INDENT = "    ";

// MindNode's Markdown importer only nests a list item when it is indented by
// four spaces (or a tab) per level. The common two-space convention comes
// back flattened into siblings, so re-emit the caller's outline at four
// spaces per level — depth is taken from the order of indent widths seen,
// which keeps any self-consistent input (2, 3, 4 spaces, tabs) intact.
export function normalizeListIndent(markdown: string): string {
  const widths: number[] = [];
  return markdown
    .split("\n")
    .map((line) => {
      const m = LIST_ITEM.exec(line);
      if (!m) {
        // a heading or paragraph ends the current list context
        if (line.trim()) widths.length = 0;
        return line;
      }
      const [, ws, bullet, text] = m;
      const width = ws.replace(/\t/g, MINDNODE_INDENT).length;
      while (widths.length > 0 && widths[widths.length - 1] > width) widths.pop();
      if (widths.length === 0 || widths[widths.length - 1] < width) widths.push(width);
      return `${MINDNODE_INDENT.repeat(widths.length - 1)}${bullet} ${text}`;
    })
    .join("\n");
}

// Write markdown to a temp file and let MindNode import it. The first heading
// becomes the central node; nested list items (and deeper headings) become
// branches. Note MindNode renames the document when `title` collides with an
// existing one — the central node keeps the title you asked for either way.
export async function importMarkdown(title: string, markdown: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mindnode-mcp-"));
  const path = join(dir, `${sanitizeFilename(title)}.md`);
  const body = normalizeListIndent(markdown);
  const content = body.trimStart().startsWith("#") ? body : `# ${title}\n\n${body}`;
  writeFileSync(path, content, "utf8");
  await run("/usr/bin/open", ["-a", "MindNode", path]);
  return path;
}

export async function openDocumentById(documentID: string): Promise<void> {
  await run("/usr/bin/open", [`mindnode://documents/${documentID}/content/`]);
}

export async function openDocumentByName(name: string): Promise<void> {
  await run("/usr/bin/open", [
    `mindnode://documents/by-name/${encodeURIComponent(name)}/content/`,
  ]);
}
