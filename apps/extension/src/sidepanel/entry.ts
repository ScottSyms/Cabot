import { renderSidePanel, type PanelClient } from './sidepanel.js';

const client: PanelClient = {
  send<T>(msg: unknown): Promise<T> {
    return chrome.runtime.sendMessage(msg) as Promise<T>;
  },
};

const root = document.getElementById('cabot-root');
if (!root) throw new Error('sidepanel root missing');
const panel = renderSidePanel(root, client);

// Live refresh: the offscreen coordinator broadcasts cabot.event messages
// (task finished, approval requested, user message recorded).
chrome.runtime.onMessage.addListener((msg) => {
  const m = msg as { type?: string; kind?: string; taskId?: string };
  if (m.type === 'cabot.event') {
    const st = document.getElementById('cabot-status');
    if (st) st.textContent = `event: ${m.kind ?? 'update'}`;
    void panel.refresh();
  }
});
