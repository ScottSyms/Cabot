import { describe, expect, it } from 'vitest';
import { DurableStore } from './store.js';

function setup() {
  const store = new DurableStore();
  const project = store.createProject('AIS Warehouse');
  const agent = store.createAgent({
    projectId: project.id,
    role: 'researcher',
    objective: 'research',
    status: 'RUNNING',
    modelConfig: { providerId: 'fake', modelId: 'fake-1' },
    skillIds: [],
    budget: { maxModelCalls: 5, maxDelegations: 2 },
    workspaceMounts: [],
    delegationDepth: 0,
  });
  const task = store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
  return { store, project, agent, task };
}

describe('task state machine', () => {
  it('rejects illegal transitions', () => {
    const { store, task } = setup();
    expect(() => store.transitionTask(task.id, 'COMPLETE', 'skip')).toThrow(/illegal/);
  });

  it('commits checkpoint on legal transition', () => {
    const { store, task } = setup();
    store.transitionTask(task.id, 'READY', 'ready');
    store.transitionTask(task.id, 'RUNNING', 'run');
    expect(store.tasks.get(task.id)?.checkpointRevision).toBe(2);
  });
});

describe('operations: persist intent before dispatch', () => {
  it('dedups prepare by idempotency key and blocks replay of UNCERTAIN', () => {
    const { store, task, agent } = setup();
    const a = store.prepareOperation({ taskId: task.id, agentId: agent.id, toolId: 'browser.navigate', argsHash: 'h1', idempotencyKey: 'k1' });
    const b = store.prepareOperation({ taskId: task.id, agentId: agent.id, toolId: 'browser.navigate', argsHash: 'h1', idempotencyKey: 'k1' });
    expect(a.id).toBe(b.id);
    store.markDispatched(a.id);
    // simulate crash before settle
    const uncertain = store.reconcileAfterRestart();
    expect(uncertain.map((o) => o.id)).toContain(a.id);
    expect(store.operations.get(a.id)?.status).toBe('UNCERTAIN');
    // cannot settle from UNCERTAIN without explicit recovery path
    expect(() => store.settleOperation(a.id, 'SUCCEEDED')).toThrow();
  });
});

describe('artifact publication', () => {
  it('requires staged verification before publish', () => {
    const { store, task, agent, project } = setup();
    const art = store.stageArtifact({ projectId: project.id, taskId: task.id, agentId: agent.id, path: 'outputs/report.md', bytes: 10, sha256: 'abc' });
    expect(() => store.publishArtifact(art.id, 11, 'abc')).toThrow(/verification/);
    const pub = store.publishArtifact(art.id, 10, 'abc');
    expect(pub.staged).toBe(false);
  });
});

describe('mailbox dedup + budgets + queue fencing', () => {
  it('dedups redelivered messages and enforces budgets transactionally', () => {
    const { store, agent, project } = setup();
    const agentB = store.createAgent({
      projectId: project.id, role: 'writer', objective: 'w', status: 'RUNNING',
      modelConfig: { providerId: 'fake', modelId: 'fake-1' }, skillIds: [], budget: {}, workspaceMounts: [], delegationDepth: 1, parentAgentId: agent.id,
    });
    const m1 = store.sendMessage({ from: agent.id, to: agentB.id, type: 'artifact', payload: { ref: 'project://shared/r.parquet' }, id: 'm1' });
    const m1dup = store.sendMessage({ from: agent.id, to: agentB.id, type: 'artifact', payload: { ref: 'project://shared/r.parquet' }, id: 'm1' });
    expect(m1.id).toBe(m1dup.id);
    expect(store.inbox(agentB.id)).toHaveLength(1);
    store.ack(agentB.id, 'm1');
    expect(store.inbox(agentB.id)).toHaveLength(0);

    store.reserve({ taskId: 't' as never, agentId: agent.id, kind: 'delegations', amount: 2 });
    expect(() => store.reserve({ taskId: 't' as never, agentId: agent.id, kind: 'delegations', amount: 1 })).toThrow(/budget/);
  });

  it('queue lease fencing rejects stale workers', () => {
    const { store, agent } = setup();
    const q1 = store.acquireRunnable(1);
    expect(q1?.agentId).toBe(agent.id);
    const token1 = q1!.fenceToken;
    store.release(agent.id, q1!.leaseId!);
    const q2 = store.acquireRunnable(1);
    expect(q2!.fenceToken).toBeGreaterThan(token1);
  });
});
