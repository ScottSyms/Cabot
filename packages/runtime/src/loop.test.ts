// Loop recovery: a crash between turns resumes from the last checkpoint;
// an op whose result was lost is UNCERTAIN and never silently re-dispatched
// under the same idempotency key.
import { describe, expect, it } from 'vitest';
import { DurableStore } from '@cabot/storage';
import { CapabilityBroker } from '@cabot/policy';
import { FakeModelProvider } from '@cabot/providers';
import { CabotRuntimeService } from './api.js';
import { runAgentTurn, type ToolExecution } from './loop.js';
import { type ToolExecutor } from './loop.js';

function setup() {
  const store = new DurableStore();
  const broker = new CapabilityBroker(store);
  broker.registerTool({
    id: 'notes.write', source: 'builtin', name: 'write', description: 'write note',
    inputSchema: { type: 'object' }, capabilityClass: 'reversible', provenance: 'builtin',
  });
  const project = store.createProject('P');
  const agent = store.createAgent({
    projectId: project.id, role: 'r', objective: 'o', status: 'RUNNING',
    modelConfig: { providerId: 'fake', modelId: 'fake-1' }, skillIds: [],
    budget: { maxModelCalls: 50, maxToolCalls: 50 }, workspaceMounts: [], delegationDepth: 0,
  });
  const task = store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'write two notes' });
  store.transitionTask(task.id, 'READY', 'ready');
  store.transitionTask(task.id, 'RUNNING', 'run');
  broker.grant({ principal: { kind: 'core-agent', agentId: agent.id }, toolId: 'notes.write', scope: 'task', taskId: task.id });
  return { store, broker, project, agent, task };
}

describe('checkpointed agent loop', () => {
  it('completes a scripted multi-turn task with a checkpoint per turn', async () => {
    const { store, broker, agent, task } = setup();
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'notes.write', args: { n: 1 }, argsHash: 'h1', idempotencyKey: 'k1' },
      { kind: 'tool', toolId: 'notes.write', args: { n: 2 }, argsHash: 'h2', idempotencyKey: 'k2' },
      { kind: 'done', summary: 'both notes written' },
    ]);
    const calls: string[] = [];
    const executor: ToolExecutor = {
      execute: async (toolId, args): Promise<ToolExecution> => {
        calls.push(toolId);
        return { ok: true, resultHash: `r:${JSON.stringify(args)}` };
      },
    };
    const svc = new CabotRuntimeService(store, broker, model, executor);
    const outcome = await svc.runTask(task.id, agent.id);
    expect(outcome.status).toBe('complete');
    expect(calls).toEqual(['notes.write', 'notes.write']);
    expect(store.tasks.get(task.id)?.status).toBe('COMPLETE');
    // checkpoint per turn: 2 transitions + model/turn commits
    expect(store.tasks.get(task.id)?.checkpointRevision).toBeGreaterThanOrEqual(5);
  });

  it('crash during a turn leaves UNCERTAIN op; resume never re-dispatches it', async () => {
    const { store, broker, agent, task } = setup();
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'notes.write', args: { n: 1 }, argsHash: 'h1', idempotencyKey: 'k1' },
      { kind: 'tool', toolId: 'notes.write', args: { n: 2 }, argsHash: 'h2', idempotencyKey: 'k2' },
    ]);
    let executions = 0;
    const executor: ToolExecutor = {
      execute: async (): Promise<ToolExecution> => {
        executions += 1;
        if (executions === 2) throw new Error('worker destroyed mid-execution');
        return { ok: true, resultHash: 'r1' };
      },
    };
    // Turn 1 settles; turn 2 throws inside executor -> op k2 left DISPATCHED.
    await runAgentTurn(store, broker, model, executor, task.id, agent.id);
    await runAgentTurn(store, broker, model, executor, task.id, agent.id);
    expect(executions).toBe(2);

    // ---- crash ----
    const uncertain = store.reconcileAfterRestart();
    expect(uncertain.map((o) => o.idempotencyKey)).toContain('k2');
    expect(store.tasks.get(task.id)?.status).toBe('INTERRUPTED');

    // ---- resume: model retries the same logical step with the same key ----
    store.transitionTask(task.id, 'READY', 'resumed');
    store.transitionTask(task.id, 'RUNNING', 'resumed');
    model.script(task.id, [
      { kind: 'tool', toolId: 'notes.write', args: { n: 2 }, argsHash: 'h2', idempotencyKey: 'k2' },
      { kind: 'done', summary: 'recovered' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    const outcome = await svc.runTask(task.id, agent.id);
    expect(outcome.status).toBe('complete');
    // No duplicate external effect: executor ran exactly twice (pre-crash only).
    expect(executions).toBe(2);
    expect(store.tasks.get(task.id)?.status).toBe('COMPLETE');
  });

  it('consequential tools park the task in APPROVAL_REQUIRED', async () => {    const { store, broker, agent, task } = setup();
    broker.registerTool({
      id: 'external.publish', source: 'builtin', name: 'publish', description: 'publish',
      inputSchema: { type: 'object' }, capabilityClass: 'consequential', provenance: 'builtin',
    });
    broker.grant({ principal: { kind: 'core-agent', agentId: agent.id }, toolId: 'external.publish', scope: 'task', taskId: task.id });
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'external.publish', args: { doc: 1 }, argsHash: 'h', idempotencyKey: 'p1' },
    ]);
    const executor: ToolExecutor = { execute: async () => ({ ok: true }) };
    const svc = new CabotRuntimeService(store, broker, model, executor);
    const outcome = await svc.runTask(task.id, agent.id, 3);
    expect(outcome.status).toBe('approval-required');
    expect(store.tasks.get(task.id)?.status).toBe('APPROVAL_REQUIRED');
  });
});

describe('cancellation and pause', () => {
  function runningSetup() {
    const s = setup();
    const model = new FakeModelProvider();
    let executions = 0;
    const executor: ToolExecutor = {
      execute: async (): Promise<ToolExecution> => {
        executions += 1;
        return { ok: true, resultHash: 'r' };
      },
    };
    const svc = new CabotRuntimeService(s.store, s.broker, model, executor);
    return { ...s, model, executor, svc, ran: () => executions };
  }

  it('cancel during an active run stops the loop at the next turn', async () => {
    const { store, broker, agent, task, model, executor, svc, ran } = runningSetup();
    model.script(task.id, [
      { kind: 'tool', toolId: 'notes.write', args: { n: 1 }, argsHash: 'h1', idempotencyKey: 'k1' },
      { kind: 'tool', toolId: 'notes.write', args: { n: 2 }, argsHash: 'h2', idempotencyKey: 'k2' },
      { kind: 'done', summary: 'never reached' },
    ]);
    expect((await runAgentTurn(store, broker, model, executor, task.id, agent.id)).status).toBe('continue');
    expect(ran()).toBe(1);
    svc.cancelTask(task.id);
    expect((await runAgentTurn(store, broker, model, executor, task.id, agent.id)).status).toBe('cancelled');
    expect(store.tasks.get(task.id)?.status).toBe('CANCELLED');
    expect(ran()).toBe(1); // second dispatch never happened
    expect((await svc.runTask(task.id, agent.id)).status).toBe('suspended');
  });

  it('cancels directly from parked states', async () => {
    const { store, svc, task } = runningSetup();
    for (const status of ['APPROVAL_REQUIRED', 'BLOCKED', 'INTERRUPTED'] as const) {
      const t = store.tasks.get(task.id)!;
      t.status = status;
      svc.cancelTask(task.id);
      expect(store.tasks.get(task.id)?.status).toBe('CANCELLED');
      // reset for next iteration (test-only direct mutation)
      t.status = status;
    }
    void store;
  });

  it('pause during an active run stops the loop at the boundary', async () => {
    const { store, broker, agent, task, model, executor, svc, ran } = runningSetup();
    model.script(task.id, [
      { kind: 'tool', toolId: 'notes.write', args: { n: 1 }, argsHash: 'h1', idempotencyKey: 'k1' },
      { kind: 'tool', toolId: 'notes.write', args: { n: 2 }, argsHash: 'h2', idempotencyKey: 'k2' },
    ]);
    expect((await runAgentTurn(store, broker, model, executor, task.id, agent.id)).status).toBe('continue');
    svc.pauseTask(task.id);
    expect(store.tasks.get(task.id)?.status).toBe('SUSPENDED');
    const outcome = await runAgentTurn(store, broker, model, executor, task.id, agent.id);
    expect(outcome.status).toBe('suspended');
    expect(ran()).toBe(1);
  });
});

describe('agent status sync', () => {
  it('tracks WAITING_FOR_MODEL, WAITING_FOR_TOOL, and COMPLETED across a run', async () => {
    const { store, broker, agent, task } = setup();
    const seen: Record<string, string[]> = { decide: [], execute: [] };
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'notes.write', args: { n: 1 }, argsHash: 'h1', idempotencyKey: 'k1' },
      { kind: 'done', summary: 'finished' },
    ]);
    const observingModel = {
      id: 'obs',
      listModels: async () => [],
      decide: async (req: Parameters<FakeModelProvider['decide']>[0]) => {
        seen.decide.push(store.agents.get(agent.id)?.status ?? '?');
        return model.decide(req);
      },
    };
    const executor: ToolExecutor = {
      execute: async (toolId, args) => {
        seen.execute.push(store.agents.get(agent.id)?.status ?? '?');
        return { ok: true, resultHash: `r:${JSON.stringify(args)}` };
      },
    };
    const svc = new CabotRuntimeService(store, broker, observingModel, executor);
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');
    expect(seen.decide).toEqual(['WAITING_FOR_MODEL', 'WAITING_FOR_MODEL']);
    expect(seen.execute).toEqual(['WAITING_FOR_TOOL']);
    expect(store.agents.get(agent.id)?.status).toBe('COMPLETED');
  });

  it('parks the agent in WAITING_FOR_USER and cancels to CANCELLED', async () => {
    const { store, broker, agent, task } = setup();
    broker.registerTool({
      id: 'external.publish', source: 'builtin', name: 'publish', description: 'p',
      inputSchema: { type: 'object' }, capabilityClass: 'consequential', provenance: 'builtin',
    });
    broker.grant({ principal: { kind: 'core-agent', agentId: agent.id }, toolId: 'external.publish', scope: 'task', taskId: task.id });
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'external.publish', args: {}, argsHash: 'h', idempotencyKey: 'k' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, { execute: async () => ({ ok: true }) });
    expect((await svc.runTask(task.id, agent.id, 3)).status).toBe('approval-required');
    expect(store.agents.get(agent.id)?.status).toBe('WAITING_FOR_USER');
    svc.cancelTask(task.id);
    expect(store.tasks.get(task.id)?.status).toBe('CANCELLED');
    expect(store.agents.get(agent.id)?.status).toBe('CANCELLED');
  });
});

describe('cancel with no loop in flight', () => {
  it('cancelTaskNow cancels a stalled RUNNING task and syncs the agent', () => {
    const { store, agent, task, svc } = (() => {
      const s = setup();
      const svc = new CabotRuntimeService(s.store, s.broker, new FakeModelProvider(), { execute: async () => ({ ok: true }) });
      return { ...s, svc };
    })();
    // Simulate a run that returned without transitioning the task
    // (e.g. max-turns suspension): task RUNNING, no loop alive.
    expect(store.tasks.get(task.id)?.status).toBe('RUNNING');
    expect(store.agents.get(agent.id)?.status).toBe('RUNNING');
    svc.cancelTaskNow(task.id);
    expect(store.tasks.get(task.id)?.status).toBe('CANCELLED');
    expect(store.agents.get(agent.id)?.status).toBe('CANCELLED');
  });

  it('cancelTaskNow is a no-op on terminal tasks', () => {
    const { store, agent, task, svc } = (() => {
      const s = setup();
      const svc = new CabotRuntimeService(s.store, s.broker, new FakeModelProvider(), { execute: async () => ({ ok: true }) });
      return { ...s, svc };
    })();
    store.transitionTask(task.id, 'CANCELLED', 'c');
    store.setAgentStatus(agent.id, 'CANCELLED');
    svc.cancelTaskNow(task.id);
    expect(store.tasks.get(task.id)?.status).toBe('CANCELLED');
  });
});

describe('model failure handling', () => {
  it('records the failure and suspends rather than stalling', async () => {
    const { store, broker, agent, task } = setup();
    const failing = {
      id: 'boom',
      listModels: async () => [],
      decide: async () => {
        throw new Error('model endpoint unreachable (https://x): Failed to fetch');
      },
    };
    const svc = new CabotRuntimeService(store, broker, failing, { execute: async () => ({ ok: true }) });
    const outcome = await svc.runTask(task.id, agent.id);
    expect(outcome.status).toBe('suspended');
    expect(store.tasks.get(task.id)?.status).toBe('SUSPENDED');
    expect(store.agents.get(agent.id)?.status).toBe('PAUSED');
    const failed = store.events.filter((e) => e.taskId === task.id && e.type === 'model.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].summary).toMatch(/unreachable/);
    // Visible in the transcript too, not just the activity log.
    const conv = store.forTaskConversation(task.id);
    expect(conv.some((m) => m.text.includes('Model call failed'))).toBe(true);
    // Resumable: a message wakes it and a working model completes it.
    svc.sendUserMessage(task.id, 'try again');
    expect(store.tasks.get(task.id)?.status).toBe('READY');
  });
});
