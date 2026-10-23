import { createHash } from "node:crypto";
import { chmodSync, constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Collection } from "../core/types.ts";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const ARTIFACT_NAME = /^[a-f0-9]{64}\.json$/;
export type ArtifactContent = { digest: string; bytes: number };

export class ArtifactStore {
  readonly directory: string;

  constructor(stateDir: string) { this.directory = resolve(stateDir, "artifacts"); }

  put(collection: Collection): ArtifactContent {
    const content = Buffer.from(`${JSON.stringify({ version: 1, items: collection.items,
      ...(collection.diagnostics ? { diagnostics: collection.diagnostics } : {}) })}\n`);
    if (content.byteLength > MAX_ARTIFACT_BYTES) throw new Error("observation artifact exceeds 16 MiB");
    const digest = createHash("sha256").update(content).digest("hex");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink()) throw new Error("artifact directory must be a real directory");
    chmodSync(this.directory, 0o700);
    const path = this.path(digest);
    let fd: number;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const existing = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const metadata = fstatSync(existing);
        if (!metadata.isFile() || metadata.size !== content.byteLength || !readFileSync(existing).equals(content)) throw new Error("existing artifact does not match its digest");
        fchmodSync(existing, 0o600);
      } finally { closeSync(existing); }
      return { digest, bytes: content.byteLength };
    }
    try { writeFileSync(fd, content); fsyncSync(fd); }
    catch (error) { unlinkSync(path); throw error; }
    finally { closeSync(fd); }
    return { digest, bytes: content.byteLength };
  }

  path(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid artifact digest");
    return resolve(this.directory, `${digest}.json`);
  }

  // Call under the same database write lock as acceptance; no live writer can lose a blob.
  prune(retained: ReadonlySet<string>): void {
    let entries;
    try {
      if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink()) throw new Error("artifact directory must be a real directory");
      entries = readdirSync(this.directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (ARTIFACT_NAME.test(entry.name) && !retained.has(entry.name.slice(0, -5)) && !entry.isDirectory()) unlinkSync(resolve(this.directory, entry.name));
    }
  }
}
