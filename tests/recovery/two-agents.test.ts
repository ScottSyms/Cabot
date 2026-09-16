import { describe, expect, it } from 'vitest';
import type { AgentMessage, Operation } from '@cabot/contracts';
import { DurableStore } from '@cabot/storage';
import { CapabilityBroker } from '@cabot/policy';
// Phase-1 exit gate (in-memory model of the durable invariant):

describe('two-agent crash recovery', () => {
  it('preserves hierarchy, mailbox, artifacts; blocks uncertain replay', () => {
    const store = new DurableStore();
    const broker = new CapabilityBroker(store);
    broker.registerTool({
      id: 'workspace.write', source: 'builtin', name: 'write', description: 'write file',
      inputSchema: { type: 'object' }, capabilityClass: 'reversible', provenance: 'builtin',
    });
    broker.registerTool({
      id: 'external.publish', source: 'builtin', name: 'publish', description: 'publish externally',
      inputSchema: { type: 'object' }, capabilityClass: 'consequential', provenance: 'builtin',
    });

    const project = store.createProject('CANChat');
    const coordinator = store.createAgent({
      projectId: project.id, role: 'coordinator', objective: 'coordinate', status: 'RUNNING',
      modelConfig: { providerId: 'fake', modelId: 'f' }, skillIds: [],
      budget: { maxDelegations: 5 }, workspaceMounts: ['project://shared/'], delegationDepth: 0,
    });
    // brokered spawn: child gets only explicitly delegated skills/budget
    expect(broker.authorizeSpawn(coordinator.id, { skills: ['web-research'], budget: {} }).allowed).toBe(true);
    const worker = store.createAgent({
      projectId: project.id, parentAgentId: coordinator.id, role: 'analysis', objective: 'analyze',
      status: 'RUNNING', modelConfig: { providerId: 'fake', modelId: 'f' },
      skillIds: ['web-research'], budget: {}, workspaceMounts: [], delegationDepth: 1,
    });
    const unrelated = store.createAgent({
      projectId: project.id, role: 'monitor', objective: 'monitor', status: 'RUNNING',
      modelConfig: { providerId: 'fake', modelId: 'f' }, skillIds: [], budget: {}, workspaceMounts: [], delegationDepth: 0,
    });

    const task = store.createTask({ projectId: project.id, ownerAgentId: coordinator.id, title: 'Benchmark', objective: 'bench' });
    store.transitionTask(task.id, 'READY', 'ready');
    store.transitionTask(task.id, 'RUNNING', 'run');

    broker.grant({ principal: { kind: 'core-agent', agentId: worker.id }, toolId: 'workspace.write', scope: 'task', taskId: task.id });

    // worker writes + publishes artifact, sends reference to coordinator
    const staged = store.stageArtifact({ projectId: project.id, taskId: task.id, agentId: worker.id, path: 'shared/results.parquet', bytes: 4, sha256: 'deadbeef' });
    store.publishArtifact(staged.id, 4, 'deadbeef');
    store.sendMessage({ from: worker.id, to: coordinator.id, type: 'artifact', payload: { ref: 'project://shared/results.parquet' }, id: 'msg-art-1' });

    // consequential op dispatched but result lost in crash
    const op = store.prepareOperation({ taskId: task.id, agentId: coordinator.id, toolId: 'external.publish', argsHash: 'h', idempotencyKey: 'pub-1' });
    store.markDispatched(op.id);

    // ---- crash: all JS contexts gone; durable state reconciled ----
    const uncertain = store.reconcileAfterRestart();
    expect(uncertain.map((o: Operation) => o.id)).toContain(op.id);

    // non-terminal task marked INTERRUPTED, agents intact, unrelated unaffected
    expect(store.tasks.get(task.id)?.status).toBe('INTERRUPTED');
    expect(store.agents.get(worker.id)?.status).toBe('RUNNING');
    expect(store.agents.get(unrelated.id)?.status).toBe('RUNNING');

    // mailbox + artifact reference survive
    expect(store.inbox(coordinator.id).map((m: AgentMessage) => m.id)).toContain('msg-art-1');
    expect(store.artifacts.get(staged.id)?.staged).toBe(false);

    // child still has no extra capability
    const d = broker.evaluate({
      toolId: 'workspace.write', args: {}, argsHash: 'h',
      principal: { kind: 'core-agent', agentId: unrelated.id },
      taskId: task.id, agentId: unrelated.id,
    });
    expect(d.allowed).toBe(false);

    // uncertain consequential op cannot be settled/replayed silently
    expect(() => store.settleOperation(op.id, 'SUCCEEDED')).toThrow();
  });
});
