import { ChromeStorageBackend } from '@cabot/storage/browser-chrome';
import { chromeSettingsStore, createCoordinator, type CoordinatorMessage } from './coordinator.js';

async function main(): Promise<void> {
  const coord = createCoordinator({
    snapshots: new ChromeStorageBackend(),
    settings: chromeSettingsStore(),
  });
  await coord.boot();
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    void coord
      .handleMessage(msg as CoordinatorMessage)
      .then(respond, (e: unknown) => respond({ error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}

void main();
