import { ChromeStorageBackend } from '@cabot/storage/browser-chrome';
import { chromeSettingsStore, createCoordinator, type CoordinatorMessage } from './coordinator.js';

let booted = false;

async function main(): Promise<void> {
  const coord = createCoordinator({
    snapshots: new ChromeStorageBackend(),
    settings: chromeSettingsStore(),
  });
  // Listener registers before boot finishes so senders get an explicit
  // not-ready error instead of an empty response. Only supervisor-forwarded
  // messages are executed: panel broadcasts reach every context, and without
  // this guard each run would execute twice.
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if ((msg as { via?: string }).via !== 'supervisor') return;
    if (!booted) {
      respond({ error: 'Cabot runtime still starting — retry in a moment' });
      return;
    }
    void coord
      .handleMessage(msg as CoordinatorMessage)
      .then(respond, (e: unknown) => respond({ error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
  await coord.boot();
  booted = true;
}

void main().catch((e: unknown) => {
  // Boot failure (e.g. storage unavailable) must stay observable: the
  // listener above is already registered and reports not-ready, but log
  // the cause for chrome://extensions inspection.
  console.error('[cabot] offscreen boot failed:', e);
});
