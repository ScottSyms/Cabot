// In-memory durable store modeling SQLite-backed semantics.
// All multi-record mutations commit atomically via `transaction()`.
// Later backed by SQLite-WASM owned by Storage Worker; same invariants.
import type {
  Agent,
  AgentId,
  AgentMessage,
  AgentStatus,
  Approval,
  Artifact,
  BudgetReservation,
  CapabilityGrant,
  Checkpoint,
  ConversationMessage,
  ConversationRole,
  ExternalTaskHandle,
  Operation,
  OperationId,
  OperationStatus,
  Project,
  ProjectId,
  QueueEntry,
  Source,
  Task,
  TaskEvent,
  TaskId,
  TaskStatus,
} from '@cabot/contracts';
import { canTransitionTask, terminalAgentStatus, terminalTaskStatus } from '@cabot/contracts';

export interface CommitRecord {
  taskId: TaskId;
  revision: number;
  eventSeq: number;
}

let seq = 0;
export function newId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Dependency-free content hash for provenance/dedup (non-cryptographic). */
export function contentHashHex(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** Pure-TypeScript SHA-256 (browser-safe; no node:crypto). */
export function sha256HexBytes(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const bitLen = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLen >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLen / 0x100000000), false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Int32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < paddedLength; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(off + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA256_K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

export class StoreError extends Error {}

export const CONVERSATION_PER_TASK_CAP = 500;
export const CONVERSATION_GLOBAL_CAP = 5000;
/** Tool outputs are truncated to keep snapshot size and model context bounded. */
export const CONVERSATION_RESULT_CAP = 4000;

export class DurableStore {
  projects = new Map<string, Project>();
  tasks = new Map<TaskId, Task>();
  agents = new Map<AgentId, Agent>();
  operations = new Map<OperationId, Operation>();
  events: TaskEvent[] = [];
  conversation: ConversationMessage[] = [];
  checkpoints = new Map<TaskId, Checkpoint[]>();
  messages = new Map<string, AgentMessage>();
  // per-recipient delivery cursor set (message ids delivered)
  delivered = new Map<AgentId, Set<string>>();
  artifacts = new Map<string, Artifact>();
  sources = new Map<string, Source>();
  grants = new Map<string, CapabilityGrant>();
  approvals = new Map<string, Approval>();
  externalHandles = new Map<string, ExternalTaskHandle>();
  queue = new Map<AgentId, QueueEntry>();

  // ---- transactions: run fn; on throw, restore snapshot ----
  transaction<T>(fn: () => T): T {
    const snap = this.snapshot();
    try {
      return fn();
    } catch (e) {
      this.restore(snap);
      throw e;
    }
  }

  private snapshot() {
    return {
      projects: new Map(this.projects),
      tasks: new Map(this.tasks),
      agents: new Map<AgentId, Agent>(
        [...this.agents].map(([k, v]) => [
          k,
          { ...v, skillIds: [...v.skillIds], workspaceMounts: [...v.workspaceMounts], spent: { ...v.spent }, modelConfig: { ...v.modelConfig }, budget: { ...v.budget } },
        ]),
      ),
      operations: new Map(this.operations),
      events: [...this.events],
      conversation: [...this.conversation],
      checkpoints: new Map([...this.checkpoints].map(([k, v]) => [k, [...v]] as [string, Checkpoint[]])),
      messages: new Map(this.messages),
      delivered: new Map([...this.delivered].map(([k, v]) => [k, new Set(v)] as [string, Set<string>])),
      artifacts: new Map(this.artifacts),
      sources: new Map(this.sources),
      grants: new Map(this.grants),
      approvals: new Map(this.approvals),
      externalHandles: new Map(this.externalHandles),
      queue: new Map(this.queue),
    };
  }

  private restore(s: ReturnType<DurableStore['snapshot']>) {
    this.projects = s.projects;
    this.tasks = s.tasks;
    this.agents = s.agents;
    this.operations = s.operations;
    this.events = s.events;
    this.conversation = s.conversation;
    this.checkpoints = s.checkpoints;
    this.messages = s.messages;
    this.delivered = s.delivered;
    this.artifacts = s.artifacts;
    this.sources = s.sources;
    this.grants = s.grants;
    this.approvals = s.approvals;
    this.externalHandles = s.externalHandles;
    this.queue = s.queue;
  }

  createProject(name: string): Project {
    const p: Project = { id: newId('proj'), name, createdAt: nowIso(), updatedAt: nowIso() };
    this.projects.set(p.id, p);
    return p;
  }

  createAgent(a: Omit<Agent, 'id' | 'createdAt' | 'updatedAt' | 'checkpointRevision' | 'spent' | 'mailboxCursor'> & { id?: string }): Agent {
    const agent: Agent = {
      ...a,
      id: a.id ?? newId('agent'),
      spent: { modelCalls: 0, toolCalls: 0, runtimeMs: 0, costUsd: 0, delegations: 0, browserNavigations: 0, computeMs: 0 },
      mailboxCursor: '',
      checkpointRevision: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.agents.set(agent.id, agent);
    this.queue.set(agent.id, { agentId: agent.id, runnableAt: nowIso(), fenceToken: 1 });
    return agent;
  }

  createTask(t: { projectId: ProjectId; ownerAgentId: AgentId; title: string; objective: string }): Task {
    const task: Task = {
      id: newId('task'),
      projectId: t.projectId,
      ownerAgentId: t.ownerAgentId,
      title: t.title,
      objective: t.objective,
      status: 'CREATED',
      checkpointRevision: 0,
      planRevision: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.tasks.set(task.id, task);
    this.appendEvent(task.id, 'task.created', `Task created: ${t.title}`);
    return task;
  }

  transitionTask(taskId: TaskId, to: TaskStatus, summary: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new StoreError(`unknown task ${taskId}`);
    if (!canTransitionTask(task.status, to)) {
      throw new StoreError(`illegal task transition ${task.status} -> ${to}`);
    }
    return this.transaction(() => {
      task.status = to;
      task.updatedAt = nowIso();
      this.appendEvent(taskId, 'task.transition', summary);
      this.commitCheckpoint(taskId);
      return task;
    });
  }

  appendEvent(taskId: TaskId, type: string, summary: string): TaskEvent {
    const seqN = this.events.filter((e) => e.taskId === taskId).length + 1;
    const ev: TaskEvent = { id: newId('evt'), taskId, seq: seqN, type, summary, createdAt: nowIso() };
    this.events.push(ev);
    return ev;
  }

  /**
   * Append a user-facing conversation message. Caps keep snapshots bounded:
   * 500 per task, 5,000 globally with oldest-completed-tasks trimmed first.
   */
  appendConversation(
    taskId: TaskId,
    agentId: AgentId,
    role: ConversationRole,
    text: string,
    extra?: { toolId?: string; ok?: boolean; result?: string },
  ): ConversationMessage {
    const msg: ConversationMessage = {
      id: newId('cmsg'),
      taskId,
      agentId,
      role,
      text: text.slice(0, 8000),
      toolId: extra?.toolId,
      ok: extra?.ok,
      result: extra?.result?.slice(0, CONVERSATION_RESULT_CAP),
      createdAt: nowIso(),
    };
    this.conversation.push(msg);
    this.enforceConversationCaps(taskId);
    return msg;
  }

  forTaskConversation(taskId: TaskId, limit = 200): ConversationMessage[] {
    return this.conversation.filter((m) => m.taskId === taskId).slice(-limit);
  }

  private enforceConversationCaps(activeTaskId: TaskId): void {
    let trimmed = 0;
    const forTask = this.conversation.filter((m) => m.taskId === activeTaskId);
    if (forTask.length > CONVERSATION_PER_TASK_CAP) {
      const drop = new Set(forTask.slice(0, forTask.length - CONVERSATION_PER_TASK_CAP).map((m) => m.id));
      this.conversation = this.conversation.filter((m) => !drop.has(m.id));
      trimmed += drop.size;
    }
    while (this.conversation.length > CONVERSATION_GLOBAL_CAP) {
      const idx = this.conversation.findIndex((m) => {
        const t = this.tasks.get(m.taskId);
        return m.taskId !== activeTaskId && t && ['COMPLETE', 'FAILED', 'CANCELLED'].includes(t.status);
      });
      const victim = idx >= 0 ? idx : this.conversation.findIndex((m) => m.taskId !== activeTaskId);
      if (victim < 0) break; // only the active task remains; keep it intact
      this.conversation.splice(victim, 1);
      trimmed += 1;
    }
    if (trimmed > 0) {
      this.appendEvent(activeTaskId, 'conversation.trimmed', `dropped ${trimmed} oldest messages over cap`);
    }
  }

  commitCheckpoint(taskId: TaskId): Checkpoint {
    const task = this.tasks.get(taskId);
    if (!task) throw new StoreError(`unknown task ${taskId}`);
    task.checkpointRevision += 1;
    const rev = task.checkpointRevision;
    const cps = this.checkpoints.get(taskId) ?? [];
    const cp: Checkpoint = {
      taskId,
      revision: rev,
      taskStatus: task.status,
      planRevision: task.planRevision,
      createdAt: nowIso(),
      stateHash: `hash:${taskId}:${rev}`,
    };
    cps.push(cp);
    this.checkpoints.set(taskId, cps);
    this.events.push({ id: newId('evt'), taskId, seq: this.events.filter((e) => e.taskId === taskId).length + 1, type: 'checkpoint.committed', summary: `checkpoint r${rev}`, createdAt: nowIso() });
    return cp;
  }

  // ---- operations: persist intent before dispatch ----
  prepareOperation(o: { taskId: TaskId; agentId: AgentId; toolId: string; argsHash: string; idempotencyKey: string; approvalId?: string }): Operation {
    for (const existing of this.operations.values()) {
      if (existing.idempotencyKey === o.idempotencyKey && existing.taskId === o.taskId) {
        return existing; // idempotent prepare
      }
    }
    const op: Operation = { id: newId('op'), status: 'PREPARED', attempt: 0, createdAt: nowIso(), updatedAt: nowIso(), ...o };
    this.operations.set(op.id, op);
    this.appendEvent(o.taskId, 'tool.requested', `${o.toolId} prepared ${op.id}`);
    return op;
  }

  markDispatched(opId: OperationId): Operation {
    const op = this.operations.get(opId);
    if (!op) throw new StoreError(`unknown operation ${opId}`);
    if (op.status !== 'PREPARED') throw new StoreError(`cannot dispatch from ${op.status}`);
    op.status = 'DISPATCHED';
    op.attempt += 1;
    op.updatedAt = nowIso();
    this.appendEvent(op.taskId, 'tool.started', `${op.toolId} dispatched attempt ${op.attempt}`);
    return op;
  }

  settleOperation(opId: OperationId, status: Exclude<OperationStatus, 'PREPARED' | 'DISPATCHED'>, extra?: { resultHash?: string; error?: string }): Operation {
    const op = this.operations.get(opId);
    if (!op) throw new StoreError(`unknown operation ${opId}`);
    if (op.status !== 'DISPATCHED') throw new StoreError(`cannot settle from ${op.status}`);
    op.status = status;
    if (extra?.resultHash) op.resultHash = extra.resultHash;
    if (extra?.error) op.error = extra.error;
    op.updatedAt = nowIso();
    const detail = status === 'SUCCEEDED' ? 'tool.completed' : 'tool.failed';
    this.appendEvent(op.taskId, detail, extra?.error ? `${op.toolId} ${status}: ${extra.error}` : `${op.toolId} ${status}`);
    this.commitCheckpoint(op.taskId);
    return op;
  }

  /** Recovery: anything still DISPATCHED after a restart becomes UNCERTAIN. Never auto-replay. */
  reconcileAfterRestart(): Operation[] {
    const uncertain: Operation[] = [];
    for (const op of this.operations.values()) {
      if (op.status === 'DISPATCHED') {
        op.status = 'UNCERTAIN';
        op.updatedAt = nowIso();
        uncertain.push(op);
        this.appendEvent(op.taskId, 'tool.failed', `${op.toolId} uncertain after restart — requires explicit recovery`);
      }
    }
    // interrupted tasks
    for (const task of this.tasks.values()) {
      if (!terminalTaskStatus(task.status) && !['BLOCKED', 'SUSPENDED', 'APPROVAL_REQUIRED'].includes(task.status)) {
        const from = task.status;
        task.status = 'INTERRUPTED';
        task.updatedAt = nowIso();
        this.appendEvent(task.id, 'task.interrupted', `marked INTERRUPTED (was ${from})`);
      }
    }
    return uncertain;
  }

  // ---- artifact publication: staged blob -> verified commit ----
  stageArtifact(a: Omit<Artifact, 'id' | 'createdAt' | 'staged'>): Artifact {
    const art: Artifact = { ...a, id: newId('art'), staged: true, createdAt: nowIso() };
    this.artifacts.set(art.id, art);
    return art;
  }

  publishArtifact(artifactId: string, expectedBytes: number, expectedSha256: string): Artifact {
    return this.transaction(() => {
      const art = this.artifacts.get(artifactId);
      if (!art) throw new StoreError(`unknown artifact ${artifactId}`);
      if (!art.staged) throw new StoreError(`artifact already published`);
      if (art.bytes !== expectedBytes || art.sha256 !== expectedSha256) {
        throw new StoreError(`artifact verification failed for ${artifactId}`);
      }
      art.staged = false;
      this.appendEvent(art.taskId, 'artifact.created', `${art.path} (${art.bytes}b)`);
      this.commitCheckpoint(art.taskId);
      return art;
    });
  }

  /** GC helper: unreferenced staged blobs after interruption. */
  listOrphanStaged(): Artifact[] {
    return [...this.artifacts.values()].filter((a) => a.staged);
  }

  /** Durably record a captured source with origin provenance. */
  captureSource(s: Omit<Source, 'id' | 'capturedAt'>): Source {
    return this.transaction(() => {
      const full: Source = { ...s, id: newId('src'), capturedAt: nowIso() };
      this.sources.set(full.id, full);
      this.appendEvent(s.taskId, 'source.captured', `${s.uri} (${s.sha256.slice(0, 12)})`);
      this.commitCheckpoint(s.taskId);
      return full;
    });
  }

  // ---- mailbox: at-least-once with dedup ----
  sendMessage(m: Omit<AgentMessage, 'id' | 'createdAt'> & { id?: string }): AgentMessage {
    const msg: AgentMessage = { ...m, id: m.id ?? newId('msg'), createdAt: nowIso() };
    if (this.messages.has(msg.id)) return this.messages.get(msg.id)!; // dedup
    this.messages.set(msg.id, msg);
    return msg;
  }

  inbox(agentId: AgentId): AgentMessage[] {
    const deliveredSet = this.delivered.get(agentId) ?? new Set<string>();
    return [...this.messages.values()].filter((m) => m.to === agentId && !deliveredSet.has(m.id));
  }

  ack(agentId: AgentId, messageId: string): void {
    let set = this.delivered.get(agentId);
    if (!set) {
      set = new Set();
      this.delivered.set(agentId, set);
    }
    set.add(messageId);
    const agent = this.agents.get(agentId);
    if (agent) agent.mailboxCursor = messageId;
  }

  // ---- budgets: transactional reservation ----
  reserve(r: BudgetReservation): void {
    this.transaction(() => {
      const agent = this.agents.get(r.agentId);
      if (!agent) throw new StoreError(`unknown agent ${r.agentId}`);
      const limit = agent.budget[this.mapBudgetKey(r.kind)];
      const spent = agent.spent[r.kind] + r.amount;
      if (limit !== undefined && spent > limit) {
        throw new StoreError(`budget exceeded for ${r.kind}: ${spent} > ${limit}`);
      }
      agent.spent[r.kind] = spent;
      agent.updatedAt = nowIso();
    });
  }

  private mapBudgetKey(kind: keyof Agent['spent']): keyof Agent['budget'] {
    switch (kind) {
      case 'modelCalls': return 'maxModelCalls';
      case 'toolCalls': return 'maxToolCalls';
      case 'runtimeMs': return 'maxRuntimeMs';
      case 'costUsd': return 'maxCostUsd';
      case 'delegations': return 'maxDelegations';
      case 'browserNavigations': return 'maxBrowserNavigations';
      case 'computeMs': return 'maxComputeMs';
    }
  }

  setAgentStatus(agentId: AgentId, status: AgentStatus): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new StoreError(`unknown agent ${agentId}`);
    agent.status = status;
    agent.updatedAt = nowIso();
    return agent;
  }

  /**
   * Remove a finished agent from history, purging its owned tasks and every
   * dependent record in one transaction. Refuses while the agent, any owned
   * task, or any descendant agent is still non-terminal — deletion must never
   * race live work. Descendant agents are purged with the parent only when
   * the whole subtree is terminal.
   */
  purgeAgent(agentId: AgentId): { removedAgents: number; removedTasks: number; removedMessages: number } {
    const agent = this.agents.get(agentId);
    if (!agent) throw new StoreError(`unknown agent ${agentId}`);
    if (!terminalAgentStatus(agent.status)) {
      throw new StoreError(`cannot remove agent ${agentId}: status ${agent.status} is not terminal`);
    }
    // Validate the whole subtree before mutating anything.
    const subtree: AgentId[] = [];
    const visit = (id: AgentId): void => {
      const a = this.agents.get(id);
      if (!a) return;
      if (!terminalAgentStatus(a.status)) {
        throw new StoreError(`cannot remove agent ${agentId}: descendant ${id} is ${a.status}, not terminal`);
      }
      subtree.push(id);
      for (const child of this.agents.values()) {
        if (child.parentAgentId === id) visit(child.id);
      }
    };
    visit(agentId);
    for (const id of subtree) {
      for (const t of this.tasks.values()) {
        if (t.ownerAgentId === id && !terminalTaskStatus(t.status)) {
          throw new StoreError(`cannot remove agent ${agentId}: task ${t.id} is ${t.status}, not terminal`);
        }
      }
    }

    return this.transaction(() => {
      const ids = new Set(subtree);
      const taskIds = new Set(
        [...this.tasks.values()].filter((t) => ids.has(t.ownerAgentId)).map((t) => t.id),
      );
      for (const tid of taskIds) {
        this.tasks.delete(tid);
        this.events = this.events.filter((e) => e.taskId !== tid);
        this.conversation = this.conversation.filter((m) => m.taskId !== tid);
        this.checkpoints.delete(tid);
      }
      for (const [id, op] of [...this.operations]) if (taskIds.has(op.taskId)) this.operations.delete(id);
      for (const [id, a] of [...this.approvals]) if (taskIds.has(a.taskId)) this.approvals.delete(id);
      for (const [id, s] of [...this.sources]) if (taskIds.has(s.taskId)) this.sources.delete(id);
      for (const [id, art] of [...this.artifacts]) if (taskIds.has(art.taskId)) this.artifacts.delete(id);
      for (const [key, h] of [...this.externalHandles]) if (taskIds.has(h.taskId)) this.externalHandles.delete(key);
      for (const [id, g] of [...this.grants]) {
        if (g.taskId && taskIds.has(g.taskId)) this.grants.delete(id);
      }
      let removedMessages = 0;
      for (const [id, m] of [...this.messages]) {
        if (ids.has(m.to) || ids.has(m.from)) {
          this.messages.delete(id);
          removedMessages += 1;
        }
      }
      for (const id of ids) {
        this.agents.delete(id);
        this.queue.delete(id);
        this.delivered.delete(id);
      }
      return { removedAgents: ids.size, removedTasks: taskIds.size, removedMessages };
    });
  }

  // ---- runnable queue with leases + fencing ----
  acquireRunnable(concurrency: number): QueueEntry | undefined {
    const active = [...this.queue.values()].filter((q) => q.leaseId && q.leaseExpiresAt && q.leaseExpiresAt > nowIso());
    if (active.length >= concurrency) return undefined;
    const waiting = [...this.queue.values()]
      .filter((q) => !q.leaseId || (q.leaseExpiresAt && q.leaseExpiresAt <= nowIso()))
      .filter((q) => {
        const a = this.agents.get(q.agentId);
        return a && !['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(a.status);
      })
      .sort((a, b) => (a.runnableAt < b.runnableAt ? -1 : 1));
    const next = waiting[0];
    if (!next) return undefined;
    next.leaseId = newId('lease');
    next.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    next.fenceToken += 1;
    return { ...next };
  }

  release(agentId: AgentId, leaseId: string): void {
    const q = this.queue.get(agentId);
    if (q && q.leaseId === leaseId) {
      q.leaseId = undefined;
      q.leaseExpiresAt = undefined;
    }
  }
}
