import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONVERSATION_GLOBAL_CAP,
  CONVERSATION_PER_TASK_CAP,
  DurableStore,
} from './store.js';
import { loadStore, openDatabase, saveStore } from './sqlite-persist.js';
import { restoreStore, serializeStore } from './browser-persist.js';

function setup() {
  const store = new DurableStore();
  const project = store.createProject('P');
  const agent = store.createAgent({
    projectId: project.id, role: 'r', objective: 'o', status: 'RUNNING',
    modelConfig: { providerId: 'x', modelId: 'y' }, skillIds: [],
    budget: {}, workspaceMounts: [], delegationDepth: 0,
  });
  const task = store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
  return { store, project, agent, task };
}

describe('conversation persistence', () => {
  it('records ordered user/agent/tool messages', () => {
    const { store, agent, task } = setup();
    store.appendConversation(task.id, agent.id, 'user', 'do the thing');
    store.appendConversation(task.id, agent.id, 'agent', 'on it');
    store.appendConversation(task.id, agent.id, 'tool', 'browser.read_page — succeeded', { toolId: 'browser.read_page', ok: true });
    const conv = store.forTaskConversation(task.id);
    expect(conv.map((m) => m.role)).toEqual(['user', 'agent', 'tool']);
    expect(conv[2].toolId).toBe('browser.read_page');
    expect(conv[2].ok).toBe(true);
  });

  it('caps per-task history and logs the trim', () => {
    const { store, agent, task } = setup();
    for (let i = 0; i < CONVERSATION_PER_TASK_CAP + 10; i += 1) {
      store.appendConversation(task.id, agent.id, 'agent', `msg ${i}`);
    }
    const conv = store.forTaskConversation(task.id, 10_000);
    expect(conv).toHaveLength(CONVERSATION_PER_TASK_CAP);
    expect(conv[0].text).toBe('msg 10');
    expect(store.events.some((e) => e.type === 'conversation.trimmed')).toBe(true);
  });

  it('trims oldest completed tasks first at the global cap', () => {
    const { store, project, agent } = setup();
    // 11 tasks × 480 messages stays under the per-task cap but exceeds the
    // 5,000 global cap, forcing global trimming.
    const ids: string[] = [];
    for (let t = 0; t < 11; t += 1) {
      const task = store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: `T${t}`, objective: 'O' });
      ids.push(task.id);
      for (let i = 0; i < 480; i += 1) store.appendConversation(task.id, agent.id, 'agent', `t${t} m${i}`);
      if (t < 10) {
        store.transitionTask(task.id, 'READY', 'r');
        store.transitionTask(task.id, 'RUNNING', 'r');
        store.transitionTask(task.id, 'COMPLETE', 'done');
      }
    }
    expect(store.conversation.length).toBeLessThanOrEqual(CONVERSATION_GLOBAL_CAP);
    // Oldest-first: task0 lost its 280 oldest, task1+ untouched, live intact.
    const t0 = store.forTaskConversation(ids[0], 10_000);
    expect(t0).toHaveLength(200);
    expect(t0[0].text).toBe('t0 m280');
    expect(store.forTaskConversation(ids[1], 10_000)).toHaveLength(480);
    expect(store.forTaskConversation(ids[10], 10_000)).toHaveLength(480);
  });

  it('round-trips through snapshot and SQLite', () => {
    const { store, agent, task } = setup();
    store.appendConversation(task.id, agent.id, 'user', 'hi');
    store.appendConversation(task.id, agent.id, 'agent', 'hello', {});
    const revived = restoreStore(serializeStore(store));
    expect(revived.forTaskConversation(task.id).map((m) => m.text)).toEqual(['hi', 'hello']);

    const dir = mkdtempSync(join(tmpdir(), 'cabot-conv-'));
    const db = openDatabase(join(dir, 'cabot.db'));
    saveStore(db, store);
    db.close();
    const db2 = openDatabase(join(dir, 'cabot.db'));
    const loaded = loadStore(db2);
    db2.close();
    expect(loaded.forTaskConversation(task.id).map((m) => [m.role, m.text])).toEqual([
      ['user', 'hi'],
      ['agent', 'hello'],
    ]);
  });
});
