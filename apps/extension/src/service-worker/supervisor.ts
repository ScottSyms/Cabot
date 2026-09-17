// MV3 service worker: event-driven supervisor, NOT the durable agent process.
// Responsibilities (spec §5.1): extension events, UI requests, permission
// prompts, privileged chrome.* calls, alarms/wake-up, offscreen lifecycle,
// message routing, rehydration after restart. Authoritative state lives in
// the snapshot backend (chrome.storage.local in the browser); never in
// service-worker globals.
import {
  ChromeStorageBackend,
  DurableStore,
  restoreStore,
  serializeStore,
  type SnapshotBackend,
} from '@cabot/storage/browser-chrome';
import { ChromeBrowserBackend, type BrowserBackend } from '@cabot/tools';

const OFFSCREEN_URL = 'dist/offscreen.html';
const REHYDRATE_ALARM = 'cabot-rehydrate';

export interface SupervisorDeps {
  snapshots: SnapshotBackend;
  ensureOffscreenDocument: () => Promise<void>;
  notifyClients: (msg: unknown) => void;
  /** Privileged browser backend, exercised only in the worker context. */
  browser: BrowserBackend;
}

async function persist(snapshots: SnapshotBackend, store: DurableStore): Promise<void> {
  await snapshots.save(serializeStore(store));
}

export function createSupervisor(deps: SupervisorDeps) {
  /** Load durable state; reconcile non-terminal tasks after any restart. */
  async function rehydrate(): Promise<DurableStore> {
    const raw = await deps.snapshots.load();
    const store = raw ? restoreStore(raw) : new DurableStore();
    const uncertain = store.reconcileAfterRestart();
    await persist(deps.snapshots, store);
    deps.notifyClients({ type: 'rehydrated', uncertainOperations: uncertain.map((o) => o.id) });
    return store;
  }

  async function ensureRuntime(): Promise<void> {
    // Supervisor never executes agent turns itself; it guarantees the
    // offscreen coordinator exists and answers, then steps aside.
    await deps.ensureOffscreenDocument();
    await waitForCoordinator();
  }

  /** Readiness handshake: the document exists but its module may still boot. */
  async function waitForCoordinator(attempts = 20, delayMs = 250): Promise<void> {
    const g = globalThis as unknown as {
      chrome?: { runtime?: { sendMessage(msg: unknown): Promise<unknown> } };
    };
    const send = g.chrome?.runtime?.sendMessage;
    if (!send) throw new Error('chrome.runtime messaging unavailable');
    let lastError = 'no response';
    for (let i = 0; i < attempts; i += 1) {
      try {
        const res = (await send({ type: 'cabot.ping', via: 'supervisor' })) as { type?: string; error?: string } | null | undefined;
        if (res?.type === 'cabot.pong') return;
        lastError = res?.error ?? 'empty response';
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`Cabot runtime not ready after ${attempts * delayMs}ms: ${lastError}`);
  }

  /** Forward UI intent to the offscreen coordinator via runtime messaging. */
  async function forwardToRuntime(msg: unknown): Promise<unknown> {
    await ensureRuntime();
    const g = globalThis as unknown as {
      chrome?: { runtime?: { sendMessage(msg: unknown): Promise<unknown> } };
    };
    if (!g.chrome?.runtime?.sendMessage) throw new Error('chrome.runtime messaging unavailable');
    const res = await g.chrome.runtime.sendMessage({ ...(msg as Record<string, unknown>), via: 'supervisor' });
    if (!res || typeof res !== 'object' || 'error' in (res as Record<string, unknown>)) {
      throw new Error((res as { error?: string } | null)?.error ?? 'runtime returned an empty response');
    }
    return res;
  }

  async function onMessage(msg: unknown): Promise<unknown> {
    const m = msg as { type?: string };
    switch (m.type) {
      case 'cabot.ping':
        return { type: 'cabot.pong' };
      case 'cabot.rehydrate':
        await rehydrate();
        await ensureRuntime();
        return { type: 'rehydrated' };
      case 'cabot.event':
        return { type: 'event-ignored' }; // UI broadcast; never forwarded
      case 'cabot.browser-call':
        return runBrowserCall((msg as { call?: string; args?: unknown[] }).call, (msg as { args?: unknown[] }).args ?? []);
      default:
        // All runtime operations live in the offscreen coordinator.
        return forwardToRuntime(msg);
    }
  }

  /** Dispatch a privileged browser call in this (worker) context. */
  async function runBrowserCall(call: string | undefined, args: unknown[]): Promise<unknown> {
    const fn = (deps.browser as unknown as Record<string, unknown>)[call ?? ''];
    if (typeof fn !== 'function') return { error: `unknown browser call ${call}` };
    try {
      const result = await (fn as (...a: unknown[]) => Promise<unknown>).apply(deps.browser, args);
      return { ok: true, result };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return { rehydrate, ensureRuntime, onMessage };
}

// ---- wiring (executed only inside the extension worker context) ----
export function wireExtensionRuntime(): void {
  if (typeof chrome === 'undefined') return;
    const supervisor = createSupervisor({
      snapshots: new ChromeStorageBackend(),
      browser: new ChromeBrowserBackend(),
      ensureOffscreenDocument: async () => {
        try {
          await chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: ['WORKERS'],
            justification: 'Host Cabot agent workers off the UI thread.',
          });
        } catch {
          // Document already exists — expected on warm wake-ups.
        }
      },
      notifyClients: () => {},
    });

    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      void supervisor
        .onMessage(msg)
        .then(respond, (e: unknown) => respond({ error: e instanceof Error ? e.message : String(e) }));
      return true;
    });
    chrome.alarms.create(REHYDRATE_ALARM, { periodInMinutes: 5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === REHYDRATE_ALARM) {
        void supervisor.rehydrate().then(() => supervisor.ensureRuntime());
      }
    });
    void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
