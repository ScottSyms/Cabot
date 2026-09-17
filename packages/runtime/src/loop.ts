// Checkpointed agent loop (spec §8.1):
// load state → observe → model step → policy evaluation → execute
// tool/compute step → record result → checkpoint → repeat or suspend.
// Every turn commits to the store; a crash between turns resumes from the
// last checkpoint with no duplicated external effects.
import type { AgentId, TaskId } from '@cabot/contracts';
import type { ModelProvider } from '@cabot/providers';
import { DurableStore } from '@cabot/storage/browser-chrome';
import { CapabilityBroker } from '@cabot/policy';

export interface ToolExecution {
  ok: boolean;
  resultHash?: string;
  result?: unknown;
  error?: string;
}

export interface ToolExecutor {
  execute(toolId: string, args: unknown): Promise<ToolExecution>;
}

export type TurnOutcome =
  | { status: 'continue' }
  | { status: 'complete'; summary: string }
  | { status: 'approval-required'; approvalId: string }
  | { status: 'waiting-user'; reason: string }
  | { status: 'suspended'; reason: string };

export async function runAgentTurn(
  store: DurableStore,
  broker: CapabilityBroker,
  model: ModelProvider,
  executor: ToolExecutor,
  taskId: TaskId,
  agentId: AgentId,
): Promise<TurnOutcome> {
  const task = store.tasks.get(taskId);
  const agent = store.agents.get(agentId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  if (!agent) throw new Error(`unknown agent ${agentId}`);
  if (['COMPLETE', 'FAILED', 'CANCELLED'].includes(task.status)) return { status: 'suspended', reason: `task ${task.status}` };
  if (task.status === 'APPROVAL_REQUIRED') return { status: 'suspended', reason: 'awaiting approval' };

  // Budget first: bounded turns even under adversarial scripts.
  try {
    store.reserve({ taskId, agentId, kind: 'modelCalls', amount: 1 });
  } catch {
    store.appendEvent(taskId, 'task.blocked', 'model-call budget exhausted');
    return { status: 'suspended', reason: 'model-call budget exhausted' };
  }

  const recentEvents = store.events.filter((e) => e.taskId === taskId).slice(-8);
  store.appendEvent(taskId, 'model.requested', `agent ${agentId} requests decision`);
  const response = await model.decide({
    taskId,
    agentId,
    systemPolicy: 'least-privilege; consequential actions need approval',
    objective: task.objective,
    planRevision: task.planRevision,
    tools: [...broker.tools.values()].map((t) => ({ id: t.id, description: t.description })),
    recentEvents: recentEvents.map((e) => ({ type: e.type, summary: e.summary })),
  });
  store.appendEvent(taskId, 'model.responded', `action: ${response.action.kind}`);
  store.commitCheckpoint(taskId);

  const action = response.action;
  if (action.kind === 'done') {
    if (task.status === 'CREATED') store.transitionTask(taskId, 'READY', 'auto-ready');
    if (store.tasks.get(taskId)?.status === 'READY') store.transitionTask(taskId, 'RUNNING', 'auto-run');
    store.transitionTask(taskId, 'COMPLETE', action.summary);
    return { status: 'complete', summary: action.summary };
  }
  if (action.kind === 'wait-user') {
    if (store.tasks.get(taskId)?.status === 'RUNNING') {
      // stay RUNNING; surface waiting state via event, not hidden CoT
      store.appendEvent(taskId, 'task.waiting', action.reason);
      store.commitCheckpoint(taskId);
    }
    return { status: 'waiting-user', reason: action.reason };
  }

  // Tool path: brokered, idempotent, checkpointed at each stage.
  const principal = { kind: 'core-agent' as const, agentId };
  const toolRequest = {
    toolId: action.toolId,
    args: action.args,
    argsHash: action.argsHash,
    principal,
    taskId,
    agentId,
  };
  const evaluation = broker.evaluate(toolRequest);
  // A previously granted approval bound to these exact arguments is consumed
  // here, so an approved loop resumes without re-prompting. The binding is
  // rechecked at dispatch; anything changed falls back to a fresh approval.
  let approvalId: string | undefined;
  if (evaluation.approvalRequired) {
    const existing = [...store.approvals.values()].find(
      (a) =>
        a.taskId === taskId &&
        a.agentId === agentId &&
        a.toolId === action.toolId &&
        a.argsHash === action.argsHash &&
        a.decision === 'granted',
    );
    if (existing && broker.authorizeDispatch(toolRequest, existing.id).allowed) {
      approvalId = existing.id;
    } else {
      if (store.tasks.get(taskId)?.status === 'RUNNING') {
        store.transitionTask(taskId, 'APPROVAL_REQUIRED', `${action.toolId} requires approval`);
      } else {
        store.appendEvent(taskId, 'approval.requested', `${action.toolId} requires approval`);
        store.commitCheckpoint(taskId);
      }
      return { status: 'approval-required', approvalId: evaluation.approvalId! };
    }
  } else if (!evaluation.allowed) {
    store.appendEvent(taskId, 'tool.failed', `${action.toolId} denied: ${evaluation.reason}`);
    store.commitCheckpoint(taskId);
    return { status: 'continue' };
  }

  const op = store.prepareOperation({
    taskId,
    agentId,
    toolId: action.toolId,
    argsHash: action.argsHash,
    idempotencyKey: action.idempotencyKey,
  });
  // Idempotent replay: same key returns existing op; only PREPARED ops dispatch.
  if (op.status !== 'PREPARED') {
    store.appendEvent(taskId, 'tool.completed', `${action.toolId} already recorded ${op.id}; skipping duplicate dispatch`);
    store.commitCheckpoint(taskId);
    return { status: 'continue' };
  }
  const dispatch = broker.authorizeDispatch(toolRequest, approvalId);
  if (!dispatch.allowed) {
    store.appendEvent(taskId, 'tool.failed', `${action.toolId} dispatch denied: ${dispatch.reason}`);
    store.commitCheckpoint(taskId);
    return { status: 'continue' };
  }
  try {
    store.reserve({ taskId, agentId, kind: 'toolCalls', amount: 1 });
  } catch {
    store.appendEvent(taskId, 'task.blocked', 'tool-call budget exhausted');
    return { status: 'suspended', reason: 'tool-call budget exhausted' };
  }
  store.markDispatched(op.id);
  try {
    const exec = await executor.execute(action.toolId, action.args);
    if (exec.ok) {
      store.settleOperation(op.id, 'SUCCEEDED', { resultHash: exec.resultHash });
    } else {
      store.settleOperation(op.id, 'FAILED', { error: exec.error });
    }
  } catch (e) {
    // Executor threw without a result: crash-equivalent. Leave DISPATCHED so
    // recovery marks UNCERTAIN rather than guessing.
    store.appendEvent(taskId, 'tool.failed', `${action.toolId} executor threw; left ${op.id} DISPATCHED for recovery`);
    store.commitCheckpoint(taskId);
  }
  return { status: 'continue' };
}

/** Drive turns until a terminal turn outcome or maxTurns. Crash-safe: each turn checkpoints. */
export async function runUntilSettled(
  store: DurableStore,
  broker: CapabilityBroker,
  model: ModelProvider,
  executor: ToolExecutor,
  taskId: TaskId,
  agentId: AgentId,
  maxTurns = 25,
  onTurn?: () => void | Promise<void>,
): Promise<TurnOutcome> {
  let last: TurnOutcome = { status: 'continue' };
  for (let i = 0; i < maxTurns; i += 1) {
    last = await runAgentTurn(store, broker, model, executor, taskId, agentId);
    await onTurn?.();
    if (last.status !== 'continue') return last;
  }
  return { status: 'suspended', reason: 'max turns reached' };
}
