// Read-only access to the MindNode Next library
// (~/Library/Containers/com.ideasoncanvas.mindnode/.../MindNode Library.mindnodelibrary).
// Documents live in Content.sqlite3; per-document state is a protobuf base
// snapshot (Assets/<documentID>) plus CRDT operation batches (operationBatch
// table). See docs/FORMAT.md.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONTAINER = join(
  homedir(),
  "Library/Containers/com.ideasoncanvas.mindnode/Data/Library/Application Support/MindNode",
);

export interface MindMapDoc {
  documentID: string;
  title: string;
  folderID: string | null;
  modified: string | null;
}

export interface OperationBatch {
  operationBatchID: string;
  creationHLCTimestampString: string;
  data: Buffer;
}

export function findLibraryPath(): string {
  if (!existsSync(CONTAINER)) {
    throw new Error(
      `MindNode library not found at ${CONTAINER} — is MindNode (2024+ "MindNode Next") installed and launched at least once?`,
    );
  }
  // e.g. production-v1_0/MindNode Library.mindnodelibrary
  for (const env of readdirSync(CONTAINER)) {
    const lib = join(CONTAINER, env, "MindNode Library.mindnodelibrary");
    if (existsSync(join(lib, "Content.sqlite3"))) return lib;
  }
  throw new Error(`no .mindnodelibrary with Content.sqlite3 under ${CONTAINER}`);
}

function openDb(libraryPath: string): DatabaseSync {
  return new DatabaseSync(join(libraryPath, "Content.sqlite3"), { readOnly: true });
}

export function listDocuments(libraryPath: string, includeTrashed = false): MindMapDoc[] {
  const db = openDb(libraryPath);
  try {
    const where = includeTrashed ? "" : "WHERE trashDate IS NULL";
    const rows = db
      .prepare(
        `SELECT documentID, title, folderID, localModificationDate AS modified
         FROM document ${where} ORDER BY localModificationDate DESC`,
      )
      .all() as unknown as MindMapDoc[];
    return rows;
  } finally {
    db.close();
  }
}

export function listFolders(libraryPath: string): { folderID: string; title: string }[] {
  const db = openDb(libraryPath);
  try {
    // folder metadata lives in the library table as serialized data; the
    // document table only carries folderID. Folder titles are a later
    // refinement — return IDs for now.
    const rows = db
      .prepare(`SELECT DISTINCT folderID FROM document WHERE folderID IS NOT NULL`)
      .all() as { folderID: string }[];
    return rows.map((r) => ({ folderID: r.folderID, title: r.folderID }));
  } finally {
    db.close();
  }
}

export function getOperationBatches(libraryPath: string, documentID: string): OperationBatch[] {
  const db = openDb(libraryPath);
  try {
    const rows = db
      .prepare(
        `SELECT operationBatchID, creationHLCTimestampString, serializedData
         FROM operationBatch
         WHERE documentID = ? AND localDeletionDate IS NULL
         ORDER BY creationHLCTimestampString ASC`,
      )
      .all(documentID) as unknown as {
      operationBatchID: string;
      creationHLCTimestampString: string;
      serializedData: Uint8Array;
    }[];
    return rows.map((r) => ({
      operationBatchID: r.operationBatchID,
      creationHLCTimestampString: r.creationHLCTimestampString,
      data: Buffer.from(r.serializedData),
    }));
  } finally {
    db.close();
  }
}

export function getBaseSnapshot(libraryPath: string, documentID: string): Buffer | null {
  const path = join(libraryPath, "Assets", documentID);
  return existsSync(path) ? readFileSync(path) : null;
}

// Preview JPEGs rendered by MindNode itself:
// Assets/<documentID>_{fullSize|thumbnail}_{light|dark}_<hash>.jpeg
export function getPreviewImage(
  libraryPath: string,
  documentID: string,
  appearance: "light" | "dark" = "light",
  size: "fullSize" | "thumbnail" = "fullSize",
): Buffer | null {
  const assets = join(libraryPath, "Assets");
  if (!existsSync(assets)) return null;
  const prefix = `${documentID}_${size}_${appearance}_`;
  const match = readdirSync(assets).find((f) => f.startsWith(prefix) && f.endsWith(".jpeg"));
  return match ? readFileSync(join(assets, match)) : null;
}

// Resolve a user-supplied reference (documentID or title, case-insensitive,
// prefix match as fallback) to a document row.
export function resolveDocument(libraryPath: string, ref: string): MindMapDoc {
  const docs = listDocuments(libraryPath, true);
  const byId = docs.find((d) => d.documentID.toLowerCase() === ref.toLowerCase());
  if (byId) return byId;
  const byTitle = docs.filter((d) => d.title.toLowerCase() === ref.toLowerCase());
  if (byTitle.length === 1) return byTitle[0];
  const byPrefix = docs.filter((d) => d.title.toLowerCase().startsWith(ref.toLowerCase()));
  if (byPrefix.length === 1) return byPrefix[0];
  const candidates = (byTitle.length ? byTitle : byPrefix).map((d) => `${d.title} (${d.documentID})`);
  if (candidates.length > 1) {
    throw new Error(`ambiguous document "${ref}": ${candidates.join(", ")}`);
  }
  throw new Error(
    `no document matching "${ref}". Available: ${docs.map((d) => d.title).join(", ") || "(none)"}`,
  );
}
