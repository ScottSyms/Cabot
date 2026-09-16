// Read-only browser tools (spec §10, first slice).
// The model never touches chrome.* APIs: it requests tool calls, the
// Capability Broker authorizes them, and BrowserToolExecutor runs them
// against a BrowserBackend. ChromeBrowserBackend uses privileged extension
// APIs in the supervisor context; tests use FakeBrowserBackend.
// Page reads are captured as durable Sources with origin provenance.
import type { CabotTool } from '@cabot/contracts';
import { DurableStore } from '@cabot/storage';
import type { ToolExecutor, ToolExecution } from '@cabot/runtime';

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  origin: string;
}

export interface PageLink {
  text: string;
  href: string;
}

export interface PageSnapshot {
  url: string;
  origin: string;
  title: string;
  text: string;
  links: PageLink[];
  truncated: boolean;
}

export interface BrowserBackend {
  listTabs(): Promise<TabInfo[]>;
  getActiveTab(): Promise<TabInfo>;
  readPage(tabId?: string): Promise<PageSnapshot>;
  readSelection(tabId?: string): Promise<{ text: string; origin: string }>;
  getLinks(tabId?: string): Promise<PageLink[]>;
  getAccessibilityTree(tabId?: string): Promise<unknown>;
}

/** Content hash for provenance/dedup (non-cryptographic; integrity uses artifact sha256). */
export function contentHash(text: string): string {
  let h1 = 0xdeadbeef;
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

function readOnlyTool(id: string, name: string, description: string, extraSchema = {}): CabotTool {
  return {
    id,
    source: 'builtin',
    name,
    description,
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' }, ...extraSchema } },
    capabilityClass: 'read-only',
    provenance: 'builtin',
    annotations: { readOnlyHint: true },
  };
}

export const BROWSER_READ_TOOLS: CabotTool[] = [
  readOnlyTool('browser.list_tabs', 'list_tabs', 'List open tabs (id, url, title). No page content.'),
  readOnlyTool('browser.get_active_tab', 'get_active_tab', 'Describe the active tab (id, url, title). No page content.'),
  readOnlyTool('browser.read_page', 'read_page', 'Read title, text and links of a tab. Captured as a durable source with origin provenance.'),
  readOnlyTool('browser.read_selection', 'read_selection', 'Read the current user selection in a tab.'),
  readOnlyTool('browser.get_links', 'get_links', 'List links of a tab without full text.'),
  readOnlyTool('browser.get_accessibility_tree', 'get_accessibility_tree', 'Semantic accessibility snapshot of a tab.'),
];

export function registerBrowserTools(register: (t: CabotTool) => void): void {
  for (const t of BROWSER_READ_TOOLS) register(t);
}

export class BrowserToolExecutor implements ToolExecutor {
  constructor(
    private backend: BrowserBackend,
    private store: DurableStore,
    private taskId: string,
    private projectId: string,
  ) {}

  async execute(toolId: string, args: unknown): Promise<ToolExecution> {
    const tabId = (args as { tabId?: string } | undefined)?.tabId;
    try {
      switch (toolId) {
        case 'browser.list_tabs': {
          const tabs = await this.backend.listTabs();
          return { ok: true, resultHash: contentHash(JSON.stringify(tabs)), result: tabs };
        }
        case 'browser.get_active_tab': {
          const tab = await this.backend.getActiveTab();
          return { ok: true, resultHash: contentHash(JSON.stringify(tab)), result: tab };
        }
        case 'browser.read_page': {
          const page = await this.backend.readPage(tabId);
          const hash = contentHash(page.text);
          this.store.captureSource({
            projectId: this.projectId,
            taskId: this.taskId,
            uri: page.url,
            origin: page.origin,
            sha256: hash,
          });
          return { ok: true, resultHash: hash, result: page };
        }
        case 'browser.read_selection': {
          const sel = await this.backend.readSelection(tabId);
          return { ok: true, resultHash: contentHash(sel.text), result: sel };
        }
        case 'browser.get_links': {
          const links = await this.backend.getLinks(tabId);
          return { ok: true, resultHash: contentHash(JSON.stringify(links)), result: links };
        }
        case 'browser.get_accessibility_tree': {
          const tree = await this.backend.getAccessibilityTree(tabId);
          return { ok: true, resultHash: contentHash(JSON.stringify(tree)), result: tree };
        }
        default:
          return { ok: false, error: `unknown browser tool ${toolId}` };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
