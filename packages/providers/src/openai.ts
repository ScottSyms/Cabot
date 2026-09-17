// OpenAI-compatible provider adapter (spec §8.3).
// Works against any OpenAI-style chat-completions endpoint: vendor APIs,
// enterprise gateways, or locally hosted endpoints — same mapping.
// Credential handling: the API key travels only in the Authorization header,
// never in prompts, logs, or stored state. Endpoints are allow-listed by
// explicit configuration, not by model output.
import type { BudgetStatus, LoopAction, ModelDescriptor, ModelProvider, ModelRequest, ModelResponse } from './types.js';

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
    const budgetLine = request.budget ? renderBudget(request.budget) : '';
    const body = {
      model: this.config.modelId,
      messages: [
        {
          role: 'system',
          content: `${request.systemPolicy}\nObjective: ${request.objective}${budgetLine ? `\n${budgetLine}` : ''}`,
        },
        ...(request.recentConversation ?? []).map((m) => ({
          role: m.role === 'agent' ? ('assistant' as const) : ('user' as const),
          content: m.text,
        })),
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
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw new Error('model request timed out');
      throw new Error(
        `model endpoint unreachable (${base}): ${e instanceof Error ? e.message : String(e)}. Check network access and that the extension permits this host.`,
      );
    } finally {
      clearTimeout(timer);
    }
    const url = `${base}/chat/completions`;
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.text();
        detail = body.slice(0, 200).replace(/\s+/g, ' ');
      } catch {
        // Body unavailable; status alone must suffice.
      }
      throw new Error(
        `model endpoint HTTP ${res.status} at ${url}${detail ? `: ${detail}` : ''}. ` +
          `Check the endpoint path (OpenRouter needs https://openrouter.ai/api/v1) and that the model id is valid.`,
      );
    }
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (contentType && !contentType.includes('json')) {
      let snippet = '';
      try {
        snippet = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
      } catch {
        // Snippet is best-effort.
      }
      throw new Error(
        `model endpoint returned ${contentType || 'non-JSON'} instead of JSON at ${url}` +
          `${snippet ? `: "${snippet}"` : ''}. The endpoint must be an API base URL ending in /v1 ` +
          `(for OpenRouter: https://openrouter.ai/api/v1).`,
      );
    }
    let data: ChatResponse;
    try {
      data = (await res.json()) as ChatResponse;
    } catch {
      throw new Error(
        `model endpoint returned invalid JSON at ${url}. The endpoint must be an API base URL ` +
          `(for OpenRouter: https://openrouter.ai/api/v1), not a website root.`,
      );
    }
    const message = data.choices[0]?.message;
    if (!message) throw new Error('empty model response');
    // Assistant prose is captured even on tool-call turns — it becomes the
    // conversation transcript rather than being discarded.
    const text = (message.content ?? '').slice(0, 8000) || undefined;
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
      return { action, text };
    }
    return { action: { kind: 'done', summary: (message.content ?? '').slice(0, 2000) || 'model returned no content' }, text };
  }
}

/**
 * Budget guidance injected into the system message. Turns "ran out of
 * budget" into pacing: the model knows what's left and is told to conclude
 * with a summary as it approaches the limit.
 */
function renderBudget(b: BudgetStatus): string {
  const parts: string[] = [];
  const modelLeft = b.modelCallsLimit !== undefined ? b.modelCallsLimit - b.modelCallsUsed : undefined;
  const toolLeft = b.toolCallsLimit !== undefined ? b.toolCallsLimit - b.toolCallsUsed : undefined;
  if (modelLeft !== undefined) parts.push(`${modelLeft} of ${b.modelCallsLimit} model calls remaining`);
  if (toolLeft !== undefined) parts.push(`${toolLeft} of ${b.toolCallsLimit} tool calls remaining`);
  if (parts.length === 0) return '';
  const low =
    (modelLeft !== undefined && modelLeft <= Math.max(1, Math.floor((b.modelCallsLimit ?? 0) * 0.2))) ||
    (toolLeft !== undefined && toolLeft <= Math.max(1, Math.floor((b.toolCallsLimit ?? 0) * 0.2)));
  const guidance = low
    ? 'Budget is low: stop starting new work and finish now with a done summary of what you have.'
    : 'Be economical with calls; when the budget is low, conclude with a done summary rather than starting new work.';
  return `Budget: ${parts.join(', ')}. ${guidance}`;
}

function contentHashOf(text: string): string {  let h1 = 0xdeadbeef;
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
