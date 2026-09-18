// Read-only browser tools (spec §10, first slice).
// The model never touches chrome.* APIs: it requests tool calls, the
// Capability Broker authorizes them, and BrowserToolExecutor runs them
// against a BrowserBackend. ChromeBrowserBackend uses privileged extension
// APIs in the supervisor context; tests use FakeBrowserBackend.
// Page reads are captured as durable Sources with origin provenance.
import type { CabotTool } from '@cabot/contracts';
import { DurableStore } from '@cabot/storage/browser-chrome';
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
  // Write path (spec §10). Element ids are semantic handles issued with a
  // snapshot; backends MUST reject actions whose expected text no longer
  // matches (stale-target check) before acting.
  navigate(url: string, tabId?: string): Promise<TabInfo>;
  goBack(tabId?: string): Promise<void>;
  goForward(tabId?: string): Promise<void>;
  click(elementId: string, expectedText: string, tabId?: string): Promise<void>;
  typeText(elementId: string, expectedText: string, text: string, tabId?: string): Promise<void>;
  select(elementId: string, expectedText: string, value: string, tabId?: string): Promise<void>;
  scroll(direction: 'up' | 'down', tabId?: string): Promise<void>;
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

// Write-path classification (spec §9.3, conservative):
// navigation is reversible; click/type/select/scroll can trigger page-side
// effects (JS handlers, drafts) so they are external-mutation; submit can
// publish, purchase, or send — consequential, always approval-gated.
export const BROWSER_WRITE_TOOLS: CabotTool[] = [
  {
    id: 'browser.navigate', source: 'builtin', name: 'navigate',
    description:
      'Open an http(s) URL. Omit tabId to open a new tab in the background (grouped, without stealing focus); non-web URLs (chrome://, chrome-extension://, file://) are refused.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'string' } }, required: ['url'] },
    capabilityClass: 'reversible', provenance: 'builtin',
  },
  {
    id: 'browser.go_back', source: 'builtin', name: 'go_back',
    description: 'Navigate back in a tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    capabilityClass: 'reversible', provenance: 'builtin',
  },
  {
    id: 'browser.go_forward', source: 'builtin', name: 'go_forward',
    description: 'Navigate forward in a tab.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } },
    capabilityClass: 'reversible', provenance: 'builtin',
  },
  {
    id: 'browser.click', source: 'builtin', name: 'click',
    description: 'Click a page element by semantic id. Rejected if the element text changed since observation.',
    inputSchema: { type: 'object', properties: { elementId: { type: 'string' }, expectedText: { type: 'string' }, tabId: { type: 'string' } }, required: ['elementId', 'expectedText'] },
    capabilityClass: 'external-mutation', provenance: 'builtin',
  },
  {
    id: 'browser.type', source: 'builtin', name: 'type',
    description: 'Type text into a page element by semantic id. Rejected if the element text changed since observation.',
    inputSchema: { type: 'object', properties: { elementId: { type: 'string' }, expectedText: { type: 'string' }, text: { type: 'string' }, tabId: { type: 'string' } }, required: ['elementId', 'expectedText', 'text'] },
    capabilityClass: 'external-mutation', provenance: 'builtin',
  },
  {
    id: 'browser.select', source: 'builtin', name: 'select',
    description: 'Choose an option in a select element by semantic id.',
    inputSchema: { type: 'object', properties: { elementId: { type: 'string' }, expectedText: { type: 'string' }, value: { type: 'string' }, tabId: { type: 'string' } }, required: ['elementId', 'expectedText', 'value'] },
    capabilityClass: 'external-mutation', provenance: 'builtin',
  },
  {
    id: 'browser.scroll', source: 'builtin', name: 'scroll',
    description: 'Scroll a tab up or down.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] }, tabId: { type: 'string' } }, required: ['direction'] },
    capabilityClass: 'external-mutation', provenance: 'builtin',
  },
  {
    id: 'browser.submit', source: 'builtin', name: 'submit',
    description: 'Submit a form. Consequential: requires explicit user approval immediately before execution.',
    inputSchema: { type: 'object', properties: { elementId: { type: 'string' }, expectedText: { type: 'string' }, tabId: { type: 'string' } }, required: ['elementId', 'expectedText'] },
    capabilityClass: 'consequential', provenance: 'builtin',
    annotations: { consequentialHint: true },
  },
];

export const BROWSER_TOOLS: CabotTool[] = [...BROWSER_READ_TOOLS, ...BROWSER_WRITE_TOOLS];

export function registerBrowserTools(register: (t: CabotTool) => void): void {
  for (const t of BROWSER_TOOLS) register(t);
}

/** Per-tab serialization: conflicting actions on the same tab never overlap. */
export class TabMutex {
  private chains = new Map<string, Promise<void>>();

  async run<T>(tabId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(tabId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.chains.set(tabId, prior.then(() => gate));
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(tabId)?.then) {
        // Leave chain cleanup to subsequent runs; harmless if stale.
      }
    }
  }
}

export class BrowserToolExecutor implements ToolExecutor {
  private mutex = new TabMutex();

  constructor(
    private backend: BrowserBackend,
    private store: DurableStore,
    private taskId: string,
    private projectId: string,
  ) {}

  async execute(toolId: string, args: unknown): Promise<ToolExecution> {
    const a = (args as Record<string, string> | undefined) ?? {};
    const tabId = a.tabId;
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
        // Write path: serialized per tab; significant actions audit-logged.
        // NOTE: browser.submit reaches here only after broker approval +
        // dispatch-time binding recheck (loop.ts); the executor is not the
        // authorization point.
        case 'browser.navigate': {
          const tab = await this.mutex.run(tabId ?? 'default', () => this.backend.navigate(a.url, tabId));
          this.store.appendEvent(this.taskId, 'browser.navigated', `→ ${tab.url}`);
          return { ok: true, resultHash: contentHash(tab.url), result: tab };
        }
        case 'browser.go_back': {
          await this.mutex.run(tabId ?? 'default', () => this.backend.goBack(tabId));
          return { ok: true, resultHash: contentHash(`back:${Date.now()}`) };
        }
        case 'browser.go_forward': {
          await this.mutex.run(tabId ?? 'default', () => this.backend.goForward(tabId));
          return { ok: true, resultHash: contentHash(`fwd:${Date.now()}`) };
        }
        case 'browser.click': {
          await this.mutex.run(tabId ?? 'default', () => this.backend.click(a.elementId, a.expectedText, tabId));
          this.store.appendEvent(this.taskId, 'browser.clicked', `${a.elementId}`);
          return { ok: true, resultHash: contentHash(`click:${a.elementId}:${a.expectedText}`) };
        }
        case 'browser.type': {
          await this.mutex.run(tabId ?? 'default', () => this.backend.typeText(a.elementId, a.expectedText, a.text, tabId));
          return { ok: true, resultHash: contentHash(`type:${a.elementId}:${a.text}`) };
        }
        case 'browser.select': {
          await this.mutex.run(tabId ?? 'default', () => this.backend.select(a.elementId, a.expectedText, a.value, tabId));
          return { ok: true, resultHash: contentHash(`select:${a.elementId}:${a.value}`) };
        }
        case 'browser.scroll': {
          const dir = a.direction === 'up' ? 'up' : 'down';
          await this.mutex.run(tabId ?? 'default', () => this.backend.scroll(dir, tabId));
          return { ok: true, resultHash: contentHash(`scroll:${dir}`) };
        }
        case 'browser.submit': {
          await this.mutex.run(tabId ?? 'default', () => this.backend.click(a.elementId, a.expectedText, tabId));
          this.store.appendEvent(this.taskId, 'browser.submitted', `${a.elementId} (approval-bound)`);
          this.store.commitCheckpoint(this.taskId);
          return { ok: true, resultHash: contentHash(`submit:${a.elementId}:${a.expectedText}`) };
        }
        default:
          return { ok: false, error: `unknown browser tool ${toolId}` };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
