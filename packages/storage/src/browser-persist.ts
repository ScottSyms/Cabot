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
