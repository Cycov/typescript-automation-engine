/**
 * AI memory — short notes the AI keeps across chats (terminology, house layout,
 * preferences), editable by the user. Also holds the saved-chat limits.
 */

import Database from "better-sqlite3";
import { Storage } from "../storage";

export const MEMORY_NOTE_MAX_CHARS = 500;
export const MEMORY_TOTAL_MAX_CHARS = 8000; //< every note goes into each chat's instructions
const SETTINGS_KEY = "ai_memory_settings";
const DEFAULT_CHAT_RETENTION_DAYS = 14;
const DEFAULT_MAX_SAVED_CHATS = 50;
const MIN_CHAT_RETENTION_DAYS = 1;
const MAX_CHAT_RETENTION_DAYS = 365;
const MIN_SAVED_CHATS = 1;
const MAX_SAVED_CHATS = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type MemorySource = "user" | "ai";

export interface MemoryNote {
  id: number;
  text: string;
  source: MemorySource; //< who wrote the current text
  createdAt: number;
  updatedAt: number;
}

export interface MemorySettings {
  aiCanWrite: boolean;
  chatRetentionDays: number;
  maxSavedChats: number;
}

export interface MemoryState {
  notes: MemoryNote[];
  settings: MemorySettings;
  totalChars: number;
  maxChars: number;
  noteMaxChars: number;
  savedChats: { count: number; bytes: number };
}

interface NoteRow {
  id: number;
  text: string;
  source: MemorySource;
  created_at: number;
  updated_at: number;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export class AIMemory {
  private db: Database.Database;
  private storage: Storage;
  private listeners: (() => void)[] = [];

  constructor(storage: Storage) {
    this.storage = storage;
    this.db = storage.database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  list(): MemoryNote[] {
    const rows = this.db.prepare("SELECT id, text, source, created_at, updated_at FROM ai_memory ORDER BY id").all() as NoteRow[];
    return rows.map((row) => ({ id: row.id, text: row.text, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  totalChars(notes: MemoryNote[] = this.list()): number {
    return notes.reduce((total, note) => total + note.text.length, 0);
  }

  add(text: string, source: MemorySource): MemoryNote {
    const clean = this.validate(text, 0);
    const now = Date.now();
    const result = this.db.prepare("INSERT INTO ai_memory (text, source, created_at, updated_at) VALUES (?, ?, ?, ?)").run(clean, source, now, now);
    this.changed();
    return { id: Number(result.lastInsertRowid), text: clean, source, createdAt: now, updatedAt: now };
  }

  update(id: number, text: string, source: MemorySource): MemoryNote {
    const existing = this.list().find((note) => note.id === id);
    if (!existing) throw new Error(`No memory note with id ${id}`);
    const clean = this.validate(text, existing.text.length);
    const now = Date.now();
    this.db.prepare("UPDATE ai_memory SET text = ?, source = ?, updated_at = ? WHERE id = ?").run(clean, source, now, id);
    this.changed();
    return { ...existing, text: clean, source, updatedAt: now };
  }

  delete(id: number): MemoryNote {
    const existing = this.list().find((note) => note.id === id);
    if (!existing) throw new Error(`No memory note with id ${id}`);
    this.db.prepare("DELETE FROM ai_memory WHERE id = ?").run(id);
    this.changed();
    return existing;
  }

  settings(): MemorySettings {
    const saved = this.storage.getSetting<Partial<MemorySettings>>(SETTINGS_KEY) || {};
    return {
      aiCanWrite: saved.aiCanWrite !== false,
      chatRetentionDays: clampInteger(saved.chatRetentionDays, MIN_CHAT_RETENTION_DAYS, MAX_CHAT_RETENTION_DAYS, DEFAULT_CHAT_RETENTION_DAYS),
      maxSavedChats: clampInteger(saved.maxSavedChats, MIN_SAVED_CHATS, MAX_SAVED_CHATS, DEFAULT_MAX_SAVED_CHATS),
    };
  }

  updateSettings(change: Partial<MemorySettings>): MemorySettings {
    const current = this.settings();
    const next: MemorySettings = {
      aiCanWrite: typeof change.aiCanWrite === "boolean" ? change.aiCanWrite : current.aiCanWrite,
      chatRetentionDays: clampInteger(change.chatRetentionDays ?? current.chatRetentionDays, MIN_CHAT_RETENTION_DAYS, MAX_CHAT_RETENTION_DAYS, current.chatRetentionDays),
      maxSavedChats: clampInteger(change.maxSavedChats ?? current.maxSavedChats, MIN_SAVED_CHATS, MAX_SAVED_CHATS, current.maxSavedChats),
    };
    this.storage.setSetting(SETTINGS_KEY, next);
    this.pruneChats();
    this.changed();
    return next;
  }

  /** Apply the saved-chat limits. */
  pruneChats(): void {
    const settings = this.settings();
    this.storage.pruneChatSessions(settings.chatRetentionDays * MS_PER_DAY, settings.maxSavedChats);
  }

  state(): MemoryState {
    const notes = this.list();
    return {
      notes,
      settings: this.settings(),
      totalChars: this.totalChars(notes),
      maxChars: MEMORY_TOTAL_MAX_CHARS,
      noteMaxChars: MEMORY_NOTE_MAX_CHARS,
      savedChats: this.storage.chatSessionStats(),
    };
  }

  /** The notes as they go into the chat instructions. */
  promptBlock(): string {
    const notes = this.list();
    const settings = this.settings();
    const howToWrite = settings.aiCanWrite
      ? "Save new facts with remember, fix outdated ones with update_memory and drop wrong ones with forget."
      : "The user turned off saving notes, so remember, update_memory and forget will fail; suggest a note for the user to add instead.";
    if (notes.length === 0) return `(No notes yet.) ${howToWrite}`;
    return `${notes.map((note) => `- [${note.id}] ${note.text}`).join("\n")}\n\n${howToWrite}`;
  }

  notifyChanged(): void {
    this.changed();
  }

  private validate(text: string, replacedChars: number): string {
    const clean = String(text ?? "").trim().replace(/\s*\n\s*/g, " ");
    if (!clean) throw new Error("The note is empty");
    if (clean.length > MEMORY_NOTE_MAX_CHARS) throw new Error(`A note can have at most ${MEMORY_NOTE_MAX_CHARS} characters (this one has ${clean.length}); keep it to one short fact`);
    const total = this.totalChars() - replacedChars + clean.length;
    if (total > MEMORY_TOTAL_MAX_CHARS) {
      throw new Error(`Memory is full (${MEMORY_TOTAL_MAX_CHARS} characters in all). Shorten or remove notes first`);
    }
    return clean;
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch {}
    }
  }
}
