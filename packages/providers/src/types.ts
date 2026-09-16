// Model provider contract (spec §8.3). Provider-neutral; routing stays
// separate from tool authorization.
export interface ModelDescriptor {
  id: string;
  capabilities: string[];
}

export interface ModelRequest {
  taskId: string;
  agentId: string;
  systemPolicy: string;
  objective: string;
  planRevision: number;
  tools: { id: string; description: string }[];
  recentEvents: { type: string; summary: string }[];
}

export type LoopAction =
  | { kind: 'tool'; toolId: string; args: unknown; argsHash: string; idempotencyKey: string }
  | { kind: 'done'; summary: string }
  | { kind: 'wait-user'; reason: string };

export interface ModelResponse {
  action: LoopAction;
}

export interface ModelProvider {
  id: string;
  listModels(): Promise<ModelDescriptor[]>;
  decide(request: ModelRequest): Promise<ModelResponse>;
}
