import { describe, expect, it } from 'vitest';
import { MemorySnapshotBackend, serializeStore } from '@cabot/storage/browser-chrome';
import { DurableStore } from '@cabot/storage/browser-chrome';
import { createCoordinator, type SettingsStore } from './coordinator.js';

function settings(): SettingsStore {
  let current = { endpoint: 'http://localhost:11434/v1', modelId: 'test-model' };
  return {
    load: async () => current,
    save: async (s) => {
      current = s;
    },
  };
}

describe('offscreen coordinator', () => {
  it('boots empty, persists across reboot, and rejects unconfigured runs', async () => {
    const snapshots = new MemorySnapshotBackend();
    const coord = createCoordinator({ snapshots, settings: settings() });
    await coord.boot();
    expect(coord.ready().store.tasks.size).toBe(0);

    // Mutate + persist, then reboot from the snapshot.
    const { store } = coord.ready();
    const project = store.createProject('P');
    await coord.persist();
    await coord.reboot();
    expect(coord.ready().store.projects.get(project.id)?.name).toBe('P');
  });

  it('runSummary requires provider settings', async () => {
    const snapshots = new MemorySnapshotBackend();
    const empty: SettingsStore = { load: async () => null, save: async () => {} };
    const coord = createCoordinator({ snapshots, settings: empty });
    await coord.boot();
    await expect(coord.runSummary('summarize')).rejects.toThrow(/provider not configured/);
  });

  it('serialized snapshot restores agents, tasks, and approvals', async () => {
    const s = new DurableStore();
    const project = s.createProject('P');
    const agent = s.createAgent({
      projectId: project.id, role: 'r', objective: 'o', status: 'RUNNING',
      modelConfig: { providerId: 'x', modelId: 'y' }, skillIds: [],
      budget: {}, workspaceMounts: [], delegationDepth: 0,
    });
    const snapshots = new MemorySnapshotBackend();
    await snapshots.save(serializeStore(s));

    const coord = createCoordinator({ snapshots, settings: settings() });
    await coord.boot();
    expect(coord.ready().store.agents.get(agent.id)?.role).toBe('r');

    const task = coord.ready().store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
    void task;
    const listed = (await coord.handleMessage({ type: 'cabot.list-tasks' })) as { tasks: unknown[] };
    expect(listed.tasks).toHaveLength(1);

    const agents = (await coord.handleMessage({ type: 'cabot.list-agents' })) as { agents: { id: string; role: string }[] };
    expect(agents.agents.map((a) => a.id)).toContain(agent.id);
  });
});
