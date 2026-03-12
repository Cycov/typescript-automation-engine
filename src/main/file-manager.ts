/**
 * File Manager — handles file operations for the built-in editor
 * and external sync (import/export).
 *
 * Only allows access to the automations directory.
 */

import * as fs from "fs";
import * as path from "path";

export interface FileEntry {
  name: string;
  path: string; // relative to automations root
  isDirectory: boolean;
  children?: FileEntry[];
}

export class FileManager {
  private automationsPath: string;
  private syncPath: string;

  constructor(automationsPath: string, syncPath: string) {
    this.automationsPath = automationsPath;
    this.syncPath = syncPath;
  }

  /**
   * List all files in the automations directory recursively.
   */
  listFiles(): FileEntry[] {
    return this.readDirRecursive(this.automationsPath, "");
  }

  private readDirRecursive(absPath: string, relativePath: string): FileEntry[] {
    if (!fs.existsSync(absPath)) return [];

    const entries: FileEntry[] = [];
    const items = fs.readdirSync(absPath, { withFileTypes: true });

    for (const item of items) {
      if (item.name === "node_modules" || item.name.startsWith(".")) continue;

      const itemRelPath = relativePath ? `${relativePath}/${item.name}` : item.name;

      if (item.isDirectory()) {
        entries.push({
          name: item.name,
          path: itemRelPath,
          isDirectory: true,
          children: this.readDirRecursive(path.join(absPath, item.name), itemRelPath),
        });
      } else if (item.name.endsWith(".ts") || item.name.endsWith(".json")) {
        entries.push({
          name: item.name,
          path: itemRelPath,
          isDirectory: false,
        });
      }
    }

    return entries;
  }

  /**
   * Read a file from the automations directory.
   */
  readFile(relativePath: string): string {
    const safePath = this.resolveSafe(relativePath);
    return fs.readFileSync(safePath, "utf-8");
  }

  /**
   * Read all .ts file contents for Monaco pre-loading.
   * Returns an array of { path, content } for every .ts file.
   */
  readAllTsContents(): { path: string; content: string }[] {
    const results: { path: string; content: string }[] = [];
    this.collectTsFiles(this.automationsPath, "", results);
    return results;
  }

  private collectTsFiles(absDir: string, relDir: string, out: { path: string; content: string }[]): void {
    if (!fs.existsSync(absDir)) return;
    const items = fs.readdirSync(absDir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === "node_modules" || item.name.startsWith(".")) continue;
      const relPath = relDir ? `${relDir}/${item.name}` : item.name;
      if (item.isDirectory()) {
        this.collectTsFiles(path.join(absDir, item.name), relPath, out);
      } else if (item.name.endsWith(".ts")) {
        try {
          const content = fs.readFileSync(path.join(absDir, item.name), "utf-8");
          out.push({ path: relPath, content });
        } catch { /* skip unreadable files */ }
      }
    }
  }

  /**
   * Write a file in the automations directory.
   */
  writeFile(relativePath: string, content: string): void {
    const safePath = this.resolveSafe(relativePath);
    const dir = path.dirname(safePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(safePath, content, "utf-8");
  }

  /**
   * Create a new file.
   */
  createFile(relativePath: string, content: string = ""): void {
    const safePath = this.resolveSafe(relativePath);
    if (fs.existsSync(safePath)) {
      throw new Error(`File already exists: ${relativePath}`);
    }
    this.writeFile(relativePath, content);
  }

  /**
   * Delete a file or directory.
   */
  deleteFile(relativePath: string): void {
    const safePath = this.resolveSafe(relativePath);
    if (!fs.existsSync(safePath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      fs.rmSync(safePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(safePath);
    }
  }

  /**
   * Create a directory.
   */
  createDirectory(relativePath: string): void {
    const safePath = this.resolveSafe(relativePath);
    fs.mkdirSync(safePath, { recursive: true });
  }

  /**
   * Rename/move a file.
   */
  renameFile(oldRelPath: string, newRelPath: string): void {
    const oldSafe = this.resolveSafe(oldRelPath);
    const newSafe = this.resolveSafe(newRelPath);
    const dir = path.dirname(newSafe);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.renameSync(oldSafe, newSafe);
  }

  /**
   * Export automations to sync path.
   * Includes .ts files and .d.ts type definitions.
   */
  exportToSync(): { exported: number } {
    const syncDir = this.syncPath;
    if (!fs.existsSync(syncDir)) {
      fs.mkdirSync(syncDir, { recursive: true });
    }

    let exported = 0;

    const copyRecursive = (src: string, dest: string) => {
      if (!fs.existsSync(src)) return;
      const items = fs.readdirSync(src, { withFileTypes: true });

      for (const item of items) {
        if (item.name === "node_modules" || item.name.startsWith(".")) continue;

        const srcPath = path.join(src, item.name);
        const destPath = path.join(dest, item.name);

        if (item.isDirectory()) {
          if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
          copyRecursive(srcPath, destPath);
        } else if (item.name.endsWith(".ts") || item.name.endsWith(".d.ts") || item.name.endsWith(".json")) {
          fs.copyFileSync(srcPath, destPath);
          exported++;
        }
      }
    };

    copyRecursive(this.automationsPath, syncDir);

    // Also copy type definitions if they exist
    const typesDir = path.join(this.automationsPath, "node_modules", "tae");
    const typesDestDir = path.join(syncDir, "node_modules", "tae");
    if (fs.existsSync(typesDir)) {
      if (!fs.existsSync(typesDestDir)) fs.mkdirSync(typesDestDir, { recursive: true });
      copyRecursive(typesDir, typesDestDir);
    }

    return { exported };
  }

  /**
   * Import automations from sync path.
   * Overwrites existing files without validation.
   */
  importFromSync(): { imported: number } {
    const syncDir = this.syncPath;
    if (!fs.existsSync(syncDir)) {
      throw new Error(`Sync path does not exist: ${syncDir}`);
    }

    let imported = 0;

    const copyRecursive = (src: string, dest: string) => {
      const items = fs.readdirSync(src, { withFileTypes: true });

      for (const item of items) {
        if (item.name === "node_modules" || item.name.startsWith(".")) continue;

        const srcPath = path.join(src, item.name);
        const destPath = path.join(dest, item.name);

        if (item.isDirectory()) {
          if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
          copyRecursive(srcPath, destPath);
        } else if (item.name.endsWith(".ts") || item.name.endsWith(".json")) {
          fs.copyFileSync(srcPath, destPath);
          imported++;
        }
      }
    };

    copyRecursive(syncDir, this.automationsPath);
    return { imported };
  }

  /**
   * Resolve a relative path to an absolute path, ensuring it stays within automations directory.
   */
  private resolveSafe(relativePath: string): string {
    const resolved = path.resolve(this.automationsPath, relativePath);
    if (!resolved.startsWith(this.automationsPath)) {
      throw new Error("Path traversal not allowed");
    }
    return resolved;
  }
}
