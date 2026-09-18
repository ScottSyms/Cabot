import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChromeBrowserBackend, GROUP_COLORS, isReadableWebUrl, normTabId, randomGroupName } from './chrome-backend.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readable web url policy', () => {
  it('accepts ordinary web pages', () => {
    expect(isReadableWebUrl('https://example.com/news')).toBe(true);
    expect(isReadableWebUrl('http://example.com')).toBe(true);
  });

  it('rejects the extension UI, browser internals, and non-web schemes', () => {
    expect(isReadableWebUrl('chrome-extension://abc/dist/workspace.html')).toBe(false);
    expect(isReadableWebUrl('chrome://extensions')).toBe(false);
    expect(isReadableWebUrl('edge://settings')).toBe(false);
    expect(isReadableWebUrl('about:blank')).toBe(false);
    expect(isReadableWebUrl('file:///etc/hosts')).toBe(false);
    expect(isReadableWebUrl('javascript:alert(1)')).toBe(false);
    expect(isReadableWebUrl(undefined)).toBe(false);
  });
});

describe('tab id normalization', () => {
  it('accepts strings and numbers, rejects empty and zero', () => {
    expect(normTabId('123')).toBe('123');
    expect(normTabId(123)).toBe('123');
    expect(normTabId(' 42 ')).toBe('42');
    expect(normTabId('')).toBeUndefined();
    expect(normTabId('   ')).toBeUndefined();
    expect(normTabId(0)).toBeUndefined();
    expect(normTabId('0')).toBeUndefined();
    expect(normTabId(undefined)).toBeUndefined();
    expect(normTabId(null)).toBeUndefined();
    expect(normTabId({})).toBe('[object Object]');
  });
});

describe('background tabs and grouping', () => {
  it('generates a readable random group name and valid color', () => {
    const name = randomGroupName();
    expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(GROUP_COLORS.length).toBeGreaterThan(0);
    // A run of names should not all collide.
    const names = new Set(Array.from({ length: 25 }, () => randomGroupName()));
    expect(names.size).toBeGreaterThan(1);
  });

  it('opens agent tabs in the background and groups them', async () => {
    const created: { url: string; active?: boolean }[] = [];
    const grouped: { tabIds: number[]; groupId?: number }[] = [];
    const updates: { id: number; props: { title?: string; color?: string } }[] = [];
    vi.stubGlobal('chrome', {
      tabs: {
        query: async () => [{ id: 1, url: 'https://user.example', title: 'User' }],
        create: async (p: { url: string; active?: boolean }) => {
          created.push(p);
          return { id: 7, url: p.url, title: 'News', status: 'complete' };
        },
        get: async (id: number) => ({ id, url: 'https://example.com/news', title: 'News', status: 'complete' }),
        update: async () => ({ id: 7, url: 'https://x', title: 'X' }),
        group: async (o: { tabIds: number[]; groupId?: number }) => {
          grouped.push(o);
          return 99;
        },
      },
      tabGroups: {
        update: async (id: number, props: { title?: string; color?: string }) => {
          updates.push({ id, props });
        },
      },
      scripting: { executeScript: async () => [{ result: {} }] },
    });
    const backend = new ChromeBrowserBackend();
    const info = await backend.navigate('https://example.com/news');
    expect(created).toHaveLength(1);
    expect(created[0].active).toBe(false); // never steals focus
    expect(grouped[0].tabIds).toEqual([7]);
    expect(updates[0].id).toBe(99);
    expect(updates[0].props.title).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(info.title).toBe('News');
  });

  it('reuses one group for subsequent agent tabs', async () => {
    const grouped: { tabIds: number[]; groupId?: number }[] = [];
    let nextId = 10;
    vi.stubGlobal('chrome', {
      tabs: {
        query: async () => [],
        create: async (p: { url: string }) => ({ id: nextId++, url: p.url, title: 'T', status: 'complete' }),
        get: async (id: number) => ({ id, url: 'https://x', title: 'T', status: 'complete' }),
        group: async (o: { tabIds: number[]; groupId?: number }) => {
          grouped.push(o);
          return 42;
        },
      },
      tabGroups: { update: async () => undefined },
      scripting: { executeScript: async () => [{ result: {} }] },
    });
    const backend = new ChromeBrowserBackend();
    await backend.navigate('https://a.example');
    await backend.navigate('https://b.example');
    expect(grouped).toHaveLength(2);
    expect(grouped[0].groupId).toBeUndefined();
    expect(grouped[1].groupId).toBe(42);
  });
});
