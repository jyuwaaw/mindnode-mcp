// Actions that go through the MindNode app itself (LaunchServices + the
// mindnode:// URL scheme). Creating documents works by handing MindNode a
// Markdown/OPML file to import — it opens as a new mind map in the library.

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

// Write markdown to a temp file and let MindNode import it. The first
// heading becomes the central node; nested lists / deeper headings become
// branches.
export async function importMarkdown(title: string, markdown: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mindnode-mcp-"));
  const path = join(dir, `${sanitizeFilename(title)}.md`);
  const content = markdown.trimStart().startsWith("#") ? markdown : `# ${title}\n\n${markdown}`;
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
