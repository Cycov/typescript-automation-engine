/**
 * File history — a version of a workspace file on every save, AI edit, import,
 * restore and delete, so any change can be compared and undone.
 */

import Database from "better-sqlite3";

const MAX_VERSIONS_PER_FILE = 200;
const MAX_CONTENT_CHARS = 2_000_000; //< larger files are not versioned
const RECENT_DEFAULT_LIMIT = 100;

export type ChangeSource = "original" | "external" | "editor" | "ai-chat" | "mcp" | "import" | "restore";

export interface FileVersionInfo {
  id: number;
  path: string;
  source: string;
  createdAt: number;
  deleted: boolean;
  lines: number;
}

export interface FileVersion extends FileVersionInfo {
  content: string | null;
}

interface VersionRow {
  id: number;
  path: string;
  content: string | null;
  source: string;
  created_at: number;
}

function toInfo(row: VersionRow): FileVersionInfo {
  return {
    id: row.id,
    path: row.path,
    source: row.source,
    createdAt: row.created_at,
    deleted: row.content === null,
    lines: row.content === null ? 0 : row.content.split("\n").length,
  };
}

export class FileHistory {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Record a version. `previous` is the content on disk before the change: it is
   * stored first (as "original") when the file has no history yet.
   */
  record(path: string, content: string | null, source: ChangeSource, previous?: string | null): void {
    if (content !== null && content.length > MAX_CONTENT_CHARS) return;
    const latest = this.latest(path);
    const knownPrevious = previous !== undefined && previous !== null && previous !== content && previous.length <= MAX_CONTENT_CHARS;
    if (knownPrevious && (!latest || latest.content !== previous)) {
      this.insert(path, previous, latest ? "external" : "original"); //< "external": changed outside TAE (Samba, sync)
    }
    const current = this.latest(path);
    if (current && current.content === content) return; //< nothing changed
    if (!current && content === null) return; //< deleting a file we never saw
    this.insert(path, content, source);
    this.prune(path);
  }

  /** History follows a renamed file or folder. */
  rename(oldPath: string, newPath: string): void {
    const rows = this.db
      .prepare("SELECT DISTINCT path FROM file_history WHERE path = ? OR path LIKE ?")
      .all(oldPath, `${oldPath}/%`) as { path: string }[];
    const update = this.db.prepare("UPDATE file_history SET path = ? WHERE path = ?");
    for (const row of rows) {
      update.run(newPath + row.path.slice(oldPath.length), row.path);
    }
  }

  list(path: string): FileVersionInfo[] {
    const rows = this.db
      .prepare("SELECT id, path, content, source, created_at FROM file_history WHERE path = ? ORDER BY id DESC")
      .all(path) as VersionRow[];
    return rows.map(toInfo);
  }

  /** Latest changes across all files, newest first. */
  recent(limit: number = RECENT_DEFAULT_LIMIT): FileVersionInfo[] {
    const rows = this.db
      .prepare("SELECT id, path, content, source, created_at FROM file_history WHERE source != 'original' ORDER BY id DESC LIMIT ?")
      .all(limit) as VersionRow[];
    return rows.map(toInfo);
  }

  get(id: number): FileVersion | undefined {
    const row = this.db.prepare("SELECT id, path, content, source, created_at FROM file_history WHERE id = ?").get(id) as VersionRow | undefined;
    return row ? { ...toInfo(row), content: row.content } : undefined;
  }

  /** The version before this one of the same file (for "what changed"). */
  previous(id: number): FileVersion | undefined {
    const version = this.get(id);
    if (!version) return undefined;
    const row = this.db
      .prepare("SELECT id, path, content, source, created_at FROM file_history WHERE path = ? AND id < ? ORDER BY id DESC LIMIT 1")
      .get(version.path, id) as VersionRow | undefined;
    return row ? { ...toInfo(row), content: row.content } : undefined;
  }

  private latest(path: string): VersionRow | undefined {
    return this.db
      .prepare("SELECT id, path, content, source, created_at FROM file_history WHERE path = ? ORDER BY id DESC LIMIT 1")
      .get(path) as VersionRow | undefined;
  }

  private insert(path: string, content: string | null, source: string): void {
    this.db.prepare("INSERT INTO file_history (path, content, source, created_at) VALUES (?, ?, ?, ?)").run(path, content, source, Date.now());
  }

  private prune(path: string): void {
    this.db
      .prepare(
        "DELETE FROM file_history WHERE path = ? AND id NOT IN (SELECT id FROM file_history WHERE path = ? ORDER BY id DESC LIMIT ?)"
      )
      .run(path, path, MAX_VERSIONS_PER_FILE);
  }
}
