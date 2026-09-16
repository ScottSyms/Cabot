// Stable internal API between UI clients and the runtime (spec §19).
// The side panel consumes this; it holds no agent logic itself.
import type { Agent, AgentId, ProjectId, Task, TaskId } from '@cabot/contracts';
import type { ModelProvider } from '@cabot/providers';
import { DurableStore } from '@cabot/storage';
import { CapabilityBroker } from '@cabot/policy';
import { runUntilSettled, type ToolExecutor } from './loop.js';

export class CabotRuntimeService {
  constructor(
    private store: DurableStore,
    private broker: CapabilityBroker,
    private model: ModelProvider,
    private executor?: ToolExecutor,
  ) {}

  createProject(name: string): string {
    return this.store.createProject(name).id;
  }

  createTask(projectId: ProjectId, ownerAgentId: AgentId, title: string, objective: string): TaskId {
    return this.store.createTask({ projectId, ownerAgentId, title, objective }).id;
  }

  createAgent(a: Omit<Agent, 'id' | 'createdAt' | 'updatedAt' | 'checkpointRevision' | 'spent' | 'mailboxCursor'>): AgentId {
    return this.store.createAgent(a).id;
  }

  /** Brokered delegation: child receives only explicitly delegated fields. */
  spawnChild(parentId: AgentId, spec: { role: string; objective: string; skills: string[] }): AgentId {
    const parent = this.store.agents.get(parentId);
    if (!parent) throw new Error(`unknown parent ${parentId}`);
    const auth = this.broker.authorizeSpawn(parentId, { skills: spec.skills, budget: {} });
    if (!auth.allowed) throw new Error(`spawn denied: ${auth.reason}`);
    const child = this.store.createAgent({
      projectId: parent.projectId,
      parentAgentId: parentId,
      role: spec.role,
      objective: spec.objective,
      status: 'READY',
      modelConfig: parent.modelConfig,
      skillIds: [...spec.skills],
      budget: {},
      workspaceMounts: [],
      delegationDepth: parent.delegationDepth + 1,
    });
    this.store.appendEvent(parent.projectId as unknown as TaskId, 'subtask.created', `${child.id} spawned from ${parentId}`);
    return child.id;
  }

  pauseTask(taskId: TaskId): void {
    const t = this.store.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    if (t.status === 'RUNNING') this.store.transitionTask(taskId, 'SUSPENDED', 'paused by user');
  }

  resumeTask(taskId: TaskId): void {
    const t = this.store.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    if (['SUSPENDED', 'INTERRUPTED', 'BLOCKED'].includes(t.status)) {
      this.store.transitionTask(taskId, 'READY', 'resumed by user');
    }
  }

  cancelTask(taskId: TaskId): void {
    const t = this.store.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    if (t.status === 'CREATED' || t.status === 'READY' || t.status === 'SUSPENDED') {
      this.store.transitionTask(taskId, 'CANCELLED', 'cancelled by user');
    } else if (!['COMPLETE', 'FAILED', 'CANCELLED'].includes(t.status)) {
      // Best-effort cancel from active states: mark then cancel.
      this.store.appendEvent(taskId, 'task.cancel-requested', 'cancel requested by user');
      this.store.commitCheckpoint(taskId);
    }
  }

  inspectTask(taskId: TaskId): Task {
    const t = this.store.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    return { ...t };
  }

  listTasks(): Task[] {
    return [...this.store.tasks.values()];
  }

  inspectAgent(agentId: AgentId): Agent {
    const a = this.store.agents.get(agentId);
    if (!a) throw new Error(`unknown agent ${agentId}`);
    return { ...a, spent: { ...a.spent } };
  }

  /** Run the checkpointed loop for a task (offscreen worker entry point). */
  async runTask(taskId: TaskId, agentId: AgentId, maxTurns = 25) {
    const executor = this.executor ?? { execute: async () => ({ ok: true }) };
    const task = this.store.tasks.get(taskId);
    if (task?.status === 'CREATED') this.store.transitionTask(taskId, 'READY', 'auto-ready');
    if (this.store.tasks.get(taskId)?.status === 'READY') this.store.transitionTask(taskId, 'RUNNING', 'auto-run');
    return runUntilSettled(this.store, this.broker, this.model, executor, taskId, agentId, maxTurns);
  }
}
