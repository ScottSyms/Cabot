import { describe, expect, it } from 'vitest';
import { DurableStore } from '@cabot/storage/browser-chrome';
import { CapabilityBroker } from '@cabot/policy';
import { FakeModelProvider } from '@cabot/providers';
import { CabotRuntimeService } from '@cabot/runtime';
import {
  WORKSPACE_TOOLS,
  WorkspaceToolExecutor,
  sanitizeWorkspacePath,
  type AsyncBlobStore,
} from './workspace.js';

class MemoryAsyncBlobStore implements AsyncBlobStore {
  staged = new Map<string, Uint8Array>();
  published = new Map<string, Uint8Array>();
  async writeStaged(id: string, bytes: Uint8Array): Promise<void> {
    this.staged.set(id, bytes);
  }
  async publish(id: string): Promise<void> {
    const b = this.staged.get(id);
    if (!b) throw new Error(`missing staged ${id}`);
    this.published.set(id, b);
    this.staged.delete(id);
  }
  async read(id: string): Promise<Uint8Array> {
    const b = this.published.get(id);
    if (!b) throw new Error(`not published ${id}`);
    return b;
  }
  async listOrphanStaged(): Promise<string[]> {
    return [...this.staged.keys()];
  }
}

function setup(grant = true) {
  const store = new DurableStore();
  const broker = new CapabilityBroker(store);
  for (const t of WORKSPACE_TOOLS) broker.registerTool(t);
  const project = store.createProject('P');
  const agent = store.createAgent({
    projectId: project.id, role: 'researcher', objective: 'o', status: 'RUNNING',
    modelConfig: { providerId: 'fake', modelId: 'fake-1' }, skillIds: [],
    budget: { maxModelCalls: 20, maxToolCalls: 20 }, workspaceMounts: [], delegationDepth: 0,
  });
  const task = store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
  if (grant) {
    for (const toolId of ['workspace.write', 'workspace.list', 'workspace.read']) {
      broker.grant({ principal: { kind: 'core-agent', agentId: agent.id }, toolId, scope: 'task', taskId: task.id });
    }
  }
  const blobs = new MemoryAsyncBlobStore();
  const executor = new WorkspaceToolExecutor(blobs, store, task.id, project.id, agent.id);
  return { store, broker, project, agent, task, blobs, executor };
}

describe('workspace paths', () => {
  it('accepts relative paths and rejects escapes', () => {
    expect(sanitizeWorkspacePath('report.md')).toBe('report.md');
    expect(sanitizeWorkspacePath('reports/summary.md')).toBe('reports/summary.md');
    expect(sanitizeWorkspacePath('/report.md')).toBe('report.md');
    expect(() => sanitizeWorkspacePath('../secrets.txt')).toThrow(/unsafe/);
    expect(() => sanitizeWorkspacePath('a/../../b')).toThrow(/unsafe/);
    expect(() => sanitizeWorkspacePath('')).toThrow(/required/);
    expect(() => sanitizeWorkspacePath('bad name.md')).toThrow(/invalid/);
  });
});

describe('workspace file tools', () => {
  it('writes a file that becomes a durable artifact', async () => {
    const { store, task, blobs, executor } = setup();
    const res = await executor.execute('workspace.write', { path: 'summary.md', content: '# Summary\n\nDone.' });
    expect(res.ok).toBe(true);
    const arts = [...store.artifacts.values()].filter((a) => a.taskId === task.id && !a.staged);
    expect(arts.map((a) => a.path)).toEqual(['summary.md']);
    expect(new TextDecoder().decode(await blobs.read(arts[0].id))).toBe('# Summary\n\nDone.');
  });

  it('lists and reads back written files', async () => {
    const { executor } = setup();
    await executor.execute('workspace.write', { path: 'notes/a.md', content: 'alpha' });
    const list = await executor.execute('workspace.list', {});
    expect((list.result as { files: { path: string }[] }).files.map((f) => f.path)).toEqual(['notes/a.md']);
    const read = await executor.execute('workspace.read', { path: 'notes/a.md' });
    expect((read.result as { content: string }).content).toBe('alpha');
    const missing = await executor.execute('workspace.read', { path: 'nope.md' });
    expect(missing.ok).toBe(false);
  });

  it('refuses an unsafe path without writing anything', async () => {
    const { store, task, executor } = setup();
    const res = await executor.execute('workspace.write', { path: '../escape.md', content: 'x' });
    expect(res.ok).toBe(false);
    expect([...store.artifacts.values()].filter((a) => a.taskId === task.id)).toHaveLength(0);
  });

  it('runs through the brokered loop and shows up in task detail', async () => {
    const { store, broker, agent, task, executor } = setup();
    const model = new FakeModelProvider();
    model.script(task.id, [
      {
        kind: 'tool', toolId: 'workspace.write',
        args: { path: 'report.md', content: '# Report' },
        argsHash: 'h1', idempotencyKey: 'k1',
      },
      { kind: 'done', summary: 'file written' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');
    const detail = svc.getTaskDetail(task.id);
    expect(detail.artifacts.map((a) => a.path)).toEqual(['report.md']);
  });

  it('denies workspace.write without a grant', async () => {
    const { store, broker, agent, task, executor } = setup(false);
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'workspace.write', args: { path: 'x.md', content: 'y' }, argsHash: 'h', idempotencyKey: 'k' },
      { kind: 'done', summary: 'done' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    await svc.runTask(task.id, agent.id, 5);
    expect([...store.artifacts.values()].filter((a) => a.taskId === task.id)).toHaveLength(0);
    expect(store.events.some((e) => e.summary.includes('workspace.write denied'))).toBe(true);
  });
});
