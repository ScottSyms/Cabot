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
  ExternalTaskHandle,
  Operation,
  OperationId,
  OperationStatus,
  Project,
  ProjectId,
  QueueEntry,
  Task,
  TaskEvent,
  TaskId,
  TaskStatus,
} from '@cabot/contracts';
import { canTransitionTask, terminalTaskStatus } from '@cabot/contracts';

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

export class StoreError extends Error {}

export class DurableStore {
  projects = new Map<string, Project>();
  tasks = new Map<TaskId, Task>();
  agents = new Map<AgentId, Agent>();
  operations = new Map<OperationId, Operation>();
  events: TaskEvent[] = [];
  checkpoints = new Map<TaskId, Checkpoint[]>();
  messages = new Map<string, AgentMessage>();
  // per-recipient delivery cursor set (message ids delivered)
  delivered = new Map<AgentId, Set<string>>();
  artifacts = new Map<string, Artifact>();
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
      checkpoints: new Map([...this.checkpoints].map(([k, v]) => [k, [...v]] as [string, Checkpoint[]])),
      messages: new Map(this.messages),
      delivered: new Map([...this.delivered].map(([k, v]) => [k, new Set(v)] as [string, Set<string>])),
      artifacts: new Map(this.artifacts),
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
    this.checkpoints = s.checkpoints;
    this.messages = s.messages;
    this.delivered = s.delivered;
    this.artifacts = s.artifacts;
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
    this.appendEvent(op.taskId, status === 'SUCCEEDED' ? 'tool.completed' : 'tool.failed', `${op.toolId} ${status}`);
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
