// Blob store: OPFS-equivalent artifact bytes.
// Contract (browser + Node identical):
//  - writeStaged(id, bytes) -> immutable staged blob
//  - publish(id, expectedBytes, expectedSha256) verifies then commits
//  - read(id) returns bytes only for published blobs
//  - listOrphanStaged() finds staged blobs for post-crash GC
// Browser impl uses OPFS (navigator.storage.getDirectory); this file ships
// the Node filesystem impl for tests plus an in-memory impl. The DB holds
// artifact *metadata*; bytes live here. Never one without the other:
// publish = flush+verify bytes, then commit metadata (see store.ts).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface BlobStore {
  writeStaged(id: string, bytes: Uint8Array): void;
  publish(id: string, expectedBytes: number, expectedSha256: string): void;
  read(id: string): Uint8Array;
  listOrphanStaged(): string[];
}

export class MemoryBlobStore implements BlobStore {
  private staged = new Map<string, Uint8Array>();
  private published = new Map<string, Uint8Array>();

  writeStaged(id: string, bytes: Uint8Array): void {
    if (this.published.has(id)) throw new Error(`blob ${id} already published`);
    this.staged.set(id, bytes);
  }

  publish(id: string, expectedBytes: number, expectedSha256: string): void {
    const bytes = this.staged.get(id);
    if (!bytes) throw new Error(`unknown staged blob ${id}`);
    if (bytes.length !== expectedBytes || sha256Hex(bytes) !== expectedSha256) {
      throw new Error(`blob verification failed for ${id}`);
    }
    this.staged.delete(id);
    this.published.set(id, bytes);
  }

  read(id: string): Uint8Array {
    const bytes = this.published.get(id);
    if (!bytes) throw new Error(`blob ${id} not published`);
    return bytes;
  }

  listOrphanStaged(): string[] {
    return [...this.staged.keys()];
  }
}

/** Node filesystem impl: <root>/staged/<id>, <root>/published/<id>. Atomic via write-tmp + rename. */
export class FsBlobStore implements BlobStore {
  private stagedDir: string;
  private publishedDir: string;

  constructor(root: string) {
    this.stagedDir = join(root, 'staged');
    this.publishedDir = join(root, 'published');
    mkdirSync(this.stagedDir, { recursive: true });
    mkdirSync(this.publishedDir, { recursive: true });
  }

  writeStaged(id: string, bytes: Uint8Array): void {
    assertSafeId(id);
    const tmp = join(this.stagedDir, `${id}.tmp`);
    const dst = join(this.stagedDir, id);
    writeFileSync(tmp, bytes);
    renameSync(tmp, dst);
  }

  publish(id: string, expectedBytes: number, expectedSha256: string): void {
    assertSafeId(id);
    const src = join(this.stagedDir, id);
    let bytes: Buffer;
    try {
      bytes = readFileSync(src);
    } catch {
      throw new Error(`unknown staged blob ${id}`);
    }
    if (bytes.length !== expectedBytes || sha256Hex(bytes) !== expectedSha256) {
      throw new Error(`blob verification failed for ${id}`);
    }
    const dst = join(this.publishedDir, id);
    renameSync(src, dst);
  }

  read(id: string): Uint8Array {
    assertSafeId(id);
    try {
      return new Uint8Array(readFileSync(join(this.publishedDir, id)));
    } catch {
      throw new Error(`blob ${id} not published`);
    }
  }

  listOrphanStaged(): string[] {
    return readdirSync(this.stagedDir).filter((f) => !f.endsWith('.tmp'));
  }

  /** Test helper: remove all blobs. */
  clear(): void {
    for (const f of readdirSync(this.stagedDir)) rmSync(join(this.stagedDir, f));
    for (const f of readdirSync(this.publishedDir)) rmSync(join(this.publishedDir, f));
  }
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`unsafe blob id ${id}`);
}
