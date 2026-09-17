import { describe, expect, it } from 'vitest';
import { DurableStore } from '@cabot/storage';
import { CapabilityBroker } from '@cabot/policy';
import { FakeModelProvider } from '@cabot/providers';
import { CabotRuntimeService } from './api.js';
import type { ToolExecutor } from './loop.js';

function setup() {
  const store = new DurableStore();
  const broker = new CapabilityBroker(store);
  broker.registerTool({
    id: 'notes.write', source: 'builtin', name: 'write', description: 'w',
    inputSchema: { type: 'object' }, capabilityClass: 'reversible', provenance: 'builtin',
  });
  broker.registerTool({
    id: 'external.publish', source: 'builtin', name: 'publish', description: 'p',
    inputSchema: { type: 'object' }, capabilityClass: 'consequential', provenance: 'builtin',
  });
  const project = store.createProject('P');
  const agent = store.createAgent({
    projectId: project.id, role: 'writer', objective: 'o', status: 'RUNNING',
    modelConfig: { providerId: 'fake', modelId: 'fake-1' }, skillIds: [],
    budget: { maxModelCalls: 30, maxToolCalls: 30 }, workspaceMounts: [], delegationDepth: 0,
  });
  const task = store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'Publish report', objective: 'O' });
  for (const toolId of ['notes.write', 'external.publish']) {
    broker.grant({ principal: { kind: 'core-agent', agentId: agent.id }, toolId, scope: 'task', taskId: task.id });
  }
  const executed: string[] = [];
  const executor: ToolExecutor = {
    execute: async (toolId) => {
      executed.push(toolId);
      return { ok: true, resultHash: `r:${toolId}` };
    },
  };
  const model = new FakeModelProvider();
  const svc = new CabotRuntimeService(store, broker, model, executor);
  return { store, broker, project, agent, task, model, svc, executed };
}

describe('approval inbox + inspection', () => {
  it('parks consequential work and exposes it in the inbox and dashboard', async () => {
    const { svc, agent, task, model } = setup();
    model.script(task.id, [
      { kind: 'tool', toolId: 'notes.write', args: {}, argsHash: 'h1', idempotencyKey: 'k1' },
      { kind: 'tool', toolId: 'external.publish', args: { doc: 1 }, argsHash: 'h2', idempotencyKey: 'k2' },
    ]);
    const parked = await svc.runTask(task.id, agent.id, 5);
    expect(parked.status).toBe('approval-required');

    const inbox = svc.listPendingApprovals();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ toolId: 'external.publish', taskTitle: 'Publish report', agentRole: 'writer' });

    const dashboard = svc.getDashboard();
    expect(dashboard.pendingApprovals).toBe(1);
    expect(dashboard.tasksByStatus.APPROVAL_REQUIRED).toBe(1);
    expect(dashboard.blockedTasks.map((t) => t.id)).toContain(task.id);

    const detail = svc.getTaskDetail(task.id);
    expect(detail.operations.map((o) => o.toolId)).toContain('notes.write');
    expect(detail.approvals.map((a) => a.toolId)).toContain('external.publish');
    expect(detail.events.length).toBeGreaterThan(0);
  });

  it('denied approval blocks the task without dispatching; resume + done completes', async () => {
    const { store, svc, agent, task, model, executed } = setup();
    model.script(task.id, [
      { kind: 'tool', toolId: 'external.publish', args: { doc: 1 }, argsHash: 'h2', idempotencyKey: 'k2' },
    ]);
    const parked = await svc.runTask(task.id, agent.id, 3);
    expect(parked.status).toBe('approval-required');
    if (parked.status !== 'approval-required') throw new Error('expected gate');

    svc.decideApproval(parked.approvalId, 'denied');
    expect(store.tasks.get(task.id)?.status).toBe('BLOCKED');
    expect(executed).toEqual([]); // never dispatched
    expect(svc.listPendingApprovals()).toHaveLength(0);

    svc.resumeTask(task.id);
    model.script(task.id, [{ kind: 'done', summary: 'stood down after denial' }]);
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');
    expect(executed).toEqual([]);
  });

  it('granted approval resumes the loop and dispatches exactly once', async () => {    const { store, svc, agent, task, model, executed } = setup();
    model.script(task.id, [
      { kind: 'tool', toolId: 'external.publish', args: { doc: 1 }, argsHash: 'h2', idempotencyKey: 'k2' },
    ]);
    const parked = await svc.runTask(task.id, agent.id, 3);
    expect(parked.status).toBe('approval-required');
    if (parked.status !== 'approval-required') throw new Error('expected gate');

    svc.decideApproval(parked.approvalId, 'granted');
    expect(store.tasks.get(task.id)?.status).toBe('RUNNING');

    // Same logical step retried: idempotent prepare finds the approval-bound
    // path and the loop dispatches under the binding exactly once.
    model.script(task.id, [
      { kind: 'tool', toolId: 'external.publish', args: { doc: 1 }, argsHash: 'h2', idempotencyKey: 'k2' },
      { kind: 'done', summary: 'published after approval' },
    ]);
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');
    expect(executed).toEqual(['external.publish']);
  });
});

describe('user messages', () => {
  it('records steering input the next model turn will see', async () => {
    const { store, svc, agent, task, model } = setup();
    model.script(task.id, [{ kind: 'done', summary: 'first pass' }]);
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');

    // Finished tasks reject new input.
    expect(() => svc.sendUserMessage(task.id, 'do more')).toThrow(/start a new task/);

    // Reopen via a fresh task to check the message lands in context.
    const task2 = store.createTask({ projectId: setup_projectId(store), ownerAgentId: agent.id, title: 'T2', objective: 'O2' });
    store.transitionTask(task2.id, 'READY', 'r');
    store.transitionTask(task2.id, 'RUNNING', 'r');
    svc.sendUserMessage(task2.id, '  focus on prices  ');
    const events = store.events.filter((e) => e.taskId === task2.id && e.type === 'user.message');
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('focus on prices');
    expect(() => svc.sendUserMessage(task2.id, '   ')).toThrow(/empty/);
  });

  it('wakes blocked tasks back to READY', async () => {
    const { store, svc, agent, task, model } = setup();
    model.script(task.id, [
      { kind: 'tool', toolId: 'external.publish', args: { doc: 1 }, argsHash: 'h2', idempotencyKey: 'k2' },
    ]);
    const parked = await svc.runTask(task.id, agent.id, 3);
    expect(parked.status).toBe('approval-required');
    if (parked.status !== 'approval-required') throw new Error('expected gate');
    svc.decideApproval(parked.approvalId, 'denied');
    expect(store.tasks.get(task.id)?.status).toBe('BLOCKED');

    svc.sendUserMessage(task.id, 'skip publishing, just summarize');
    expect(store.tasks.get(task.id)?.status).toBe('READY');
  });
});

function setup_projectId(store: DurableStore): string {
  return [...store.projects.values()][0].id;
}

describe('conversation transcript', () => {
  it('orders user, agent, tool, and completion messages', async () => {
    const { store, svc, agent, task, model } = setup();
    model.script(task.id, [
      { kind: 'tool', toolId: 'notes.write', args: {}, argsHash: 'h1', idempotencyKey: 'k1' },
      { kind: 'done', summary: 'all written' },
    ]);
    model.say(task.id, 'Writing the note now.', undefined);
    svc.sendUserMessage(task.id, 'please write it');
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');
    const conv = store.forTaskConversation(task.id);
    expect(conv.map((m) => m.role)).toEqual(['user', 'agent', 'tool', 'agent']);
    expect(conv[0].text).toBe('please write it');
    expect(conv[1].text).toBe('Writing the note now.');
    expect(conv[2]).toMatchObject({ toolId: 'notes.write', ok: true });
    expect(conv[3].text).toBe('all written');
    expect(svc.getTaskDetail(task.id).conversation).toHaveLength(4);
  });
});

describe('interrupted-task recovery', () => {
  it('resumes tasks with no uncertain op and blocks ones with an uncertain op', () => {
    const { store, svc, agent } = setup();
    const project = setup_projectId(store);
    const clean = store.createTask({ projectId: project, ownerAgentId: agent.id, title: 'Clean', objective: 'O' });
    const dirty = store.createTask({ projectId: project, ownerAgentId: agent.id, title: 'Dirty', objective: 'O' });
    store.transitionTask(clean.id, 'READY', 'r');
    store.transitionTask(clean.id, 'RUNNING', 'r');
    store.transitionTask(dirty.id, 'READY', 'r');
    store.transitionTask(dirty.id, 'RUNNING', 'r');
    const op = store.prepareOperation({ taskId: dirty.id, agentId: agent.id, toolId: 'notes.write', argsHash: 'h', idempotencyKey: 'k' });
    store.markDispatched(op.id);
    store.reconcileAfterRestart();
    expect(store.tasks.get(clean.id)?.status).toBe('INTERRUPTED');
    expect(store.tasks.get(dirty.id)?.status).toBe('INTERRUPTED');

    const resumed = svc.resumeInterruptedTasks();
    expect(resumed).toContain(clean.id);
    expect(resumed).not.toContain(dirty.id);
    expect(store.tasks.get(clean.id)?.status).toBe('READY');
    expect(store.tasks.get(dirty.id)?.status).toBe('BLOCKED');
    expect(store.events.some((e) => e.taskId === dirty.id && e.summary.includes('result unknown'))).toBe(true);
  });
});
