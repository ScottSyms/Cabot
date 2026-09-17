// Browser-native persistence (preview).
// Node path uses SQLite files; the extension cannot. Here the durable
// snapshot (all store maps as JSON) commits atomically through
// chrome.storage.local, and artifact bytes live in OPFS. Same contract:
// crash mid-write keeps the prior snapshot; blobs verify before metadata
// commits. SQLite-WASM migration keeps this interface.
import { DurableStore } from './store.js';

export interface SnapshotBackend {
  load(): Promise<string | null>;
  save(snapshot: string): Promise<void>;
  /** Best-effort side copy (corrupt-snapshot quarantine). Absence is tolerated. */
  saveBackup?(name: string, snapshot: string): Promise<void>;
}

export function serializeStore(store: DurableStore): string {
  return JSON.stringify({
    v: 1,
    projects: [...store.projects.values()],
    tasks: [...store.tasks.values()],
    agents: [...store.agents.values()],
    operations: [...store.operations.values()],
    events: store.events,
    checkpoints: [...store.checkpoints.entries()],
    messages: [...store.messages.values()],
    delivered: [...store.delivered.entries()].map(([k, set]) => [k, [...set]]),
    artifacts: [...store.artifacts.values()],
    sources: [...store.sources.values()],
    grants: [...store.grants.values()],
    approvals: [...store.approvals.values()],
    externals: [...store.externalHandles.values()],
    queue: [...store.queue.values()],
  });
}

export function restoreStore(json: string): DurableStore {
  const d = JSON.parse(json) as Record<string, never[]>;
  const store = new DurableStore();
  const rows = <T>(k: string): T[] => ((d[k] ?? []) as T[]);
  const put = <T extends { id: string }>(map: Map<string, T>, k: string): void => {
    for (const r of rows<T>(k)) map.set(r.id, r);
  };
  put(store.projects, 'projects');
  put(store.tasks, 'tasks');
  put(store.agents, 'agents');
  put(store.operations, 'operations');
  store.events = rows('events');
  store.checkpoints = new Map(d.checkpoints as [string, never][]) as DurableStore['checkpoints'];
  put(store.messages, 'messages');
  store.delivered = new Map(
    (d.delivered as [string, string[]][]).map(([k, v]) => [k, new Set(v)]),
  ) as DurableStore['delivered'];
  put(store.artifacts, 'artifacts');
  put(store.sources, 'sources');
  put(store.grants, 'grants');
  put(store.approvals, 'approvals');
  store.externalHandles = new Map(
    (d.externals as { taskId: string; operationId: string }[]).map((h) => [`${h.taskId}:${h.operationId}`, h]),
  ) as DurableStore['externalHandles'];
  store.queue = new Map((d.queue as { agentId: string }[]).map((q) => [q.agentId, q])) as DurableStore['queue'];
  return store;
}

export class MemorySnapshotBackend implements SnapshotBackend {
  private snapshot: string | null = null;
  backups = new Map<string, string>();
  failures = 0;

  async load(): Promise<string | null> {
    return this.snapshot;
  }

  async save(snapshot: string): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('snapshot backend unavailable');
    }
    this.snapshot = snapshot;
  }

  async saveBackup(name: string, snapshot: string): Promise<void> {
    this.backups.set(name, snapshot);
  }
}

export const STORE_SNAPSHOT_KEY = 'cabot.store.v1';

interface ChromeStorageArea {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function chromeLocalStorage(): ChromeStorageArea {
  const g = globalThis as unknown as { chrome?: { storage?: { local?: ChromeStorageArea } } };
  if (!g.chrome?.storage?.local) throw new Error('chrome.storage.local unavailable in this context');
  return g.chrome.storage.local;
}

export class ChromeStorageBackend implements SnapshotBackend {
  constructor(private key = STORE_SNAPSHOT_KEY) {}

  async load(): Promise<string | null> {
    const got = await chromeLocalStorage().get(this.key);
    const v = got[this.key];
    return typeof v === 'string' ? v : null;
  }

  async save(snapshot: string): Promise<void> {
    await chromeLocalStorage().set({ [this.key]: snapshot });
  }

  async saveBackup(name: string, snapshot: string): Promise<void> {
    await chromeLocalStorage().set({ [`${this.key}.backup.${name}`]: snapshot });
  }
}

// OPFS artifact bytes (async File System API). Staged blobs are invisible
// until verified; publish is a verified move. Browser-only; typechecked
// everywhere, exercised in the extension.
export class OpfsBlobStore {
  private rootPromise: Promise<FileSystemDirectoryHandle> | undefined;

  private root(): Promise<FileSystemDirectoryHandle> {
    if (!this.rootPromise) {
      const nav = navigator as Navigator & { storage?: { getDirectory(): Promise<FileSystemDirectoryHandle> } };
      if (!nav.storage?.getDirectory) throw new Error('OPFS unavailable in this context');
      this.rootPromise = nav.storage.getDirectory().then((root) => root);
    }
    return this.rootPromise;
  }

  private async dir(name: 'staged' | 'published'): Promise<FileSystemDirectoryHandle> {
    const root = await this.root();
    return root.getDirectoryHandle(name, { create: true });
  }

  async writeStaged(id: string, bytes: Uint8Array): Promise<void> {
    const staged = await this.dir('staged');
    const handle = await staged.getFileHandle(id, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes as BufferSource);
    } finally {
      await writable.close();
    }
  }

  async publish(id: string): Promise<void> {
    const staged = await this.dir('staged');
    const published = await this.dir('published');
    const src = await staged.getFileHandle(id);
    const file = await src.getFile();
    const dst = await published.getFileHandle(id, { create: true });
    const writable = await dst.createWritable();
    try {
      await writable.write(await file.arrayBuffer());
    } finally {
      await writable.close();
    }
    await staged.removeEntry(id);
  }

  async read(id: string): Promise<Uint8Array> {
    const published = await this.dir('published');
    const handle = await published.getFileHandle(id);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async listOrphanStaged(): Promise<string[]> {
    const staged = await this.dir('staged');
    const names: string[] = [];
    const values = (staged as unknown as {
      values(): AsyncIterable<{ name: string }>;
    }).values();
    for await (const entry of values) names.push(entry.name);
    return names;
  }
}

// ---- OPFS file snapshot backend ----
// Stores the snapshot as a single OPFS file. A torn write is possible on
// crash mid-save; the coordinator's quarantine logic turns that into a
// fresh boot with a backup instead of a bricked runtime.

export interface OpfsFileHandle {
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

export interface OpfsDirHandle {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<OpfsFileHandle>;
}

export interface OpfsRootHandle {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<OpfsDirHandle>;
}

export type OpfsRootProvider = () => Promise<OpfsRootHandle>;

export function navigatorOpfsRoot(): OpfsRootProvider {
  return async () => {
    const nav = navigator as unknown as {
      storage?: { getDirectory(): Promise<OpfsRootHandle> };
    };
    if (!nav.storage?.getDirectory) throw new Error('OPFS unavailable in this context');
    return nav.storage.getDirectory();
  };
}

export class OpfsSnapshotBackend implements SnapshotBackend {
  constructor(
    private getRoot: OpfsRootProvider,
    private dirName = 'cabot',
    private fileName = 'store.json',
  ) {}

  private async dir(): Promise<OpfsDirHandle> {
    const root = await this.getRoot();
    return root.getDirectoryHandle(this.dirName, { create: true });
  }

  async load(): Promise<string | null> {
    try {
      const handle = await (await this.dir()).getFileHandle(this.fileName);
      return await (await handle.getFile()).text();
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFoundError') return null;
      throw e;
    }
  }

  async save(snapshot: string): Promise<void> {
    const handle = await (await this.dir()).getFileHandle(this.fileName, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(snapshot);
    } finally {
      await writable.close();
    }
  }

  async saveBackup(name: string, snapshot: string): Promise<void> {
    const handle = await (await this.dir()).getFileHandle(`${this.fileName}.backup.${name}`, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(snapshot);
    } finally {
      await writable.close();
    }
  }
}

// ---- Resilient backend: primary with permanent fallback ----
// First primary failure (e.g. chrome.storage.local missing from offscreen)
// switches all future traffic to the fallback and records the switch for
// UI visibility. Reads try the active backend, then the other one.

export class ResilientSnapshotBackend implements SnapshotBackend {
  private active: SnapshotBackend;
  switches: string[] = [];

  constructor(
    private primary: SnapshotBackend,
    private fallback: SnapshotBackend,
  ) {
    this.active = primary;
  }

  activeName(): string {
    return this.active.constructor.name;
  }

  private note(from: SnapshotBackend, to: SnapshotBackend, e: unknown): void {
    const msg = `${this.describe(from)} failed (${e instanceof Error ? e.message : String(e)}); using ${this.describe(to)}`;
    this.switches.push(msg);
  }

  private describe(b: SnapshotBackend): string {
    return (b as { constructor: { name: string } }).constructor.name;
  }

  async load(): Promise<string | null> {
    try {
      return await this.active.load();
    } catch (e) {
      const other = this.active === this.primary ? this.fallback : this.primary;
      try {
        const v = await other.load();
        this.note(this.active, other, e);
        this.active = other;
        return v;
      } catch {
        throw e;
      }
    }
  }

  async save(snapshot: string): Promise<void> {
    try {
      await this.active.save(snapshot);
    } catch (e) {
      const other = this.active === this.primary ? this.fallback : this.primary;
      this.note(this.active, other, e);
      this.active = other;
      await other.save(snapshot);
    }
  }

  async saveBackup(name: string, snapshot: string): Promise<void> {
    try {
      const target = this.active as SnapshotBackend & { saveBackup?: (n: string, s: string) => Promise<void> };
      if (target.saveBackup) await target.saveBackup(name, snapshot);
    } catch {
      // Quarantine is best-effort; booting matters more.
    }
  }
}
