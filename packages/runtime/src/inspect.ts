// Inspection queries for UI clients (spec §3.7, §18).
// Read-only views over durable state: what is running, what was used,
// what is blocked and why. The side panel and dashboard render these;
// they never mutate state (except through the service methods).
import type {
  Agent,
  Approval,
  Artifact,
  CapabilityGrant,
  Operation,
  Source,
  Task,
  TaskEvent,
  TaskId,
} from '@cabot/contracts';
import { DurableStore } from '@cabot/storage/browser-chrome';

export interface TaskDetail {
  task: Task;
  agents: Agent[];
  events: TaskEvent[];
  operations: Operation[];
  approvals: Approval[];
  sources: Source[];
  artifacts: Artifact[];
  grants: CapabilityGrant[];
}

export interface ApprovalInboxItem extends Approval {
  taskTitle: string;
  agentRole: string;
}

export interface DashboardSummary {
  tasksByStatus: Record<string, number>;
  pendingApprovals: number;
  activeAgents: number;
  blockedTasks: { id: string; title: string; status: string }[];
}

export function getTaskDetail(store: DurableStore, taskId: TaskId, eventLimit = 50): TaskDetail {
  const task = store.tasks.get(taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  const agentIds = new Set<string>([task.ownerAgentId]);
  for (const op of store.operations.values()) {
    if (op.taskId === taskId) agentIds.add(op.agentId);
  }
  return {
    task: { ...task },
    agents: [...agentIds].flatMap((id) => {
      const a = store.agents.get(id);
      return a ? [{ ...a, spent: { ...a.spent } }] : [];
    }),
    events: store.events.filter((e) => e.taskId === taskId).slice(-eventLimit),
    operations: [...store.operations.values()].filter((o) => o.taskId === taskId),
    approvals: [...store.approvals.values()].filter((a) => a.taskId === taskId),
    sources: [...store.sources.values()].filter((s) => s.taskId === taskId),
    artifacts: [...store.artifacts.values()].filter((a) => a.taskId === taskId),
    grants: [...store.grants.values()].filter(
      (g) => g.taskId === taskId || (g.projectId === task.projectId && (g.scope === 'project' || g.scope === 'persistent-allow')),
    ),
  };
}

export function listPendingApprovals(store: DurableStore): ApprovalInboxItem[] {
  return [...store.approvals.values()]
    .filter((a) => !a.decision)
    .map((a) => ({
      ...a,
      taskTitle: store.tasks.get(a.taskId)?.title ?? '(unknown task)',
      agentRole: store.agents.get(a.agentId)?.role ?? '(unknown agent)',
    }))
    .sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
}

export function getDashboard(store: DurableStore): DashboardSummary {
  const tasksByStatus: Record<string, number> = {};
  const blockedTasks: { id: string; title: string; status: string }[] = [];
  for (const t of store.tasks.values()) {
    tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;
    if (['BLOCKED', 'APPROVAL_REQUIRED', 'INTERRUPTED'].includes(t.status)) {
      blockedTasks.push({ id: t.id, title: t.title, status: t.status });
    }
  }
  return {
    tasksByStatus,
    pendingApprovals: [...store.approvals.values()].filter((a) => !a.decision).length,
    activeAgents: [...store.agents.values()].filter((a) => ['RUNNING', 'WAITING_FOR_TOOL', 'WAITING_FOR_MODEL', 'WAITING_FOR_AGENT'].includes(a.status)).length,
    blockedTasks,
  };
}
