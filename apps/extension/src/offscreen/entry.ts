import { ChromeStorageBackend } from '@cabot/storage/browser-chrome';
import { chromeSettingsStore, createCoordinator, type CoordinatorMessage } from './coordinator.js';

async function main(): Promise<void> {
  const coord = createCoordinator({
    snapshots: new ChromeStorageBackend(),
    settings: chromeSettingsStore(),
  });
  await coord.boot();
  // Only supervisor-forwarded messages are executed. Panel broadcasts reach
  // every context; without this guard each run would execute twice.
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if ((msg as { via?: string }).via !== 'supervisor') return;
    void coord
      .handleMessage(msg as CoordinatorMessage)
      .then(respond, (e: unknown) => respond({ error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}

void main();
