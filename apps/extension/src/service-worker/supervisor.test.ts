import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore, MemorySnapshotBackend, loadStore, openDatabase, saveStore, serializeStore } from '@cabot/storage';
import { createSupervisor } from './supervisor.js';

describe('supervisor', () => {
  it('rehydrates durable state and ensures runtime on demand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cabot-sup-'));
    void dir;
    const seed = new DurableStore();
    const project = seed.createProject('P');
    const agent = seed.createAgent({
      projectId: project.id, role: 'r', objective: 'o', status: 'RUNNING',
      modelConfig: { providerId: 'fake', modelId: 'f' }, skillIds: [],
      budget: {}, workspaceMounts: [], delegationDepth: 0,
    });
    const task = seed.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
    const snapshots = new MemorySnapshotBackend();
    await snapshots.save(serializeStore(seed));

    let offscreenEnsured = 0;
    const notified: unknown[] = [];
    // Fake chrome.runtime messaging: answer readiness pings like offscreen.
    const g = globalThis as unknown as { chrome?: { runtime?: { sendMessage(m: unknown): Promise<unknown> } } };
    g.chrome = {
      runtime: {
        sendMessage: async (m: unknown) =>
          (m as { type?: string }).type === 'cabot.ping' ? { type: 'cabot.pong' } : { ok: true },
      },
    };
    try {
    const sup = createSupervisor({
      snapshots,
      ensureOffscreenDocument: async () => {
        offscreenEnsured += 1;
      },
      notifyClients: (m) => notified.push(m),
    });

    // Sanity: seeded snapshot round-trips through the file-backed SQLite path too.
    const dbSeed = openDatabase(join(dir, 'cabot.db'));
    saveStore(dbSeed, seed);
    dbSeed.close();
    const dbLoad = openDatabase(join(dir, 'cabot.db'));
    const viaSqlite = loadStore(dbLoad);
    dbLoad.close();
    expect(viaSqlite.tasks.get(task.id)?.title).toBe('T');

    const res = (await sup.onMessage({ type: 'cabot.rehydrate' })) as { type: string };
    expect(res.type).toBe('rehydrated');
    expect(offscreenEnsured).toBe(1);
    expect(notified.length).toBe(1);

    const rehydrated = await sup.rehydrate();
    // Non-terminal task reconciled to INTERRUPTED on load.
    expect(rehydrated.tasks.get(task.id)?.status).toBe('INTERRUPTED');
    expect(await sup.onMessage({ type: 'cabot.ping' })).toEqual({ type: 'cabot.pong' });
    // Unknown runtime messages forward to the coordinator stub.
    expect(await sup.onMessage({ type: 'cabot.list-tasks' })).toEqual({ ok: true });
    } finally {
      delete g.chrome;
    }
  });

  it('reports a clear error when the coordinator never answers', async () => {
    const snapshots = new MemorySnapshotBackend();
    const g = globalThis as unknown as { chrome?: { runtime?: { sendMessage(m: unknown): Promise<unknown> } } };
    g.chrome = { runtime: { sendMessage: async () => null } };
    try {
      const sup = createSupervisor({
        snapshots,
        ensureOffscreenDocument: async () => {},
        notifyClients: () => {},
      });
      await expect(sup.onMessage({ type: 'cabot.list-tasks' })).rejects.toThrow(/empty response/);
    } finally {
      delete g.chrome;
    }
  });
});
