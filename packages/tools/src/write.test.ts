import { describe, expect, it } from 'vitest';
import { DurableStore } from '@cabot/storage';
import { CapabilityBroker } from '@cabot/policy';
import { FakeModelProvider } from '@cabot/providers';
import { CabotRuntimeService } from '@cabot/runtime';
import {
  BrowserToolExecutor,
  TabMutex,
  registerBrowserTools,
} from './browser.js';
import { FakeBrowserBackend } from './fake-backend.js';

const PAGE = {
  url: 'https://example.com/form',
  origin: 'https://example.com',
  title: 'Form',
  text: 'A form page.',
  links: [],
  truncated: false,
};

function setup() {
  const store = new DurableStore();
  const broker = new CapabilityBroker(store);
  registerBrowserTools((t) => broker.registerTool(t));
  const project = store.createProject('P');
  const agent = store.createAgent({
    projectId: project.id, role: 'r', objective: 'fill the form', status: 'RUNNING',
    modelConfig: { providerId: 'fake', modelId: 'fake-1' }, skillIds: [],
    budget: { maxModelCalls: 20, maxToolCalls: 20 }, workspaceMounts: [], delegationDepth: 0,
  });
  const task = store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
  for (const toolId of ['browser.navigate', 'browser.click', 'browser.type', 'browser.submit']) {
    broker.grant({ principal: { kind: 'core-agent', agentId: agent.id }, toolId, scope: 'task', taskId: task.id });
  }
  const backend = new FakeBrowserBackend();
  backend.addTab({ id: 't1', url: 'https://example.com/', title: 'Home', origin: 'https://example.com' }, PAGE);
  backend.addElement('t1', 'q', 'Search');
  backend.addElement('t1', 'go', 'Submit form');
  const executor = new BrowserToolExecutor(backend, store, task.id, project.id);
  return { store, broker, project, agent, task, backend, executor };
}

describe('write-path browser tools', () => {
  it('navigates, clicks and types through the brokered loop', async () => {
    const { store, broker, agent, task, backend, executor } = setup();
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'browser.navigate', args: { url: 'https://example.com/form', tabId: 't1' }, argsHash: 'h-n', idempotencyKey: 'w-n' },
      { kind: 'tool', toolId: 'browser.click', args: { elementId: 'q', expectedText: 'Search', tabId: 't1' }, argsHash: 'h-c', idempotencyKey: 'w-c' },
      { kind: 'tool', toolId: 'browser.type', args: { elementId: 'q', expectedText: 'Search', text: 'duckdb', tabId: 't1' }, argsHash: 'h-t', idempotencyKey: 'w-t' },
      { kind: 'done', summary: 'form filled' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');
    expect(backend.actions).toEqual([
      'navigate:t1:https://example.com/form',
      'click:t1:q',
      'type:t1:q:duckdb',
    ]);
    expect(store.events.some((e) => e.type === 'browser.navigated')).toBe(true);
  });

  it('rejects stale targets without acting', async () => {
    const { store, broker, agent, task, backend, executor } = setup();
    backend.setElementText('t1', 'q', 'Search (updated)');
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'browser.click', args: { elementId: 'q', expectedText: 'Search', tabId: 't1' }, argsHash: 'h-c', idempotencyKey: 'w-c' },
      { kind: 'done', summary: 'gave up safely' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');
    expect(backend.actions).toEqual([]);
    const failed = store.events.filter((e) => e.type === 'tool.failed');
    expect(failed.some((e) => e.summary.includes('stale target'))).toBe(true);
  });

  it('submit parks for approval; granted approval executes once', async () => {
    const { store, broker, agent, task, backend, executor } = setup();
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'browser.submit', args: { elementId: 'go', expectedText: 'Submit form', tabId: 't1' }, argsHash: 'h-s', idempotencyKey: 'w-s' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    const parked = await svc.runTask(task.id, agent.id, 3);
    expect(parked.status).toBe('approval-required');
    expect(store.tasks.get(task.id)?.status).toBe('APPROVAL_REQUIRED');
    expect(backend.actions).toEqual([]); // nothing acted before approval
    if (parked.status !== 'approval-required') throw new Error('expected approval gate');

    // Approve and dispatch through the broker binding recheck.
    broker.decideApproval(parked.approvalId, 'granted');
    const dispatch = broker.authorizeDispatch(
      {
        toolId: 'browser.submit',
        args: { elementId: 'go', expectedText: 'Submit form', tabId: 't1' },
        argsHash: 'h-s',
        principal: { kind: 'core-agent', agentId: agent.id },
        taskId: task.id,
        agentId: agent.id,
      },
      parked.approvalId,
    );
    expect(dispatch.allowed).toBe(true);
    const exec = await executor.execute('browser.submit', { elementId: 'go', expectedText: 'Submit form', tabId: 't1' });
    expect(exec.ok).toBe(true);
    expect(backend.actions).toEqual(['click:t1:go']);
    expect(store.events.some((e) => e.type === 'browser.submitted')).toBe(true);
  });

  it('serializes conflicting actions on the same tab', async () => {
    const mutex = new TabMutex();
    const order: string[] = [];
    const slow = mutex.run('t1', async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push('first');
      return 1;
    });
    const fast = mutex.run('t1', async () => {
      order.push('second');
      return 2;
    });
    expect(await Promise.all([slow, fast])).toEqual([1, 2]);
    expect(order).toEqual(['first', 'second']);
  });
});
