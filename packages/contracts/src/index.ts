// Cabot durable entity contracts — Phase 0/1 foundation.
// See specification.md §§ 6, 7, 9, 17, 19, 20.
// SQLite is authoritative metadata; JSON layout is for export/inspection.

export type ISODateString = string;

export type ProjectId = string;
export type TaskId = string;
export type AgentId = string;
export type OperationId = string;
export type EventId = string;
export type MessageId = string;
export type ArtifactId = string;
export type ApprovalId = string;
export type GrantId = string;

export type TaskStatus =
  | 'CREATED'
  | 'READY'
  | 'RUNNING'
  | 'MODEL_PENDING'
  | 'TOOL_PENDING'
  | 'COMPUTE_PENDING'
  | 'APPROVAL_REQUIRED'
  | 'WAITING_EXTERNAL'
  | 'CHECKPOINTING'
  | 'COMPLETE'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'SUSPENDED'
  | 'BLOCKED';

export type AgentStatus =
  | 'CREATED'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_FOR_MODEL'
  | 'WAITING_FOR_TOOL'
  | 'WAITING_FOR_AGENT'
  | 'WAITING_FOR_USER'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type OperationStatus =
  | 'PREPARED'
  | 'DISPATCHED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNCERTAIN';

export type CapabilityClass =
  | 'read-only'
  | 'reversible'
  | 'external-mutation'
  | 'consequential';

export type GrantScope =
  | 'once'
  | 'task'
  | 'project'
  | 'domain-server'
  | 'persistent-allow'
  | 'persistent-deny';

export interface Principal {
  kind:
    | 'core-agent'
    | 'delegated-agent'
    | 'skill'
    | 'python-execution'
    | 'mcp-server'
    | 'webmcp-origin'
    | 'user';
  agentId?: AgentId;
  skillId?: string;
  skillVersion?: string;
  serverId?: string;
  origin?: string;
}

export interface Project {
  id: ProjectId;
  name: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  archived?: boolean;
}

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  ownerAgentId: AgentId;
  title: string;
  objective: string;
  status: TaskStatus;
  checkpointRevision: number;
  planRevision: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface Agent {
  id: AgentId;
  projectId: ProjectId;
  parentAgentId?: AgentId;
  role: string;
  objective: string;
  status: AgentStatus;
  modelConfig: ModelConfig;
  skillIds: string[];
  budget: Budget;
  spent: BudgetSpent;
  mailboxCursor: string;
  workspaceMounts: string[];
  checkpointRevision: number;
  delegationDepth: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface ModelConfig {
  providerId: string;
  modelId: string;
}

export interface Budget {
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxRuntimeMs?: number;
  maxCostUsd?: number;
  maxDelegations?: number;
  maxBrowserNavigations?: number;
  maxComputeMs?: number;
}

export interface BudgetSpent {
  modelCalls: number;
  toolCalls: number;
  runtimeMs: number;
  costUsd: number;
  delegations: number;
  browserNavigations: number;
  computeMs: number;
}

export interface Operation {
  id: OperationId;
  taskId: TaskId;
  agentId: AgentId;
  toolId: string;
  argsHash: string;
  idempotencyKey: string;
  status: OperationStatus;
  attempt: number;
  approvalId?: ApprovalId;
  resultHash?: string;
  error?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface TaskEvent {
  id: EventId;
  taskId: TaskId;
  seq: number;
  type: string;
  summary: string;
  createdAt: ISODateString;
}

export interface Checkpoint {
  taskId: TaskId;
  revision: number;
  taskStatus: TaskStatus;
  planRevision: number;
  createdAt: ISODateString;
  stateHash: string;
}

export interface AgentMessage {
  id: MessageId;
  from: AgentId;
  to: AgentId;
  type: 'request' | 'result' | 'event' | 'artifact' | 'cancel';
  payload: unknown;
  createdAt: ISODateString;
}

/**
 * User-facing conversation record. Unlike TaskEvent (operational log),
 * this is the transcript shown in the UI: user steering, agent prose, and
 * compact tool-call chips. Persisted durably per task, capped for size.
 */
export type ConversationRole = 'user' | 'agent' | 'tool';

export interface ConversationMessage {
  id: MessageId;
  taskId: TaskId;
  agentId: AgentId;
  role: ConversationRole;
  text: string;
  toolId?: string;
  ok?: boolean;
  /** Serialized tool output (capped) so the model can see what a tool returned. */
  result?: string;
  createdAt: ISODateString;
}

export interface Artifact {
  id: ArtifactId;
  projectId: ProjectId;
  taskId: TaskId;
  agentId: AgentId;
  path: string;
  bytes: number;
  sha256: string;
  staged: boolean;
  createdAt: ISODateString;
}

export interface Source {
  id: string;
  projectId: ProjectId;
  taskId: TaskId;
  uri: string;
  origin?: string;
  capturedAt: ISODateString;
  sha256: string;
}

export interface CapabilityGrant {
  id: GrantId;
  principal: Principal;
  toolId: string;
  scope: GrantScope;
  taskId?: TaskId;
  projectId?: ProjectId;
  origin?: string;
  expiresAt?: ISODateString;
  revoked?: boolean;
}

export interface Approval {
  id: ApprovalId;
  taskId: TaskId;
  agentId: AgentId;
  toolId: string;
  toolVersion?: string;
  argsHash: string;
  dataHash?: string;
  destination?: string;
  documentId?: string;
  capabilityClass: CapabilityClass;
  scope: GrantScope;
  decision?: 'granted' | 'denied';
  createdAt: ISODateString;
  decidedAt?: ISODateString;
}

export interface BudgetReservation {
  taskId: TaskId;
  agentId: AgentId;
  kind: keyof BudgetSpent;
  amount: number;
}

export interface ExternalTaskHandle {
  taskId: TaskId;
  operationId: OperationId;
  serverId: string;
  remoteHandle: string;
  status: 'pending' | 'done' | 'failed' | 'unknown';
  lastCheckedAt?: ISODateString;
}

export type ToolSource =
  | 'builtin'
  | 'skill'
  | 'mcp'
  | 'webmcp'
  | 'compute';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface CabotTool {
  id: string;
  version?: string;
  source: ToolSource;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  capabilityClass: CapabilityClass;
  provenance: string;
  annotations?: ToolAnnotations;
}

export interface SkillInstallation {
  skillId: string;
  version: string;
  trustLevel:
    | 'builtin'
    | 'admin-approved'
    | 'user-installed'
    | 'locally-authored'
    | 'agent-generated'
    | 'untrusted';
  installedAt: ISODateString;
}

export interface ServerTrustRecord {
  serverId: string;
  endpoint: string;
  authMethod: string;
  approvedCapabilities: string[];
  toolPolicy: Record<string, 'allow' | 'deny'>;
  observedToolSchemasHash?: string;
  lastEvaluatedAt: ISODateString;
}

export interface QueueEntry {
  agentId: AgentId;
  runnableAt: ISODateString;
  leaseId?: string;
  leaseExpiresAt?: ISODateString;
  fenceToken: number;
}

export function terminalTaskStatus(s: TaskStatus): boolean {
  return s === 'COMPLETE' || s === 'FAILED' || s === 'CANCELLED';
}

export function terminalAgentStatus(s: AgentStatus): boolean {
  return s === 'COMPLETED' || s === 'FAILED' || s === 'CANCELLED';
}

export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  CREATED: ['READY', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED', 'SUSPENDED'],
  RUNNING: [
    'MODEL_PENDING',
    'TOOL_PENDING',
    'COMPUTE_PENDING',
    'APPROVAL_REQUIRED',
    'WAITING_EXTERNAL',
    'CHECKPOINTING',
    'COMPLETE',
    'FAILED',
    'CANCELLED',
    'SUSPENDED',
    'INTERRUPTED',
  ],
  MODEL_PENDING: ['RUNNING', 'INTERRUPTED', 'FAILED', 'CANCELLED', 'SUSPENDED'],
  TOOL_PENDING: ['RUNNING', 'INTERRUPTED', 'FAILED', 'CANCELLED', 'SUSPENDED'],
  COMPUTE_PENDING: ['RUNNING', 'INTERRUPTED', 'FAILED', 'CANCELLED', 'SUSPENDED'],
  APPROVAL_REQUIRED: ['RUNNING', 'BLOCKED', 'CANCELLED', 'SUSPENDED'],
  WAITING_EXTERNAL: ['RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED', 'SUSPENDED'],
  CHECKPOINTING: ['RUNNING', 'INTERRUPTED', 'FAILED'],
  COMPLETE: [],
  FAILED: ['READY'],
  CANCELLED: [],
  INTERRUPTED: ['READY', 'BLOCKED', 'CANCELLED'],
  SUSPENDED: ['READY', 'CANCELLED'],
  BLOCKED: ['READY', 'CANCELLED'],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}
