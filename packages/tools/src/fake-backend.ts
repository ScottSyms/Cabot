// Deterministic fixture backend for tests: scripted tabs/pages, no browser.
import type { BrowserBackend, PageLink, PageSnapshot, TabInfo } from './browser.js';

export class FakeBrowserBackend implements BrowserBackend {
  private tabs: TabInfo[] = [];
  private pages = new Map<string, PageSnapshot>();
  private selections = new Map<string, { text: string; origin: string }>();
  private elements = new Map<string, Map<string, string>>();
  /** Ordered log of write actions (for serialization assertions). */
  actions: string[] = [];

  addTab(tab: TabInfo, page: PageSnapshot, selection = ''): void {
    this.tabs.push(tab);
    this.pages.set(tab.id, page);
    this.selections.set(tab.id, { text: selection, origin: tab.origin });
    this.elements.set(tab.id, new Map());
  }

  /** Fixture element with observable text for stale-target checks. */
  addElement(tabId: string, elementId: string, text: string): void {
    const els = this.elements.get(tabId);
    if (!els) throw new Error(`unknown tab ${tabId}`);
    els.set(elementId, text);
  }

  setElementText(tabId: string, elementId: string, text: string): void {
    this.elements.get(tabId)?.set(elementId, text);
  }

  private resolve(tabId?: string): string {
    const norm = tabId === undefined || tabId === null ? '' : String(tabId).trim();
    if (norm) {
      if (!this.pages.has(norm)) throw new Error(`unknown tab ${norm}`);
      return norm;
    }
    if (this.tabs.length === 0) throw new Error('no tabs open');
    return this.tabs[0].id;
  }

  async listTabs(): Promise<TabInfo[]> {
    return this.tabs.map((t) => ({ ...t }));
  }

  async getActiveTab(): Promise<TabInfo> {
    if (this.tabs.length === 0) throw new Error('no tabs open');
    return { ...this.tabs[0] };
  }

  async readPage(tabId?: string): Promise<PageSnapshot> {
    const page = this.pages.get(this.resolve(tabId));
    if (!page) throw new Error('page gone');
    return JSON.parse(JSON.stringify(page)) as PageSnapshot;
  }

  async readSelection(tabId?: string): Promise<{ text: string; origin: string }> {
    return { ...(this.selections.get(this.resolve(tabId)) ?? { text: '', origin: '' }) };
  }

  async getLinks(tabId?: string): Promise<PageLink[]> {
    return [...(this.pages.get(this.resolve(tabId))?.links ?? [])];
  }

  async getAccessibilityTree(tabId?: string): Promise<unknown> {
    const page = this.pages.get(this.resolve(tabId));
    return { role: 'document', name: page?.title ?? '', children: [] };
  }

  private checkElement(tabId: string, elementId: string, expectedText: string): void {
    const els = this.elements.get(tabId);
    const current = els?.get(elementId);
    if (current === undefined) throw new Error(`unknown element ${elementId}`);
    if (current !== expectedText) {
      throw new Error(`stale target ${elementId}: expected ${JSON.stringify(expectedText)}, found ${JSON.stringify(current)}`);
    }
  }

  async navigate(url: string, tabId?: string): Promise<TabInfo> {
    const id = this.resolve(tabId);
    const tab = this.tabs.find((t) => t.id === id)!;
    tab.url = url;
    try {
      tab.origin = new URL(url).origin;
    } catch {
      tab.origin = '';
    }
    this.actions.push(`navigate:${id}:${url}`);
    return { ...tab };
  }

  async goBack(tabId?: string): Promise<void> {
    this.actions.push(`back:${this.resolve(tabId)}`);
  }

  async goForward(tabId?: string): Promise<void> {
    this.actions.push(`forward:${this.resolve(tabId)}`);
  }

  async click(elementId: string, expectedText: string, tabId?: string): Promise<void> {
    const id = this.resolve(tabId);
    this.checkElement(id, elementId, expectedText);
    this.actions.push(`click:${id}:${elementId}`);
  }

  async typeText(elementId: string, expectedText: string, text: string, tabId?: string): Promise<void> {
    const id = this.resolve(tabId);
    this.checkElement(id, elementId, expectedText);
    this.actions.push(`type:${id}:${elementId}:${text}`);
  }

  async select(elementId: string, expectedText: string, value: string, tabId?: string): Promise<void> {
    const id = this.resolve(tabId);
    this.checkElement(id, elementId, expectedText);
    this.actions.push(`select:${id}:${elementId}:${value}`);
  }

  async scroll(direction: 'up' | 'down', tabId?: string): Promise<void> {
    this.actions.push(`scroll:${this.resolve(tabId)}:${direction}`);
  }
}
