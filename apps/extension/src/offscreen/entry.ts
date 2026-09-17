import {
  OpfsSnapshotBackend,
  navigatorOpfsRoot,
} from '@cabot/storage/browser-chrome';
import { RelayBrowserBackend } from '@cabot/tools';
import {
  createCoordinator,
  fileSettingsStore,
  type CoordinatorMessage,
} from './coordinator.js';

let booted = false;
let bootStage = 'starting';
let bootError: string | null = null;

function report(): string {
  return bootError ?? `still starting (stage: ${bootStage}) — retry in a moment`;
}

async function main(): Promise<void> {
  // OPFS-only persistence: snapshots and settings live as OPFS files, which
  // exist uniformly across offscreen, worker, and panel contexts.
  const snapshots = new OpfsSnapshotBackend(navigatorOpfsRoot());
  const settings = fileSettingsStore(new OpfsSnapshotBackend(navigatorOpfsRoot(), 'cabot', 'settings.json'));
  // Privileged tab calls execute in the service worker via relay.
  const browserBackend = new RelayBrowserBackend(async (msg) => {
    const g = globalThis as unknown as { chrome?: { runtime?: { sendMessage(m: unknown): Promise<unknown> } } };
    if (!g.chrome?.runtime?.sendMessage) throw new Error('chrome.runtime messaging unavailable');
    return g.chrome.runtime.sendMessage(msg);
  });
  const coord = createCoordinator({ snapshots, settings, browserBackend });
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
    // Recovery: pick up work lost to an extension reload or offscreen kill.
    // Fire-and-forget; failures are recorded as task events.
    void coord.resumeInterrupted().catch((e: unknown) => {
      console.error('[cabot] auto-resume failed:', e);
    });
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
