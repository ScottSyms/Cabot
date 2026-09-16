// Deterministic fixture backend for tests: scripted tabs/pages, no browser.
import type { BrowserBackend, PageLink, PageSnapshot, TabInfo } from './browser.js';

export class FakeBrowserBackend implements BrowserBackend {
  private tabs: TabInfo[] = [];
  private pages = new Map<string, PageSnapshot>();
  private selections = new Map<string, { text: string; origin: string }>();

  addTab(tab: TabInfo, page: PageSnapshot, selection = ''): void {
    this.tabs.push(tab);
    this.pages.set(tab.id, page);
    this.selections.set(tab.id, { text: selection, origin: tab.origin });
  }

  private resolve(tabId?: string): string {
    if (tabId) {
      if (!this.pages.has(tabId)) throw new Error(`unknown tab ${tabId}`);
      return tabId;
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
}
