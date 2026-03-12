/**
 * Logging system — in-memory log buffer with real-time listeners.
 * Logs are cleared on restart.
 */

export interface LogEntry {
  timestamp: string;
  level: string;
  source: string;
  message: string;
  extra?: any;
}

const LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private entries: LogEntry[] = [];
  private maxEntries = 5000;
  private listeners: ((entry: LogEntry) => void)[] = [];
  private logLevel: string;

  constructor(logLevel: string = "info") {
    this.logLevel = logLevel;
  }

  log(level: string, source: string, message: any, extra?: any): void {
    // Format message: if it's an object, pretty-print it
    let formattedMessage: string;
    if (typeof message === "string") {
      formattedMessage = message;
    } else if (message === null || message === undefined) {
      formattedMessage = String(message);
    } else if (typeof message === "object") {
      try {
        formattedMessage = JSON.stringify(message, null, 2);
      } catch {
        formattedMessage = String(message);
      }
    } else {
      formattedMessage = String(message);
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      message: formattedMessage,
      extra,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    for (const cb of this.listeners) {
      try {
        cb(entry);
      } catch {}
    }

    // Console output respects configured log level
    const currentLevel = LEVEL_ORDER[this.logLevel] ?? 1;
    const msgLevel = LEVEL_ORDER[level] ?? 0;
    if (msgLevel >= currentLevel) {
      const prefix = `[${level.toUpperCase()}] [${source}]`;
      if (level === "error") {
        console.error(`${prefix} ${formattedMessage}`);
      } else if (level === "warn") {
        console.warn(`${prefix} ${formattedMessage}`);
      } else {
        console.log(`${prefix} ${formattedMessage}`);
      }
    }
  }

  getLogs(count: number = 500): LogEntry[] {
    return this.entries.slice(-count);
  }

  clearLogs(): void {
    this.entries = [];
  }

  onLog(cb: (entry: LogEntry) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const idx = this.listeners.indexOf(cb);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
}
