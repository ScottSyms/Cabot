// Privileged backend for the extension supervisor context.
// Runs where chrome.tabs/chrome.scripting exist; never in the model context.
// All results are untrusted page data — provenance-tagged by the executor.
import type { BrowserBackend, PageLink, PageSnapshot, TabInfo } from './browser.js';

interface ChromeTabs {
  query(q: Record<string, unknown>): Promise<{ id?: number; url?: string; title?: string }[]>;
  update(tabId: number, props: { url: string }): Promise<{ id?: number; url?: string; title?: string }>;
  goBack(tabId?: number): Promise<void>;
  goForward(tabId?: number): Promise<void>;
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

  private async tabNumericId(tabId?: string): Promise<number> {
    if (tabId !== undefined) {
      const n = Number(tabId);
      if (!Number.isFinite(n)) throw new Error(`invalid tab id ${tabId}`);
      return n;
    }
    return Number((await this.getActiveTab()).id);
  }

  async navigate(url: string, tabId?: string): Promise<TabInfo> {
    const { tabs } = chromeApi();
    const id = await this.tabNumericId(tabId);
    const t = await tabs.update(id, { url });
    return { id: String(t.id ?? id), url: t.url ?? url, title: t.title ?? '', origin: originOf(t.url ?? url) };
  }

  async goBack(tabId?: string): Promise<void> {
    const { tabs } = chromeApi();
    await tabs.goBack(tabId === undefined ? undefined : Number(tabId));
  }

  async goForward(tabId?: string): Promise<void> {
    const { tabs } = chromeApi();
    await tabs.goForward(tabId === undefined ? undefined : Number(tabId));
  }

  /** Resolve a semantic element id and verify its text before acting. */
  private async actOnElement(
    tabId: number,
    elementId: string,
    expectedText: string,
    act: string,
    value?: string,
  ): Promise<void> {
    const { scripting } = chromeApi();
    const [res] = await scripting.executeScript({
      target: { tabId },
      func: (id: string, expected: string, action: string, val: string | undefined) => {
        const el = document.querySelector(`[data-cabot-id="${CSS.escape(id)}"]`) as HTMLElement | null;
        if (!el) throw new Error(`unknown element ${id}`);
        const current = (el.textContent ?? '').trim().slice(0, 200);
        if (current !== expected) {
          throw new Error(`stale target ${id}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(current)}`);
        }
        if (action === 'click') el.click();
        else if (action === 'type') {
          const input = el as HTMLInputElement;
          input.focus();
          input.value = val ?? '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (action === 'select') {
          (el as HTMLSelectElement).value = val ?? '';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return 'ok';
      },
      // executeScript func args are passed positionally after func in MV3.
      args: [elementId, expectedText, act, value],
    } as unknown as { target: { tabId: number }; func: () => unknown });
    if ((res.result as string) !== 'ok') throw new Error(`element action failed for ${elementId}`);
  }

  async click(elementId: string, expectedText: string, tabId?: string): Promise<void> {
    await this.actOnElement(await this.tabNumericId(tabId), elementId, expectedText, 'click');
  }

  async typeText(elementId: string, expectedText: string, text: string, tabId?: string): Promise<void> {
    await this.actOnElement(await this.tabNumericId(tabId), elementId, expectedText, 'type', text);
  }

  async select(elementId: string, expectedText: string, value: string, tabId?: string): Promise<void> {
    await this.actOnElement(await this.tabNumericId(tabId), elementId, expectedText, 'select', value);
  }

  async scroll(direction: 'up' | 'down', tabId?: string): Promise<void> {
    const { scripting } = chromeApi();
    const id = await this.tabNumericId(tabId);
    await scripting.executeScript({
      target: { tabId: id },
      func: () => window.scrollBy(0, 600),
    });
    void direction;
  }
}
