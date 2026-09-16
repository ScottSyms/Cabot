import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsBlobStore, MemoryBlobStore, sha256Hex } from './blobs.js';

describe('blob store contract', () => {
  it('memory: staged blobs unreadable until verified publish; orphans listed', () => {
    const blobs = new MemoryBlobStore();
    const bytes = new TextEncoder().encode('hello cabot');
    blobs.writeStaged('a1', bytes);
    expect(() => blobs.read('a1')).toThrow(/not published/);
    expect(blobs.listOrphanStaged()).toEqual(['a1']);
    expect(() => blobs.publish('a1', 999, sha256Hex(bytes))).toThrow(/verification/);
    blobs.publish('a1', bytes.length, sha256Hex(bytes));
    expect(blobs.listOrphanStaged()).toEqual([]);
    expect(new TextDecoder().decode(blobs.read('a1'))).toBe('hello cabot');
  });

  it('fs: atomic stage->publish survives as OPFS-equivalent; orphans found after crash', () => {
    const root = mkdtempSync(join(tmpdir(), 'cabot-blobs-'));
    const blobs = new FsBlobStore(root);
    const bytes = new TextEncoder().encode('parquet-bytes');
    blobs.writeStaged('res1', bytes);
    // simulate crash before publish: staged remains, published absent
    expect(blobs.listOrphanStaged()).toContain('res1');
    expect(() => blobs.read('res1')).toThrow(/not published/);
    blobs.publish('res1', bytes.length, sha256Hex(bytes));
    expect(blobs.read('res1')).toEqual(bytes);
    // reopen from same root: published durable
    const reopened = new FsBlobStore(root);
    expect(reopened.read('res1')).toEqual(bytes);
    expect(reopened.listOrphanStaged()).toEqual([]);
  });

  it('rejects unsafe ids', () => {
    const blobs = new MemoryBlobStore();
    void blobs;
    const root = mkdtempSync(join(tmpdir(), 'cabot-blobs-'));
    const fs = new FsBlobStore(root);
    expect(() => fs.writeStaged('../escape', new Uint8Array())).toThrow(/unsafe/);
  });
});
