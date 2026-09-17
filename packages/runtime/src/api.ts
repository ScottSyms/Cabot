// Stable internal API between UI clients and the runtime (spec §19).
// The side panel consumes this; it holds no agent logic itself.
import type { Agent, AgentId, ProjectId, Task, TaskId } from '@cabot/contracts';
import type { ModelProvider } from '@cabot/providers';
import { DurableStore } from '@cabot/storage/browser-chrome';
import { CapabilityBroker } from '@cabot/policy';
import { runUntilSettled, syncAgentToTask, type ToolExecutor } from './loop.js';
import {
  getDashboard,
  getTaskDetail,
  listPendingApprovals,
  type ApprovalInboxItem,
  type DashboardSummary,
  type TaskDetail,
} from './inspect.js';

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
    syncAgentToTask(this.store, taskId, t.ownerAgentId);
  }

  resumeTask(taskId: TaskId): void {
    const t = this.store.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    if (['SUSPENDED', 'INTERRUPTED', 'BLOCKED'].includes(t.status)) {
      this.store.transitionTask(taskId, 'READY', 'resumed by user');
    }
    syncAgentToTask(this.store, taskId, t.ownerAgentId);
  }

  cancelTask(taskId: TaskId): void {
    const t = this.store.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    if (['COMPLETE', 'FAILED', 'CANCELLED'].includes(t.status)) return;
    // Parked tasks have no running loop to observe a request: cancel directly.
    if (['CREATED', 'READY', 'SUSPENDED', 'APPROVAL_REQUIRED', 'BLOCKED', 'INTERRUPTED'].includes(t.status)) {
      this.store.transitionTask(taskId, 'CANCELLED', 'cancelled by user');
      syncAgentToTask(this.store, taskId, t.ownerAgentId);
      return;
    }
    // Active task: request cancellation; the loop honours it at the next
    // turn boundary and never mid-dispatch.
    this.store.appendEvent(taskId, 'task.cancel-requested', 'cancel requested by user');
    this.store.commitCheckpoint(taskId);
  }

  /**
   * Cancel immediately, for when no loop is in flight to observe a request
   * (e.g. the run already returned but the task stayed non-terminal). Safe
   * against a live loop too: the loop re-reads task status each turn and
   * exits when it sees CANCELLED.
   */
  cancelTaskNow(taskId: TaskId): void {
    const t = this.store.tasks.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    if (['COMPLETE', 'FAILED', 'CANCELLED'].includes(t.status)) return;
    try {
      this.store.transitionTask(taskId, 'CANCELLED', 'cancelled by user');
    } catch {
      // States without a direct CANCELLED transition (e.g. CHECKPOINTING):
      // fall back to a request that recovery will settle.
      this.store.appendEvent(taskId, 'task.cancel-requested', 'cancel requested by user');
      this.store.commitCheckpoint(taskId);
    }
    syncAgentToTask(this.store, taskId, t.ownerAgentId);
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

  listAgents(projectId?: ProjectId): Agent[] {
    return [...this.store.agents.values()]
      .filter((a) => !projectId || a.projectId === projectId)
      .map((a) => ({ ...a, spent: { ...a.spent } }));
  }

  /**
   * Remove a finished agent (and its tasks/transcript) from history.
   * Refused for anything still active — see DurableStore.purgeAgent.
   */
  removeAgent(agentId: AgentId): { removedAgents: number; removedTasks: number; removedMessages: number } {
    return this.store.purgeAgent(agentId);
  }

  // ---- inspection (read-only; feeds side panel + dashboard) ----

  getTaskDetail(taskId: TaskId, eventLimit = 50): TaskDetail {
    return getTaskDetail(this.store, taskId, eventLimit);
  }

  listPendingApprovals(): ApprovalInboxItem[] {
    return listPendingApprovals(this.store);
  }

  getDashboard(): DashboardSummary {
    return getDashboard(this.store);
  }

  /**
   * Resolve an approval and move the parked task accordingly:
   * granted → back to RUNNING so the loop can dispatch under the binding;
   * denied → BLOCKED with the reason recorded, resumable by the user.
   */
  decideApproval(approvalId: string, decision: 'granted' | 'denied'): void {
    const approval = this.broker.decideApproval(approvalId, decision);
    const task = this.store.tasks.get(approval.taskId);
    if (!task || task.status !== 'APPROVAL_REQUIRED') return;
    if (decision === 'granted') {
      this.store.transitionTask(task.id, 'RUNNING', `approval granted for ${approval.toolId}`);
    } else {
      this.store.transitionTask(task.id, 'BLOCKED', `approval denied for ${approval.toolId}`);
    }
    syncAgentToTask(this.store, task.id, task.ownerAgentId);
  }

  /**
   * Steer an agent mid-task: records a user message the next model turn
   * will see via recent events. Rejects finished tasks. Wakes suspended,
   * blocked, or interrupted tasks back to READY so the loop can continue.
   */
  sendUserMessage(taskId: TaskId, text: string): void {
    const task = this.store.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (['COMPLETE', 'FAILED', 'CANCELLED'].includes(task.status)) {
      throw new Error(`task ${task.status}; start a new task instead`);
    }
    const trimmed = text.trim().slice(0, 4000);
    if (!trimmed) throw new Error('message is empty');
    this.store.appendEvent(taskId, 'user.message', trimmed);
    this.store.appendConversation(taskId, task.ownerAgentId, 'user', trimmed);
    if (['SUSPENDED', 'BLOCKED', 'INTERRUPTED'].includes(task.status)) {
      this.store.transitionTask(taskId, 'READY', 'resumed by user message');
    } else {
      this.store.commitCheckpoint(taskId);
    }
  }

  /**
   * Recover interrupted tasks after a runtime restart (spec §6.4). Tasks with
   * an UNCERTAIN operation are parked BLOCKED for explicit review; all others
   * return to READY so they can resume automatically. Returns resumable ids.
   */
  resumeInterruptedTasks(): TaskId[] {
    const resumed: TaskId[] = [];
    for (const task of this.store.tasks.values()) {
      if (task.status !== 'INTERRUPTED') continue;
      const uncertain = [...this.store.operations.values()].filter(
        (o) => o.taskId === task.id && o.status === 'UNCERTAIN',
      );
      if (uncertain.length > 0) {
        this.store.appendEvent(
          task.id,
          'task.blocked',
          `interrupted during ${uncertain[0].toolId}; result unknown — review before resuming`,
        );
        try {
          this.store.transitionTask(task.id, 'BLOCKED', 'interrupted with uncertain operation');
        } catch {
          this.store.commitCheckpoint(task.id);
        }
        syncAgentToTask(this.store, task.id, task.ownerAgentId);
        continue;
      }
      this.store.transitionTask(task.id, 'READY', 'auto-resumed after interruption');
      syncAgentToTask(this.store, task.id, task.ownerAgentId);
      resumed.push(task.id);
    }
    return resumed;
  }

  /** Run the checkpointed loop for a task (offscreen worker entry point). */
  async runTask(taskId: TaskId, agentId: AgentId, maxTurns = 25, onTurn?: () => void | Promise<void>) {
    const executor = this.executor ?? { execute: async () => ({ ok: true }) };
    const task = this.store.tasks.get(taskId);
    if (task?.status === 'CREATED') this.store.transitionTask(taskId, 'READY', 'auto-ready');
    if (this.store.tasks.get(taskId)?.status === 'READY') this.store.transitionTask(taskId, 'RUNNING', 'auto-run');
    try {
      return await runUntilSettled(this.store, this.broker, this.model, executor, taskId, agentId, maxTurns, onTurn);
    } finally {
      syncAgentToTask(this.store, taskId, agentId);
    }
  }
}
