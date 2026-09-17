import { renderSidePanel, type PanelClient } from './sidepanel.js';

const client: PanelClient = {
  send<T>(msg: unknown): Promise<T> {
    return chrome.runtime.sendMessage(msg) as Promise<T>;
  },
};

const root = document.getElementById('cabot-root');
if (!root) throw new Error('sidepanel root missing');
renderSidePanel(root, client);
