// OpenAI-compatible provider adapter (spec §8.3).
// Works against any OpenAI-style chat-completions endpoint: vendor APIs,
// enterprise gateways, or locally hosted endpoints — same mapping.
// Credential handling: the API key travels only in the Authorization header,
// never in prompts, logs, or stored state. Endpoints are allow-listed by
// explicit configuration, not by model output.
import type { LoopAction, ModelDescriptor, ModelProvider, ModelRequest, ModelResponse } from './types.js';

export interface OpenAICompatibleConfig {
  endpoint: string;
  apiKey?: string;
  modelId: string;
  timeoutMs?: number;
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatResponse {
  choices: { message: { content?: string | null; tool_calls?: ChatToolCall[] }; finish_reason: string }[];
}

export class OpenAICompatibleProvider implements ModelProvider {
  id = 'openai-compatible';

  constructor(private config: OpenAICompatibleConfig) {
    if (!config.endpoint.startsWith('https://') && !config.endpoint.startsWith('http://localhost')) {
      throw new Error('refusing non-HTTPS endpoint outside localhost');
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: this.config.modelId, capabilities: ['tools'] }];
  }

  async decide(request: ModelRequest): Promise<ModelResponse> {
    const base = this.config.endpoint.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const body = {
      model: this.config.modelId,
      messages: [
        { role: 'system', content: `${request.systemPolicy}\nObjective: ${request.objective}` },
        ...request.recentEvents.map((e) => ({ role: 'user' as const, content: `[${e.type}] ${e.summary}` })),
      ],
      tools: request.tools.map((t) => ({
        type: 'function',
        function: { name: t.id, description: t.description, parameters: { type: 'object' } },
      })),
      tool_choice: 'auto' as const,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`model endpoint ${res.status}`);
    }
    const data = (await res.json()) as ChatResponse;
    const message = data.choices[0]?.message;
    if (!message) throw new Error('empty model response');
    const call = message.tool_calls?.[0];
    if (call) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        throw new Error('model returned unparseable tool arguments');
      }
      const action: LoopAction = {
        kind: 'tool',
        toolId: call.function.name,
        args,
        // Hash binds the exact arguments; broker rechecks before dispatch.
        argsHash: contentHashOf(call.function.arguments || '{}'),
        // Idempotency derives from the provider's tool-call id (unique per call).
        idempotencyKey: call.id,
      };
      return { action };
    }
    return { action: { kind: 'done', summary: (message.content ?? '').slice(0, 2000) || 'model returned no content' } };
  }
}

function contentHashOf(text: string): string {
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
