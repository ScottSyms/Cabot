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
