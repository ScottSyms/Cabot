// Privileged backend for the extension supervisor context.
// Runs where chrome.tabs/chrome.scripting exist; never in the model context.
// All results are untrusted page data — provenance-tagged by the executor.
//
// Only real web pages (http/https) are exposed. The extension's own pages
// (chrome-extension://…), chrome:// internal pages, and other privileged
// schemes cannot be scripted and must never become agent targets.
import type { BrowserBackend, PageLink, PageSnapshot, TabInfo } from './browser.js';

interface RawTab {
  id?: number;
  url?: string;
  title?: string;
  status?: string;
}

interface ChromeTabs {
  query(q: Record<string, unknown>): Promise<RawTab[]>;
  get(tabId: number): Promise<RawTab>;
  update(tabId: number, props: { url: string; active?: boolean }): Promise<RawTab>;
  create(props: { url: string; active?: boolean }): Promise<RawTab>;
  group(opts: { tabIds: number[]; groupId?: number }): Promise<number>;
  goBack(tabId?: number): Promise<void>;
  goForward(tabId?: number): Promise<void>;
}
interface ChromeTabGroups {
  update(groupId: number, props: { title?: string; color?: string }): Promise<unknown>;
}
interface ChromeScripting {
  executeScript(opts: { target: { tabId: number }; func: () => unknown }): Promise<{ result: unknown }[]>;
}

function chromeApi(): { tabs: ChromeTabs; tabGroups?: ChromeTabGroups; scripting: ChromeScripting } {
  const g = globalThis as unknown as {
    chrome?: { tabs?: ChromeTabs; tabGroups?: ChromeTabGroups; scripting?: ChromeScripting };
  };
  if (!g.chrome?.tabs || !g.chrome?.scripting) {
    throw new Error('chrome tabs/scripting APIs unavailable in this context');
  }
  return { tabs: g.chrome.tabs, tabGroups: g.chrome.tabGroups, scripting: g.chrome.scripting };
}

const GROUP_ADJECTIVES = ['Amber', 'Cobalt', 'Violet', 'Rust', 'Jade', 'Indigo', 'Copper', 'Azure', 'Crimson', 'Sage', 'Onyx', 'Lilac'];
const GROUP_NOUNS = ['Otter', 'Falcon', 'Fox', 'Heron', 'Lynx', 'Marten', 'Osprey', 'Panda', 'Quail', 'Raven', 'Wolf', 'Wren'];
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** Random, human-readable tab-group name, e.g. "Amber Otter". */
export function randomGroupName(): string {
  return `${pick(GROUP_ADJECTIVES)} ${pick(GROUP_NOUNS)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A tab the agent may read or act on: an ordinary http(s) web page. */
export function isReadableWebUrl(url: string | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * Model-supplied ids arrive as whatever JSON type the model chose (number,
 * string, null). Normalize to a trimmed non-empty string or undefined.
 */
export function normTabId(tabId: unknown): string | undefined {
  if (tabId === undefined || tabId === null) return undefined;
  const s = String(tabId).trim();
  return s === '' || s === '0' ? undefined : s;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function toInfo(t: RawTab): TabInfo {
  return {
    id: String(t.id),
    url: t.url ?? '',
    title: t.title ?? '',
    origin: originOf(t.url ?? ''),
  };
}

function readableTabs(raw: RawTab[]): RawTab[] {
  return raw.filter((t) => t.id !== undefined && isReadableWebUrl(t.url));
}

export class ChromeBrowserBackend implements BrowserBackend {
  private groupId?: number;
  private readonly groupName = randomGroupName();
  private readonly groupColor = pick(GROUP_COLORS);

  /**
   * Put an agent-opened tab into a single named group, created on first use.
   * Best-effort: grouping never fails a navigation.
   */
  private async ensureGroup(tabId: number): Promise<void> {
    try {
      const { tabs, tabGroups } = chromeApi();
      if (!tabGroups) return;
      if (this.groupId === undefined) {
        this.groupId = await tabs.group({ tabIds: [tabId] });
        await tabGroups.update(this.groupId, { title: this.groupName, color: this.groupColor });
      } else {
        await tabs.group({ tabIds: [tabId], groupId: this.groupId });
      }
    } catch {
      // Grouping is cosmetic; navigation must still succeed.
    }
  }

  /** Wait until the tab finishes loading so a subsequent read sees real content. */
  private async waitForComplete(tabId: number, timeoutMs = 10_000): Promise<void> {
    const { tabs } = chromeApi();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const t = await tabs.get(tabId);
        if (!t || t.status === 'complete') return;
      } catch {
        return;
      }
      if (Date.now() >= deadline) return;
      await delay(200);
    }
  }

  async listTabs(): Promise<TabInfo[]> {
    const { tabs } = chromeApi();
    return readableTabs(await tabs.query({})).map(toInfo);
  }

  async getActiveTab(): Promise<TabInfo> {
    const { tabs } = chromeApi();
    // Prefer the focused web tab; if the focused tab is Cabot's own UI or a
    // browser page, fall back to any readable tab so a run can still proceed.
    const active = (await tabs.query({ active: true, lastFocusedWindow: true })).find((t) =>
      isReadableWebUrl(t.url),
    );
    if (active) return toInfo(active);
    const anyWeb = readableTabs(await tabs.query({}))[0];
    if (anyWeb) return toInfo(anyWeb);
    throw new Error('no web page tab is open — navigate to a website first');
  }

  /**
   * Resolve a target tab id, refusing non-web pages. With no id, uses the
   * active web tab. Never returns the extension's own pages.
   */
  private async resolveWebTabId(tabId?: string): Promise<number> {
    const { tabs } = chromeApi();
    const raw = await tabs.query({});
    const norm = normTabId(tabId);
    if (norm) {
      const n = Number(norm);
      if (!Number.isFinite(n)) throw new Error(`invalid tab id ${String(tabId)}`);
      const t = raw.find((x) => x.id === n);
      if (!t) throw new Error(`no tab with id ${n}`);
      if (!isReadableWebUrl(t.url)) {
        throw new Error(`tab ${n} is not a web page (${t.url ?? 'unknown'}) and cannot be read`);
      }
      return n;
    }
    const active = raw.find((x) => x.id !== undefined && isReadableWebUrl(x.url));
    if (!active) throw new Error('no web page tab is open — navigate to a website first');
    return active.id!;
  }

  async readPage(tabId?: string): Promise<PageSnapshot> {
    const { scripting } = chromeApi();
    const id = await this.resolveWebTabId(tabId);
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
    const id = await this.resolveWebTabId(tabId);
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

  async getAccessibilityTree(tabId?: string): Promise<unknown> {
    const page = await this.readPage(tabId);
    return { role: 'document', name: page.title, url: page.url };
  }

  /**
   * Navigate a web tab, or open a new background tab when no usable target is
   * given. Agent-opened tabs are placed in a named group so the user's own
   * browsing is not disturbed or mixed with the agent's.
   */
  async navigate(url: string, tabId?: string): Promise<TabInfo> {
    if (!isReadableWebUrl(url)) throw new Error(`refusing to navigate to non-web URL ${String(url)}`);
    const { tabs } = chromeApi();
    const norm = normTabId(tabId);
    let tab: RawTab | undefined;
    if (norm) {
      const n = Number(norm);
      if (Number.isFinite(n)) {
        const existing = (await tabs.query({})).find((x) => x.id === n);
        if (existing && isReadableWebUrl(existing.url)) tab = await tabs.update(n, { url });
      }
    }
    let created = false;
    if (!tab) {
      // active:false keeps the user's current tab focused.
      tab = await tabs.create({ url, active: false });
      created = true;
    }
    if (tab.id !== undefined) {
      if (created) await this.ensureGroup(tab.id);
      await this.waitForComplete(tab.id);
      try {
        tab = await tabs.get(tab.id);
      } catch {
        // Keep the create/update response if the refresh fails.
      }
    }
    return toInfo(tab);
  }

  async goBack(tabId?: string): Promise<void> {
    const { tabs } = chromeApi();
    const norm = normTabId(tabId);
    await tabs.goBack(norm ? Number(norm) : undefined);
  }

  async goForward(tabId?: string): Promise<void> {
    const { tabs } = chromeApi();
    const norm = normTabId(tabId);
    await tabs.goForward(norm ? Number(norm) : undefined);
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
    await this.actOnElement(await this.resolveWebTabId(tabId), elementId, expectedText, 'click');
  }

  async typeText(elementId: string, expectedText: string, text: string, tabId?: string): Promise<void> {
    await this.actOnElement(await this.resolveWebTabId(tabId), elementId, expectedText, 'type', text);
  }

  async select(elementId: string, expectedText: string, value: string, tabId?: string): Promise<void> {
    await this.actOnElement(await this.resolveWebTabId(tabId), elementId, expectedText, 'select', value);
  }

  async scroll(direction: 'up' | 'down', tabId?: string): Promise<void> {
    const { scripting } = chromeApi();
    const id = await this.resolveWebTabId(tabId);
    await scripting.executeScript({
      target: { tabId: id },
      func: () => window.scrollBy(0, 600),
    });
    void direction;
  }
}
