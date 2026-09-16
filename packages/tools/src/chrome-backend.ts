// Privileged backend for the extension supervisor context.
// Runs where chrome.tabs/chrome.scripting exist; never in the model context.
// All results are untrusted page data — provenance-tagged by the executor.
import type { BrowserBackend, PageLink, PageSnapshot, TabInfo } from './browser.js';

interface ChromeTabs {
  query(q: Record<string, unknown>): Promise<{ id?: number; url?: string; title?: string }[]>;
}
interface ChromeScripting {
  executeScript(opts: { target: { tabId: number }; func: () => unknown }): Promise<{ result: unknown }[]>;
}

function chromeApi(): { tabs: ChromeTabs; scripting: ChromeScripting } {
  const g = globalThis as unknown as { chrome?: { tabs?: ChromeTabs; scripting?: ChromeScripting } };
  if (!g.chrome?.tabs || !g.chrome?.scripting) {
    throw new Error('chrome tabs/scripting APIs unavailable in this context');
  }
  return { tabs: g.chrome.tabs, scripting: g.chrome.scripting };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export class ChromeBrowserBackend implements BrowserBackend {
  async listTabs(): Promise<TabInfo[]> {
    const { tabs } = chromeApi();
    const raw = await tabs.query({});
    return raw.map((t) => ({
      id: String(t.id ?? ''),
      url: t.url ?? '',
      title: t.title ?? '',
      origin: originOf(t.url ?? ''),
    }));
  }

  async getActiveTab(): Promise<TabInfo> {
    const { tabs } = chromeApi();
    const raw = await tabs.query({ active: true, lastFocusedWindow: true });
    const t = raw[0];
    if (!t) throw new Error('no active tab');
    return { id: String(t.id ?? ''), url: t.url ?? '', title: t.title ?? '', origin: originOf(t.url ?? '') };
  }

  async readPage(tabId?: string): Promise<PageSnapshot> {
    const { scripting } = chromeApi();
    const id = Number(tabId ?? (await this.getActiveTab()).id);
    const [res] = await scripting.executeScript({
      target: { tabId: id },
      func: () => ({
        url: location.href,
        title: document.title,
        text: document.body?.innerText?.slice(0, 20_000) ?? '',
        links: [...document.links].slice(0, 200).map((a) => ({ text: (a.textContent ?? '').trim().slice(0, 200), href: a.href })),
      }),
    });
    const r = res.result as { url: string; title: string; text: string; links: PageLink[] };
    return { url: r.url, origin: originOf(r.url), title: r.title, text: r.text, links: r.links, truncated: r.text.length >= 20_000 };
  }

  async readSelection(tabId?: string): Promise<{ text: string; origin: string }> {
    const { scripting } = chromeApi();
    const id = Number(tabId ?? (await this.getActiveTab()).id);
    const [res] = await scripting.executeScript({
      target: { tabId: id },
      func: () => ({ text: getSelection()?.toString() ?? '', url: location.href }),
    });
    const r = res.result as { text: string; url: string };
    return { text: r.text, origin: originOf(r.url) };
  }

  async getLinks(tabId?: string): Promise<PageLink[]> {
    return (await this.readPage(tabId)).links;
  }

  async getAccessibilityTree(): Promise<unknown> {
    // Full AX-tree extraction lands with the write-path tools; read-only
    // slice returns a document placeholder to keep the contract stable.
    const page = await this.readPage();
    return { role: 'document', name: page.title, url: page.url };
  }
}
