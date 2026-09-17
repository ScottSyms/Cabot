import { ChromeStorageBackend } from '@cabot/storage/browser-chrome';
import { chromeSettingsStore, createCoordinator, type CoordinatorMessage } from './coordinator.js';

let booted = false;
let bootStage = 'starting';
let bootError: string | null = null;

function report(): string {
  return bootError ?? `still starting (stage: ${bootStage}) — retry in a moment`;
}

async function main(): Promise<void> {
  const coord = createCoordinator({
    snapshots: new ChromeStorageBackend(),
    settings: chromeSettingsStore(),
  });
  // Listener registers before boot finishes so senders get an explicit
  // diagnosis instead of an empty response. Only supervisor-forwarded
  // messages are executed: panel broadcasts reach every context, and without
  // this guard each run would execute twice.
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if ((msg as { via?: string }).via !== 'supervisor') return;
    if (!booted) {
      respond({ error: `Cabot runtime not ready: ${report()}` });
      return;
    }
    void coord
      .handleMessage(msg as CoordinatorMessage)
      .then(respond, (e: unknown) => respond({ error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
  try {
    bootStage = 'loading snapshot';
    await coord.boot();
    bootStage = 'ready';
    booted = true;
  } catch (e) {
    bootStage = 'failed';
    bootError = e instanceof Error ? e.message : String(e);
    console.error('[cabot] offscreen boot failed:', e);
  }
}

void main().catch((e: unknown) => {
  bootStage = 'failed';
  bootError = e instanceof Error ? e.message : String(e);
  console.error('[cabot] offscreen entry failed:', e);
});
