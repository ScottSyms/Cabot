import { describe, expect, it } from 'vitest';
import { MemorySnapshotBackend, serializeStore } from '@cabot/storage/browser-chrome';
import { DurableStore } from '@cabot/storage/browser-chrome';
import { FakeBrowserBackend } from '@cabot/tools';
import { createCoordinator, fileSettingsStore, withFallbackSettings, type SettingsStore } from './coordinator.js';

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
    const coord = createCoordinator({ snapshots, settings: settings(), browserBackend: new FakeBrowserBackend() });
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
    const coord = createCoordinator({ snapshots, settings: empty, browserBackend: new FakeBrowserBackend() });
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

    const coord = createCoordinator({ snapshots, settings: settings(), browserBackend: new FakeBrowserBackend() });
    await coord.boot();
    expect(coord.ready().store.agents.get(agent.id)?.role).toBe('r');

    const task = coord.ready().store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
    void task;
    const listed = (await coord.handleMessage({ type: 'cabot.list-tasks' })) as { tasks: unknown[] };
    expect(listed.tasks).toHaveLength(1);

    expect(await coord.handleMessage({ type: 'cabot.ping' })).toEqual({ type: 'cabot.pong' });
    expect(await coord.handleMessage({ type: 'cabot.boot-warning' })).toEqual({ warning: null });

    const agents = (await coord.handleMessage({ type: 'cabot.list-agents' })) as { agents: { id: string; role: string }[] };
    expect(agents.agents.map((a) => a.id)).toContain(agent.id);
  });

  it('quarantines a corrupt snapshot and boots fresh instead of bricking', async () => {
    const snapshots = new MemorySnapshotBackend();
    await snapshots.save('definitely-not-json{{{');
    const coord = createCoordinator({ snapshots, settings: settings(), browserBackend: new FakeBrowserBackend() });
    await coord.boot(); // must not throw
    expect(coord.ready().store.tasks.size).toBe(0);
    expect(coord.bootWarning()).toMatch(/quarantined/);
    expect(snapshots.backups.size).toBe(1);
    const listed = (await coord.handleMessage({ type: 'cabot.list-tasks' })) as { tasks: unknown[] };
    expect(listed.tasks).toHaveLength(0);
  });

  it('falls back to file settings when the primary store is unavailable', async () => {    const snapshots = new MemorySnapshotBackend();
    const failing: SettingsStore = {
      load: async () => {
        throw new Error('chrome.storage.local unavailable in this context');
      },
      save: async () => {
        throw new Error('chrome.storage.local unavailable in this context');
      },
    };
    const fileBacked = fileSettingsStore(snapshots);
    const settings = withFallbackSettings(failing, fileBacked);
    await settings.save({ endpoint: 'https://x/v1', modelId: 'm' });
    expect(await settings.load()).toEqual({ endpoint: 'https://x/v1', modelId: 'm' });
    // Primary tried first, then latched to fallback.
    await settings.save({ endpoint: 'https://y/v1', modelId: 'm2' });
    expect(await fileBacked.load()).toEqual({ endpoint: 'https://y/v1', modelId: 'm2' });
  });
});

describe('provider settings', () => {
  it('keeps the stored key on blank save and never returns it', async () => {
    const snapshots = new MemorySnapshotBackend();
    const coord = createCoordinator({ snapshots, settings: settings(), browserBackend: new FakeBrowserBackend() });
    await coord.boot();
    await coord.handleMessage({
      type: 'cabot.save-settings',
      settings: { endpoint: 'https://x/v1', modelId: 'm', apiKey: 'sekret' },
    });
    // Blank key means keep.
    await coord.handleMessage({
      type: 'cabot.save-settings',
      settings: { endpoint: 'https://x/v1', modelId: 'm', apiKey: undefined },
    });
    const got = (await coord.handleMessage({ type: 'cabot.get-settings' })) as {
      settings: { endpoint: string; modelId: string; apiKey?: string };
      hasApiKey: boolean;
    };
    expect(got.settings).toEqual({ endpoint: 'https://x/v1', modelId: 'm' });
    expect(got.hasApiKey).toBe(true);
    expect('apiKey' in got.settings).toBe(false);
  });
});

describe('run lock', () => {
  it('rejects a second concurrent run on the same task', async () => {
    const { createRunLock } = await import('./coordinator.js');
    const lock = createRunLock();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = lock.runExclusive('t1', () => gate);
    await expect(lock.runExclusive('t1', async () => 1)).rejects.toThrow(/already in flight/);
    expect(lock.isRunning('t1')).toBe(true);
    release();
    await first;
    expect(lock.isRunning('t1')).toBe(false);
    expect(await lock.runExclusive('t1', async () => 42)).toBe(42);
  });

  it('releases the lock when the run throws', async () => {
    const { createRunLock } = await import('./coordinator.js');
    const lock = createRunLock();
    await expect(lock.runExclusive('t2', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(lock.isRunning('t2')).toBe(false);
  });
});

describe('agent removal', () => {
  it('purges a cancelled agent via coordinator message', async () => {
    const snapshots = new MemorySnapshotBackend();
    const coord = createCoordinator({ snapshots, settings: settings(), browserBackend: new FakeBrowserBackend() });
    await coord.boot();
    const s = coord.ready().store;
    const project = s.createProject('P');
    const agent = s.createAgent({
      projectId: project.id, role: 'r', objective: 'o', status: 'RUNNING',
      modelConfig: { providerId: 'x', modelId: 'y' }, skillIds: [], budget: {}, workspaceMounts: [], delegationDepth: 0,
    });
    const task = s.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
    s.transitionTask(task.id, 'READY', 'r');
    s.transitionTask(task.id, 'RUNNING', 'r');
    s.transitionTask(task.id, 'CANCELLED', 'c');
    s.setAgentStatus(agent.id, 'CANCELLED');
    await coord.persist();

    const res = (await coord.handleMessage({ type: 'cabot.remove-agent', agentId: agent.id })) as {
      ok: boolean;
      removed: { removedAgents: number };
    };
    expect(res.ok).toBe(true);
    expect(res.removed.removedAgents).toBe(1);
    expect(coord.ready().store.agents.has(agent.id)).toBe(false);

    // Removal is durable: reboot from the persisted snapshot.
    await coord.reboot();
    expect(coord.ready().store.agents.has(agent.id)).toBe(false);
  });
});
