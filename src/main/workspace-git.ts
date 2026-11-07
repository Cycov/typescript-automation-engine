/**
 * Workspace in git — TAE keeps the automations workspace as a git repository, so
 * a piece of work can be reviewed as one diff across files, committed with a
 * message, and cloned from a mirror outside the add-on (by default /share/tae.git,
 * reachable over SSH or Samba). The file history still records every single save;
 * commits are the named steps on top of it.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const GITIGNORE = "node_modules/\ndist/\n";
const COMMITTER_NAME = "TAE";
const COMMITTER_EMAIL = "tae@homeassistant.local";
const INITIAL_MESSAGE = "Workspace as it was when TAE started keeping it in git";
const MIRROR_REMOTE = "mirror";
const BRANCH = "main";
const LOG_FIELD_SEPARATOR = "\x1f";

export interface WorkspaceCommit {
  hash: string;
  date: string;
  author: string;
  message: string;
}

export interface WorkspaceChanges {
  /** Changed files with +/- counts ("git diff --stat"); empty when nothing changed. */
  stat: string;
  diff: string;
}

type LogFn = (level: "info" | "warn" | "error", message: string) => void;

export class WorkspaceGit {
  private workspace: string;
  private mirrorPath: string;
  private log: LogFn;
  private ready = false;
  private queue: Promise<unknown> = Promise.resolve();

  /** mirrorPath "" = no mirror. */
  constructor(workspace: string, mirrorPath: string, log: LogFn) {
    this.workspace = workspace;
    this.mirrorPath = mirrorPath;
    this.log = log;
  }

  get enabled(): boolean {
    return this.ready;
  }

  get mirror(): string {
    return this.mirrorPath;
  }

  /** Make the workspace a repository (first start: one commit with everything as it is) and set up the mirror. */
  async init(): Promise<void> {
    try {
      await this.git(["--version"]);
    } catch {
      this.log("warn", "git is not installed: the workspace is not kept in git");
      return;
    }
    try {
      const fresh = !fs.existsSync(path.join(this.workspace, ".git"));
      if (fresh) await this.git(["init", "-q", "-b", BRANCH]);
      await this.git(["config", "user.name", COMMITTER_NAME]);
      await this.git(["config", "user.email", COMMITTER_EMAIL]);
      await this.git(["config", "core.autocrlf", "false"]);
      const ignorePath = path.join(this.workspace, ".gitignore");
      if (!fs.existsSync(ignorePath)) fs.writeFileSync(ignorePath, GITIGNORE);
      if (!(await this.hasCommits())) {
        await this.git(["add", "-A"]);
        await this.git(["commit", "-q", "--allow-empty", "-m", INITIAL_MESSAGE]);
        this.log("info", `Workspace is now a git repository (${INITIAL_MESSAGE.toLowerCase()})`);
      }
      this.ready = true;
      await this.setUpMirror();
    } catch (err: any) {
      this.log("error", `Could not keep the workspace in git: ${err.message}`);
    }
  }

  /** Everything changed since `since` (a commit, default the last one), new files included. */
  changes(since = "HEAD", file?: string): Promise<WorkspaceChanges> {
    return this.serialized(async () => {
      this.assertReady();
      await this.git(["add", "-A"]); //< so new files show up; the index is only ever used for the next commit
      const scope = file ? ["--", file] : [];
      const stat = await this.git(["diff", "--cached", "--stat", since, ...scope]);
      const diff = await this.git(["diff", "--cached", since, ...scope]);
      return { stat: stat.trimEnd(), diff };
    });
  }

  /**
   * Commit the changes (only `files` when given, so someone else's unrelated edits stay out) and push them to the
   * mirror. Returns undefined when there is nothing to commit.
   */
  commit(message: string, author: string, files?: string[]): Promise<{ commit: WorkspaceCommit; stat: string } | undefined> {
    return this.serialized(async () => {
      this.assertReady();
      const scope = files && files.length ? ["--", ...files] : [];
      await this.git(["add", "-A", ...scope]);
      const staged = (await this.git(["diff", "--cached", "--name-only", ...scope])).trim();
      if (!staged) return undefined;
      if (scope.length) {
        // commit only the named files; whatever else was staged goes back to "changed"
        await this.git(["commit", "-q", "-m", message, `--author=${author} <${COMMITTER_EMAIL}>`, ...scope]);
      } else {
        await this.git(["commit", "-q", "-m", message, `--author=${author} <${COMMITTER_EMAIL}>`]);
      }
      const [commit] = await this.readLog(1);
      const stat = (await this.git(["show", "--stat", "--format=", "HEAD"])).replace(/^\n+/, "").trimEnd();
      await this.pushMirror();
      return { commit, stat };
    });
  }

  /** Newest first. */
  history(count: number, file?: string): Promise<WorkspaceCommit[]> {
    return this.serialized(async () => {
      this.assertReady();
      return this.readLog(count, file);
    });
  }

  // ─── Internal ───────────────────────────────────────────────

  private async readLog(count: number, file?: string): Promise<WorkspaceCommit[]> {
    const format = ["%h", "%aI", "%an", "%s"].join(LOG_FIELD_SEPARATOR);
    const output = await this.git(["log", `-n${count}`, `--format=${format}`, ...(file ? ["--", file] : [])]);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, date, author, message] = line.split(LOG_FIELD_SEPARATOR);
        return { hash, date, author, message };
      });
  }

  private async hasCommits(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--verify", "-q", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  private async setUpMirror(): Promise<void> {
    if (!this.mirrorPath) return;
    try {
      if (!fs.existsSync(path.join(this.mirrorPath, "HEAD"))) {
        fs.mkdirSync(this.mirrorPath, { recursive: true });
        await this.git(["init", "-q", "--bare", "-b", BRANCH, this.mirrorPath]);
      }
      const remotes = (await this.git(["remote"])).split("\n");
      await this.git(remotes.includes(MIRROR_REMOTE) ? ["remote", "set-url", MIRROR_REMOTE, this.mirrorPath] : ["remote", "add", MIRROR_REMOTE, this.mirrorPath]);
      await this.pushMirror();
      this.log("info", `Workspace history is mirrored to ${this.mirrorPath} (git clone it over SSH or Samba)`);
    } catch (err: any) {
      this.log("warn", `Workspace mirror ${this.mirrorPath} is not available: ${err.message}`);
      this.mirrorPath = "";
    }
  }

  private async pushMirror(): Promise<void> {
    if (!this.mirrorPath) return;
    try {
      await this.git(["push", "-q", "--force", MIRROR_REMOTE, `${BRANCH}:${BRANCH}`]);
    } catch (err: any) {
      this.log("warn", `Could not update the workspace mirror: ${err.message}`);
    }
  }

  private assertReady(): void {
    if (!this.ready) throw new Error("The workspace is not kept in git (git is missing or failed to start; see the TAE log)");
  }

  /** One git operation at a time: they share the index. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const job = this.queue.then(work);
    this.queue = job.catch(() => {});
    return job;
  }

  private git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd: this.workspace, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout);
      });
    });
  }
}
