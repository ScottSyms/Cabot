import { renderWorkspace } from './workspace.js';
import type { PanelClient } from '../ui/dom.js';
import '../workspace.css';

const client: PanelClient = {
  send<T>(msg: unknown): Promise<T> {
    return chrome.runtime.sendMessage(msg) as Promise<T>;
  },
};

const root = document.getElementById('cabot-root');
if (!root) throw new Error('workspace root missing');
const ws = renderWorkspace(root, client);

// Live refresh on runtime events; the workspace preserves selection,
// drafts, and scroll position across updates.
chrome.runtime.onMessage.addListener((msg) => {
  const m = msg as { type?: string; kind?: string };
  if (m.type === 'cabot.event') void ws.refresh();
});
