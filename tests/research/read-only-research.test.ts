// Phase-2 slice: a scripted research task reads two fixture pages through
// brokered read-only tools, captures durable sources with provenance, and
// completes. Unregistered write tools are denied by the broker.
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore, loadStore, openDatabase, saveStore } from '@cabot/storage';
import { CapabilityBroker } from '@cabot/policy';
import { FakeModelProvider } from '@cabot/providers';
import { CabotRuntimeService } from '@cabot/runtime';
import {
  BrowserToolExecutor,
  FakeBrowserBackend,
  registerBrowserTools,
} from '@cabot/tools';

function setup() {
  const store = new DurableStore();
  const broker = new CapabilityBroker(store);
  registerBrowserTools((t) => broker.registerTool(t));
  const project = store.createProject('Research');
  const agent = store.createAgent({
    projectId: project.id, role: 'researcher', objective: 'compare approaches', status: 'RUNNING',
    modelConfig: { providerId: 'fake', modelId: 'fake-1' }, skillIds: [],
    budget: { maxModelCalls: 20, maxToolCalls: 20 }, workspaceMounts: [], delegationDepth: 0,
  });
  const task = store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'Compare DBs', objective: 'compare three browser-resident DBs' });
  for (const toolId of ['browser.list_tabs', 'browser.read_page']) {
    broker.grant({ principal: { kind: 'core-agent', agentId: agent.id }, toolId, scope: 'task', taskId: task.id });
  }
  const backend = new FakeBrowserBackend();
  backend.addTab(
    { id: 't1', url: 'https://example.com/duckdb', title: 'DuckDB-Wasm', origin: 'https://example.com' },
    {
      url: 'https://example.com/duckdb', origin: 'https://example.com', title: 'DuckDB-Wasm',
      text: 'DuckDB-Wasm runs analytical SQL in the browser.',
      links: [{ text: 'docs', href: 'https://example.com/duckdb/docs' }],
      truncated: false,
    },
  );
  backend.addTab(
    { id: 't2', url: 'https://example.org/sqlite', title: 'SQLite WASM', origin: 'https://example.org' },
    {
      url: 'https://example.org/sqlite', origin: 'https://example.org', title: 'SQLite WASM',
      text: 'SQLite compiled to WebAssembly with OPFS persistence.',
      links: [{ text: 'api', href: 'https://example.org/sqlite/api' }],
      truncated: false,
    },
  );
  const executor = new BrowserToolExecutor(backend, store, task.id, project.id);
  return { store, broker, project, agent, task, executor };
}

describe('read-only research task', () => {
  it('reads pages, captures sources with provenance, completes', async () => {
    const { store, broker, project, agent, task, executor } = setup();
    void project;
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'browser.list_tabs', args: {}, argsHash: 'h-list', idempotencyKey: 'r-list' },
      { kind: 'tool', toolId: 'browser.read_page', args: { tabId: 't1' }, argsHash: 'h-r1', idempotencyKey: 'r-1' },
      { kind: 'tool', toolId: 'browser.read_page', args: { tabId: 't2' }, argsHash: 'h-r2', idempotencyKey: 'r-2' },
      { kind: 'done', summary: 'compared two approaches with sources' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    const outcome = await svc.runTask(task.id, agent.id);
    expect(outcome.status).toBe('complete');
    expect(store.tasks.get(task.id)?.status).toBe('COMPLETE');

    const sources = [...store.sources.values()].filter((s) => s.taskId === task.id);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.uri).sort()).toEqual(['https://example.com/duckdb', 'https://example.org/sqlite']);
    for (const s of sources) {
      expect(s.origin).toMatch(/^https:\/\//);
      expect(s.sha256).toMatch(/^[0-9a-f]{16}$/);
      expect(s.projectId).toBe(project.id);
    }
  });

  it('denies tools outside the grant (no ambient authority)', async () => {
    const { store, broker, agent, task, executor } = setup();
    const model = new FakeModelProvider();
    model.script(task.id, [
      // Not registered as a tool and not granted: broker denies, loop continues.
      { kind: 'tool', toolId: 'browser.submit', args: {}, argsHash: 'h-x', idempotencyKey: 'r-x' },
      { kind: 'done', summary: 'no write performed' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    const outcome = await svc.runTask(task.id, agent.id);
    expect(outcome.status).toBe('complete');
    const denied = store.events.filter((e) => e.taskId === task.id && e.type === 'tool.failed');
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[0].summary).toMatch(/denied/);
  });

  it('sources survive SQLite restart', async () => {
    const { store, project, task } = setup();
    store.captureSource({ projectId: project.id, taskId: task.id, uri: 'https://example.com/x', origin: 'https://example.com', sha256: 'abcdef0123456789' });
    const dir = mkdtempSync(join(tmpdir(), 'cabot-src-'));
    const db1 = openDatabase(join(dir, 'cabot.db'));
    saveStore(db1, store);
    db1.close();
    const db2 = openDatabase(join(dir, 'cabot.db'));
    const loaded = loadStore(db2);
    db2.close();
    expect([...loaded.sources.values()].filter((s) => s.taskId === task.id)).toHaveLength(1);
  });
});
