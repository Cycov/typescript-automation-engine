/**
 * Storage layer — SQLite for persistent, Map for temporary.
 * All storage is namespaced by automation ID.
 */

import Database from "better-sqlite3";

export class Storage {
  private db: Database.Database;
  private tempStore = new Map<string, any>();

  private stmtGet: Database.Statement;
  private stmtSet: Database.Statement;
  private stmtDel: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      )
    `);

    this.stmtGet = this.db.prepare(
      "SELECT value FROM kv_store WHERE namespace = ? AND key = ?"
    );
    this.stmtSet = this.db.prepare(
      "INSERT OR REPLACE INTO kv_store (namespace, key, value) VALUES (?, ?, ?)"
    );
    this.stmtDel = this.db.prepare(
      "DELETE FROM kv_store WHERE namespace = ? AND key = ?"
    );
  }

  persistentGet(namespace: string, key: string): any {
    const row = this.stmtGet.get(namespace, key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  persistentSet(namespace: string, key: string, value: any): void {
    this.stmtSet.run(namespace, key, JSON.stringify(value));
  }

  persistentDelete(namespace: string, key: string): void {
    this.stmtDel.run(namespace, key);
  }

  tempGet(namespace: string, key: string): any {
    return this.tempStore.get(`${namespace}:${key}`);
  }

  tempSet(namespace: string, key: string, value: any): void {
    this.tempStore.set(`${namespace}:${key}`, value);
  }

  tempDelete(namespace: string, key: string): void {
    this.tempStore.delete(`${namespace}:${key}`);
  }

  /** Return all persistent entries grouped by namespace. */
  getAllPersistent(): Record<string, Record<string, any>> {
    const rows = this.db
      .prepare("SELECT namespace, key, value FROM kv_store ORDER BY namespace, key")
      .all() as { namespace: string; key: string; value: string }[];
    const result: Record<string, Record<string, any>> = {};
    for (const row of rows) {
      if (!result[row.namespace]) result[row.namespace] = {};
      try {
        result[row.namespace][row.key] = JSON.parse(row.value);
      } catch {
        result[row.namespace][row.key] = row.value;
      }
    }
    return result;
  }

  /** Return all temp entries grouped by namespace. */
  getAllTemp(): Record<string, Record<string, any>> {
    const result: Record<string, Record<string, any>> = {};
    for (const [compositeKey, value] of this.tempStore) {
      const sepIdx = compositeKey.indexOf(":");
      const namespace = compositeKey.substring(0, sepIdx);
      const key = compositeKey.substring(sepIdx + 1);
      if (!result[namespace]) result[namespace] = {};
      result[namespace][key] = value;
    }
    return result;
  }

  close(): void {
    this.db.close();
  }
}
