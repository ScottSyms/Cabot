// Model provider contract (spec §8.3). Provider-neutral; routing stays
// separate from tool authorization.
export interface ModelDescriptor {
  id: string;
  capabilities: string[];
}

export interface BudgetStatus {
  modelCallsLimit?: number;
  modelCallsUsed: number;
  toolCallsLimit?: number;
  toolCallsUsed: number;
}

export interface ModelRequest {
  taskId: string;
  agentId: string;
  systemPolicy: string;
  objective: string;
  planRevision: number;
  tools: { id: string; description: string; inputSchema?: Record<string, unknown> }[];
  recentEvents: { type: string; summary: string }[];
  /** Recent user/agent transcript (capped by the caller). */
  recentConversation?: { role: 'user' | 'agent'; text: string }[];
  /** Recent tool outputs, without which the model cannot act on its results. */
  recentToolResults?: { toolId: string; ok: boolean; result: string }[];
  /** Remaining budget so the model can pace itself and conclude in time. */
  budget?: BudgetStatus;
}

export type LoopAction =
  | { kind: 'tool'; toolId: string; args: unknown; argsHash: string; idempotencyKey: string }
  | { kind: 'done'; summary: string }
  | { kind: 'wait-user'; reason: string };

export interface ModelResponse {
  action: LoopAction;
  /** Assistant prose for this turn, if any — persisted as conversation. */
  text?: string;
}

export interface ModelProvider {
  id: string;
  listModels(): Promise<ModelDescriptor[]>;
  decide(request: ModelRequest): Promise<ModelResponse>;
}
