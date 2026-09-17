import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from './openai.js';
import type { ModelRequest } from './types.js';

const baseRequest: ModelRequest = {
  taskId: 'task_1',
  agentId: 'agent_1',
  systemPolicy: 'least-privilege',
  objective: 'research ducks',
  planRevision: 0,
  tools: [{ id: 'browser.read_page', description: 'read a page' }],
  recentEvents: [{ type: 'task.created', summary: 'created' }],
};

function stubFetch(response: unknown, status = 200): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => response } as Response;
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openai-compatible provider', () => {
  it('maps tool_calls to brokered tool actions with provider call id as idempotency key', async () => {
    const { calls } = stubFetch({
      choices: [
        {
          message: {
            tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'browser.read_page', arguments: '{"tabId":"t1"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const provider = new OpenAICompatibleProvider({ endpoint: 'http://localhost:11434/v1', modelId: 'm' });
    const res = await provider.decide(baseRequest);
    expect(res.action).toMatchObject({ kind: 'tool', toolId: 'browser.read_page', idempotencyKey: 'call_abc' });
    if (res.action.kind === 'tool') {
      expect(res.action.args).toEqual({ tabId: 't1' });
      expect(res.action.argsHash).toMatch(/^[0-9a-f]{16}$/);
    }
    // Request shape: tools advertised, endpoint path correct.
    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions');    const sent = JSON.parse(calls[0].init.body as string) as { tools: { function: { name: string } }[]; model: string };
    expect(sent.model).toBe('m');
    expect(sent.tools.map((t) => t.function.name)).toEqual(['browser.read_page']);
  });

  it('maps plain text to done; sends key only in Authorization header', async () => {
    const { calls } = stubFetch({ choices: [{ message: { content: 'All researched.' }, finish_reason: 'stop' }] });
    const provider = new OpenAICompatibleProvider({
      endpoint: 'https://gateway.example.com/v1',
      apiKey: 'sekret',
      modelId: 'big',
    });
    const res = await provider.decide(baseRequest);
    expect(res.action).toEqual({ kind: 'done', summary: 'All researched.' });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sekret');
    // Key must not leak into the prompt body.
    expect(calls[0].init.body as string).not.toContain('sekret');
  });

  it('rejects non-HTTPS remote endpoints and surfaces HTTP errors', async () => {
    expect(() => new OpenAICompatibleProvider({ endpoint: 'http://evil.example.com/v1', modelId: 'm' })).toThrow(/HTTPS/);
    stubFetch({ error: 'nope' }, 500);
    const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.example.com/v1', modelId: 'm' });
    await expect(provider.decide(baseRequest)).rejects.toThrow(/500/);
  });

  it('tolerates endpoints that already include /chat/completions', async () => {
    const { calls } = stubFetch({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    const provider = new OpenAICompatibleProvider({
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: 'k',
      modelId: 'x',
    });
    await provider.decide(baseRequest);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('wraps network failures with an actionable message', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const provider = new OpenAICompatibleProvider({ endpoint: 'https://openrouter.ai/api/v1', modelId: 'm' });
    await expect(provider.decide(baseRequest)).rejects.toThrow(/unreachable.*openrouter.*permits this host/);
  });

  it('captures assistant text on tool-call turns and sends transcript context', async () => {
    const { calls } = stubFetch({
      choices: [
        {
          message: {
            content: 'Checking the page now.',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'browser.read_page', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const provider = new OpenAICompatibleProvider({ endpoint: 'http://localhost:11434/v1', modelId: 'm' });
    const res = await provider.decide({
      ...baseRequest,
      recentConversation: [
        { role: 'user', text: 'summarize this' },
        { role: 'agent', text: 'On it.' },
      ],
    });
    expect(res.text).toBe('Checking the page now.');
    expect(res.action.kind).toBe('tool');
    const sent = JSON.parse(calls[0].init.body as string) as { messages: { role: string; content: string }[] };
    expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent.messages[2].content).toBe('On it.');
  });

  it('rejects unparseable tool arguments instead of dispatching', async () => {
    stubFetch({
      choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{broken' } }] }, finish_reason: 'tool_calls' }],
    });
    const provider = new OpenAICompatibleProvider({ endpoint: 'http://localhost:1/v1', modelId: 'm' });
    await expect(provider.decide(baseRequest)).rejects.toThrow(/unparseable/);
  });
});

describe('non-JSON endpoint responses', () => {
  function stubRaw(body: string, status: number, contentType: string) {
    vi.stubGlobal('fetch', async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => body,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }) as unknown as Response);
  }

  it('explains an HTML page returned for a bare origin endpoint', async () => {
    stubRaw('<!DOCTYPE html><html>OpenRouter</html>', 200, 'text/html; charset=utf-8');
    const provider = new OpenAICompatibleProvider({ endpoint: 'https://openrouter.ai', modelId: 'm' });
    await expect(provider.decide(baseRequest)).rejects.toThrow(/returned text\/html.*https:\/\/openrouter\.ai\/api\/v1/);
  });

  it('reports HTTP errors with the URL and model hint', async () => {
    stubRaw('<!DOCTYPE html>Not Found', 404, 'text/html');
    const provider = new OpenAICompatibleProvider({ endpoint: 'https://openrouter.ai/api/v1', modelId: 'bad' });
    await expect(provider.decide(baseRequest)).rejects.toThrow(/HTTP 404 at https:\/\/openrouter\.ai\/api\/v1\/chat\/completions/);
  });
});

describe('budget guidance', () => {
  it('tells the model what remains and to conclude when low', async () => {
    const { calls } = stubFetch({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
    const provider = new OpenAICompatibleProvider({ endpoint: 'http://localhost:11434/v1', modelId: 'm' });
    await provider.decide({
      ...baseRequest,
      budget: { modelCallsLimit: 10, modelCallsUsed: 9, toolCallsLimit: 20, toolCallsUsed: 18 },
    });
    const sent = JSON.parse(calls[0].init.body as string) as { messages: { role: string; content: string }[] };
    const sys = sent.messages[0].content;
    expect(sys).toContain('1 of 10 model calls remaining');
    expect(sys).toContain('2 of 20 tool calls remaining');
    expect(sys).toMatch(/finish now with a done summary/);
  });

  it('omits budget guidance when no budget is provided', async () => {
    const { calls } = stubFetch({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
    const provider = new OpenAICompatibleProvider({ endpoint: 'http://localhost:11434/v1', modelId: 'm' });
    await provider.decide(baseRequest);
    const sent = JSON.parse(calls[0].init.body as string) as { messages: { role: string; content: string }[] };
    expect(sent.messages[0].content).not.toContain('Budget:');
  });
});

describe('tool result context', () => {
  it('renders prior tool outputs as messages the model can use', async () => {
    const { calls } = stubFetch({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
    const provider = new OpenAICompatibleProvider({ endpoint: 'http://localhost:11434/v1', modelId: 'm' });
    await provider.decide({
      ...baseRequest,
      recentToolResults: [
        { toolId: 'browser.get_active_tab', ok: true, result: '{"id":"t1","url":"https://example.com"}' },
        { toolId: 'browser.read_page', ok: false, result: 'Cannot access chrome:// pages' },
      ],
    });
    const sent = JSON.parse(calls[0].init.body as string) as { messages: { role: string; content: string }[] };
    const joined = sent.messages.map((m) => m.content).join('\n');
    expect(joined).toContain('[tool result: browser.get_active_tab ok] {"id":"t1"');
    expect(joined).toContain('[tool result: browser.read_page failed] Cannot access chrome:// pages');
  });
});
