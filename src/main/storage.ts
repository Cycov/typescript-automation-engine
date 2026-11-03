/**
 * Storage layer — SQLite for persistent, Map for temporary.
 * Automation storage is namespaced by automation ID; TAE's own settings
 * live in a separate table so they never show up in the storage viewer.
 */

import Database from "better-sqlite3";

export class Storage {
  private db: Database.Database;
  private tempStore = new Map<string, any>();

  private stmtGet: Database.Statement;
  private stmtSet: Database.Statement;
  private stmtDel: Database.Statement;
  private stmtSettingGet: Database.Statement;
  private stmtSettingSet: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS test_scenarios (
        id TEXT PRIMARY KEY,
        scenario TEXT NOT NULL,
        last_result TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        content TEXT,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS file_history_path ON file_history (path, id);
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
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
    this.stmtSettingGet = this.db.prepare("SELECT value FROM settings WHERE key = ?");
    this.stmtSettingSet = this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  }

  /** The database, for tables owned by other modules (file history). */
  get database(): Database.Database {
    return this.db;
  }

  // ─── Test scenarios ─────────────────────────────────────────

  listTestScenarios(): Array<{ scenario: any; lastResult: any }> {
    const rows = this.db
      .prepare("SELECT scenario, last_result FROM test_scenarios ORDER BY updated_at DESC")
      .all() as { scenario: string; last_result: string | null }[];
    return rows.map((row) => ({ scenario: JSON.parse(row.scenario), lastResult: row.last_result ? JSON.parse(row.last_result) : null }));
  }

  getTestScenario(id: string): { scenario: any; lastResult: any } | undefined {
    const row = this.db.prepare("SELECT scenario, last_result FROM test_scenarios WHERE id = ?").get(id) as
      | { scenario: string; last_result: string | null }
      | undefined;
    return row ? { scenario: JSON.parse(row.scenario), lastResult: row.last_result ? JSON.parse(row.last_result) : null } : undefined;
  }

  saveTestScenario(id: string, scenario: any): void {
    this.db
      .prepare(
        "INSERT INTO test_scenarios (id, scenario, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET scenario = excluded.scenario, updated_at = excluded.updated_at"
      )
      .run(id, JSON.stringify(scenario), Date.now());
  }

  getChatSession(id: string): any | undefined {
    const row = this.db.prepare("SELECT data FROM chat_sessions WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  saveChatSession(id: string, data: any): void {
    this.db
      .prepare("INSERT INTO chat_sessions (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
      .run(id, JSON.stringify(data), Date.now());
  }

  deleteChatSession(id: string): void {
    this.db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
  }

  /** Drop chats older than maxAgeMs, and the oldest beyond keepCount. */
  pruneChatSessions(maxAgeMs: number, keepCount: number): void {
    this.db.prepare("DELETE FROM chat_sessions WHERE updated_at < ?").run(Date.now() - maxAgeMs);
    this.db
      .prepare("DELETE FROM chat_sessions WHERE id NOT IN (SELECT id FROM chat_sessions ORDER BY updated_at DESC LIMIT ?)")
      .run(keepCount);
  }

  saveTestResult(id: string, result: any): void {
    this.db.prepare("UPDATE test_scenarios SET last_result = ? WHERE id = ?").run(JSON.stringify(result), id);
  }

  deleteTestScenario(id: string): void {
    this.db.prepare("DELETE FROM test_scenarios WHERE id = ?").run(id);
  }

  getSetting<T = any>(key: string): T | undefined {
    const row = this.stmtSettingGet.get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  setSetting(key: string, value: any): void {
    this.stmtSettingSet.run(key, JSON.stringify(value));
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
