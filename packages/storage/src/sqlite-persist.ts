// SQLite-backed durability for DurableStore.
// Spike strategy: DurableStore remains the in-memory transaction engine;
// this module atomically snapshots/restores it to SQLite (WAL) so a
// process/extension restart recovers committed state. Later the Storage
// Worker will execute the same SQL directly; the table layout here is the
// migration baseline (see schema.ts).
// In the browser this maps to SQLite-WASM + OPFS; in Node tests it uses
// node:sqlite against a file. Same SQL, same atomicity contract.
import { createRequire } from 'node:module';
import { SCHEMA } from './schema.js';
import { DurableStore } from './store.js';

// node:sqlite is a Node built-in; load via require so bundlers/test
// runners that rewrite `node:` specifiers keep resolving it as builtin.
const requireNode = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseSyncType = any;
const { DatabaseSync } = requireNode('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSyncType };

export type SqliteDatabase = any;

export function openDatabase(path: string): SqliteDatabase {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Atomically persist the full store. Crash mid-write leaves prior snapshot. */
export function saveStore(db: SqliteDatabase, store: DurableStore): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(
      'DELETE FROM projects; DELETE FROM tasks; DELETE FROM agents; DELETE FROM operations; DELETE FROM events; DELETE FROM conversation; DELETE FROM checkpoints; DELETE FROM messages; DELETE FROM delivered; DELETE FROM artifacts; DELETE FROM sources; DELETE FROM grants; DELETE FROM approvals; DELETE FROM externals; DELETE FROM queue;',
    );
    const insProject = db.prepare('INSERT INTO projects (id, json) VALUES (?, ?)');
    for (const p of store.projects.values()) insProject.run(p.id, JSON.stringify(p));
    const insTask = db.prepare('INSERT INTO tasks (id, json) VALUES (?, ?)');
    for (const t of store.tasks.values()) insTask.run(t.id, JSON.stringify(t));
    const insAgent = db.prepare('INSERT INTO agents (id, json) VALUES (?, ?)');
    for (const a of store.agents.values()) insAgent.run(a.id, JSON.stringify(a));
    const insOp = db.prepare('INSERT INTO operations (id, task_id, json) VALUES (?, ?, ?)');
    for (const o of store.operations.values()) insOp.run(o.id, o.taskId, JSON.stringify(o));
    const insEvt = db.prepare('INSERT INTO events (id, task_id, seq, json) VALUES (?, ?, ?, ?)');
    for (const e of store.events) insEvt.run(e.id, e.taskId, e.seq, JSON.stringify(e));
    const insConv = db.prepare('INSERT INTO conversation (id, task_id, json) VALUES (?, ?, ?)');
    for (const m of store.conversation) insConv.run(m.id, m.taskId, JSON.stringify(m));
    const insCp = db.prepare('INSERT INTO checkpoints (task_id, revision, json) VALUES (?, ?, ?)');
    for (const [taskId, cps] of store.checkpoints) {
      for (const c of cps) insCp.run(taskId, c.revision, JSON.stringify(c));
    }
    const insMsg = db.prepare('INSERT INTO messages (id, recipient, json) VALUES (?, ?, ?)');
    for (const m of store.messages.values()) insMsg.run(m.id, (m.to as string) ?? '', JSON.stringify(m));
    const insDel = db.prepare('INSERT INTO delivered (agent_id, message_id) VALUES (?, ?)');
    for (const [agentId, set] of store.delivered) {
      for (const mid of set) insDel.run(agentId, mid);
    }
    const insArt = db.prepare('INSERT INTO artifacts (id, task_id, json) VALUES (?, ?, ?)');
    for (const a of store.artifacts.values()) insArt.run(a.id, a.taskId, JSON.stringify(a));
    const insSrc = db.prepare('INSERT INTO sources (id, task_id, json) VALUES (?, ?, ?)');
    for (const s of store.sources.values()) insSrc.run(s.id, s.taskId, JSON.stringify(s));
    const insGrant = db.prepare('INSERT INTO grants (id, json) VALUES (?, ?)');
    for (const g of store.grants.values()) insGrant.run(g.id, JSON.stringify(g));
    const insAppr = db.prepare('INSERT INTO approvals (id, task_id, json) VALUES (?, ?, ?)');
    for (const a of store.approvals.values()) insAppr.run(a.id, a.taskId, JSON.stringify(a));
    const insExt = db.prepare('INSERT INTO externals (task_id, op_id, json) VALUES (?, ?, ?)');
    for (const h of store.externalHandles.values()) {
      insExt.run((h.taskId as string) ?? '', (h.operationId as string) ?? '', JSON.stringify(h));
    }
    const insQ = db.prepare('INSERT INTO queue (agent_id, json) VALUES (?, ?)');
    for (const q of store.queue.values()) insQ.run(q.agentId, JSON.stringify(q));
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}

/** Restore a store from SQLite. Returns a new DurableStore. */
export function loadStore(db: SqliteDatabase): DurableStore {
  const store = new DurableStore();
  const col = (table: string): string[] =>
    (db.prepare(`SELECT json FROM ${table}`).all() as { json: string }[]).map((r) => r.json);
  for (const j of col('projects')) {
    const p = JSON.parse(j) as { id: string };
    store.projects.set(p.id, p as never);
  }
  for (const j of col('tasks')) {
    const t = JSON.parse(j) as { id: string };
    store.tasks.set(t.id, t as never);
  }
  for (const j of col('agents')) {
    const a = JSON.parse(j) as { id: string };
    store.agents.set(a.id, a as never);
  }
  for (const j of col('operations')) {
    const o = JSON.parse(j) as { id: string };
    store.operations.set(o.id, o as never);
  }
  for (const j of col('events')) {
    store.events.push(JSON.parse(j) as never);
  }
  store.events.sort((a, b) => (a.taskId < (b as unknown as { taskId: string }).taskId ? -1 : 1) || (a.seq - (b as unknown as { seq: number }).seq));
  for (const j of col('conversation')) {
    store.conversation.push(JSON.parse(j) as never);
  }
  for (const j of col('checkpoints')) {
    const c = JSON.parse(j) as { taskId: string };
    const list = store.checkpoints.get(c.taskId) ?? [];
    list.push(c as never);
    store.checkpoints.set(c.taskId, list);
  }
  for (const j of col('messages')) {
    const m = JSON.parse(j) as { id: string };
    store.messages.set(m.id, m as never);
  }
  for (const row of db.prepare('SELECT agent_id, message_id FROM delivered').all() as { agent_id: string; message_id: string }[]) {
    let set = store.delivered.get(row.agent_id);
    if (!set) {
      set = new Set();
      store.delivered.set(row.agent_id, set);
    }
    set.add(row.message_id);
  }
  for (const j of col('artifacts')) {
    const a = JSON.parse(j) as { id: string };
    store.artifacts.set(a.id, a as never);
  }
  for (const j of col('sources')) {
    const s = JSON.parse(j) as { id: string };
    store.sources.set(s.id, s as never);
  }
  for (const j of col('grants')) {
    const g = JSON.parse(j) as { id: string };
    store.grants.set(g.id, g as never);
  }
  for (const j of col('approvals')) {
    const a = JSON.parse(j) as { id: string };
    store.approvals.set(a.id, a as never);
  }
  for (const j of col('externals')) {
    const h = JSON.parse(j) as { taskId: string; operationId: string };
    store.externalHandles.set(`${h.taskId}:${h.operationId}`, h as never);
  }
  for (const j of col('queue')) {
    const q = JSON.parse(j) as { agentId: string };
    store.queue.set(q.agentId, q as never);
  }
  return store;
}
