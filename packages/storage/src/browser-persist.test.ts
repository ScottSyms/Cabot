import { describe, expect, it } from 'vitest';
import {
  MemorySnapshotBackend,
  restoreStore,
  serializeStore,
} from './browser-persist.js';
import { DurableStore } from './store.js';

describe('snapshot persistence', () => {
  it('round-trips full store state including sources and mailbox cursors', async () => {
    const s = new DurableStore();
    const project = s.createProject('P');
    const agent = s.createAgent({
      projectId: project.id, role: 'r', objective: 'o', status: 'RUNNING',
      modelConfig: { providerId: 'x', modelId: 'y' }, skillIds: ['a'],
      budget: { maxModelCalls: 3 }, workspaceMounts: ['w'], delegationDepth: 0,
    });
    const agentB = s.createAgent({
      projectId: project.id, role: 'b', objective: 'o', status: 'RUNNING',
      modelConfig: { providerId: 'x', modelId: 'y' }, skillIds: [],
      budget: {}, workspaceMounts: [], delegationDepth: 1, parentAgentId: agent.id,
    });
    const task = s.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
    s.transitionTask(task.id, 'READY', 'r');
    s.captureSource({ projectId: project.id, taskId: task.id, uri: 'https://e.com', origin: 'https://e.com', sha256: 'ab12' });
    s.sendMessage({ from: agent.id, to: agentB.id, type: 'request', payload: { q: 1 }, id: 'mm1' });
    s.ack(agentB.id, 'mm1');
    const op = s.prepareOperation({ taskId: task.id, agentId: agent.id, toolId: 't', argsHash: 'h', idempotencyKey: 'k' });
    s.markDispatched(op.id);

    const backend = new MemorySnapshotBackend();
    await backend.save(serializeStore(s));
    const loaded = restoreStore((await backend.load())!);

    expect(loaded.projects.get(project.id)?.name).toBe('P');
    expect(loaded.agents.get(agentB.id)?.parentAgentId).toBe(agent.id);
    expect(loaded.tasks.get(task.id)?.status).toBe('READY');
    expect(loaded.tasks.get(task.id)?.checkpointRevision).toBe(s.tasks.get(task.id)?.checkpointRevision);
    expect([...loaded.sources.values()]).toHaveLength(1);
    expect(loaded.inbox(agentB.id)).toHaveLength(0); // ack survived
    expect(loaded.operations.get(op.id)?.status).toBe('DISPATCHED');

    // Recovery still works after restore: DISPATCHED -> UNCERTAIN.
    expect(loaded.reconcileAfterRestart().map((o) => o.id)).toContain(op.id);
  });

  it('starts empty when no snapshot exists and surfaces backend failures', async () => {
    const backend = new MemorySnapshotBackend();
    expect(await backend.load()).toBeNull();
    backend.failures = 1;
    await expect(backend.save('x')).rejects.toThrow(/unavailable/);
    await backend.save('x');
    expect(await backend.load()).toBe('x');
  });
});

import { OpfsSnapshotBackend, ResilientSnapshotBackend, type OpfsDirHandle } from './browser-persist.js';

class FakeFile {
  text = '';
  exists = false;
  async getFile(): Promise<{ text(): Promise<string> }> {
    if (!this.exists) {
      const e = new Error('not found') as Error & { name: string };
      e.name = 'NotFoundError';
      throw e;
    }
    return { text: async () => this.text };
  }
  async createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> {
    return {
      write: async (d: string) => {
        this.text = d;
      },
      close: async () => {
        this.exists = true;
      },
    };
  }
}

class FakeDir implements OpfsDirHandle {
  files = new Map<string, FakeFile>();
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    let f = this.files.get(name);
    if (!f) {
      if (!opts?.create) {
        const e = new Error('not found') as Error & { name: string };
        e.name = 'NotFoundError';
        throw e;
      }
      f = new FakeFile();
      this.files.set(name, f);
    }
    return f;
  }
}

function fakeRoot() {
  const dirs = new Map<string, FakeDir>();
  return {
    dirs,
    provider: async () => ({
      getDirectoryHandle: async (name: string) => {
        let d = dirs.get(name);
        if (!d) {
          d = new FakeDir();
          dirs.set(name, d);
        }
        return d;
      },
    }),
  };
}

describe('opfs + resilient snapshots', () => {
  it('persists snapshots to an OPFS file and quarantines backups', async () => {
    const root = fakeRoot();
    const backend = new OpfsSnapshotBackend(root.provider, 'cabot', 'store.json');
    expect(await backend.load()).toBeNull();
    await backend.save('{"v":1}');
    expect(await backend.load()).toBe('{"v":1}');
    await backend.saveBackup('corrupt-x', 'junk');
    expect(root.dirs.get('cabot')?.files.has('store.json.backup.corrupt-x')).toBe(true);
  });

  it('falls back permanently when the primary is unavailable', async () => {
    const root = fakeRoot();
    const fallback = new OpfsSnapshotBackend(root.provider);
    const resilient = new ResilientSnapshotBackend(
      { load: async () => { throw new Error('chrome.storage.local unavailable in this context'); }, save: async () => { throw new Error('nope'); }, saveBackup: async () => {} },
      fallback,
    );
    await resilient.save('snap-1');
    expect(resilient.activeName()).toBe('OpfsSnapshotBackend');
    expect(resilient.switches.length).toBe(1);
    expect(await resilient.load()).toBe('snap-1');
    // Subsequent saves go straight to the fallback.
    await resilient.save('snap-2');
    expect(resilient.switches.length).toBe(1);
    expect(await fallback.load()).toBe('snap-2');
  });
});
