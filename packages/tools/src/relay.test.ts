import { describe, expect, it } from 'vitest';
import { FakeBrowserBackend } from './fake-backend.js';
import { RelayBrowserBackend, type RelayTransport } from './relay-backend.js';

const PAGE = {
  url: 'https://example.com/',
  origin: 'https://example.com',
  title: 'Home',
  text: 'hi',
  links: [],
  truncated: false,
};

describe('relay backend', () => {
  it('forwards calls and unwraps results', async () => {
    const inner = new FakeBrowserBackend();
    inner.addTab({ id: 't1', url: PAGE.url, title: PAGE.title, origin: PAGE.origin }, PAGE);
    const relay = new RelayBrowserBackend((async (msg: Parameters<RelayTransport>[0]) => {
      const fn = (inner as unknown as Record<string, (...a: never[]) => Promise<unknown>>)[msg.call];
      return { ok: true, result: await fn.apply(inner, msg.args as never[]) };
    }) as RelayTransport);
    expect(await relay.listTabs()).toHaveLength(1);
    expect((await relay.readPage('t1')).title).toBe('Home');
  });

  it('surfaces relay errors instead of empty results', async () => {
    const relay = new RelayBrowserBackend(async () => ({ error: 'tabs permission missing' }));
    await expect(relay.listTabs()).rejects.toThrow(/tabs permission missing/);
    const nullRelay = new RelayBrowserBackend(async () => null);
    await expect(nullRelay.listTabs()).rejects.toThrow(/empty response/);
  });
});
