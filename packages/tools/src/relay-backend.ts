// Relay backend: privileged browser calls execute in the service worker
// (spec §5.1 — the extension-privilege boundary), never in the offscreen
// document or model context. The supervisor answers `cabot.browser-call`
// messages by dispatching on its own ChromeBrowserBackend; this class is
// just the transport. Results are untrusted page data either way.
import type { BrowserBackend, PageLink, PageSnapshot, TabInfo } from './browser.js';

export type RelayTransport = (msg: {
  type: 'cabot.browser-call';
  call: string;
  args: unknown[];
}) => Promise<unknown>;

export class RelayBrowserBackend implements BrowserBackend {
  constructor(private transport: RelayTransport) {}

  private async call<T>(call: string, ...args: unknown[]): Promise<T> {
    const res = (await this.transport({ type: 'cabot.browser-call', call, args })) as {
      ok?: boolean;
      result?: T;
      error?: string;
    } | null;
    if (!res || !res.ok) throw new Error(res?.error ?? 'browser relay returned an empty response');
    return res.result as T;
  }

  listTabs(): Promise<TabInfo[]> {
    return this.call('listTabs');
  }

  getActiveTab(): Promise<TabInfo> {
    return this.call('getActiveTab');
  }

  readPage(tabId?: string): Promise<PageSnapshot> {
    return this.call('readPage', tabId);
  }

  readSelection(tabId?: string): Promise<{ text: string; origin: string }> {
    return this.call('readSelection', tabId);
  }

  getLinks(tabId?: string): Promise<PageLink[]> {
    return this.call('getLinks', tabId);
  }

  getAccessibilityTree(tabId?: string): Promise<unknown> {
    return this.call('getAccessibilityTree', tabId);
  }

  navigate(url: string, tabId?: string): Promise<TabInfo> {
    return this.call('navigate', url, tabId);
  }

  goBack(tabId?: string): Promise<void> {
    return this.call('goBack', tabId);
  }

  goForward(tabId?: string): Promise<void> {
    return this.call('goForward', tabId);
  }

  click(elementId: string, expectedText: string, tabId?: string): Promise<void> {
    return this.call('click', elementId, expectedText, tabId);
  }

  typeText(elementId: string, expectedText: string, text: string, tabId?: string): Promise<void> {
    return this.call('typeText', elementId, expectedText, text, tabId);
  }

  select(elementId: string, expectedText: string, value: string, tabId?: string): Promise<void> {
    return this.call('select', elementId, expectedText, value, tabId);
  }

  scroll(direction: 'up' | 'down', tabId?: string): Promise<void> {
    return this.call('scroll', direction, tabId);
  }
}
