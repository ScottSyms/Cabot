import { describe, expect, it } from 'vitest';
import { DurableStore, saveStore, openDatabase } from '@cabot/storage';
import { createSupervisor } from './supervisor.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('supervisor', () => {
  it('rehydrates durable state and ensures runtime on demand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cabot-sup-'));
    const seed = new DurableStore();
    const project = seed.createProject('P');
    const agent = seed.createAgent({
      projectId: project.id, role: 'r', objective: 'o', status: 'RUNNING',
      modelConfig: { providerId: 'fake', modelId: 'f' }, skillIds: [],
      budget: {}, workspaceMounts: [], delegationDepth: 0,
    });
    const task = seed.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
    const dbSeed = openDatabase(join(dir, 'cabot.db'));
    saveStore(dbSeed, seed);
    dbSeed.close();

    let offscreenEnsured = 0;
    const notified: unknown[] = [];
    const sup = createSupervisor({
      openDb: () => openDatabase(join(dir, 'cabot.db')),
      ensureOffscreenDocument: async () => {
        offscreenEnsured += 1;
      },
      notifyClients: (m) => notified.push(m),
    });

    const res = (await sup.onMessage({ type: 'cabot.rehydrate' })) as { type: string; tasks: string[] };
    expect(res.type).toBe('rehydrated');
    expect(res.tasks).toContain(task.id);
    expect(offscreenEnsured).toBe(1);
    expect(notified.length).toBe(1);
    // Non-terminal task reconciled to INTERRUPTED on load.
    expect(sup.getCachedStore()?.tasks.get(task.id)?.status).toBe('INTERRUPTED');
    expect(await sup.onMessage({ type: 'cabot.ping' })).toEqual({ type: 'cabot.pong' });
  });
});
