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

const OFFSCREEN_URL = 'dist/offscreen.html';
const REHYDRATE_ALARM = 'cabot-rehydrate';

export interface SupervisorDeps {
  snapshots: SnapshotBackend;
  ensureOffscreenDocument: () => Promise<void>;
  notifyClients: (msg: unknown) => void;
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
    // offscreen coordinator exists, then steps aside.
    await deps.ensureOffscreenDocument();
  }

  /** Forward UI intent to the offscreen coordinator via runtime messaging. */
  async function forwardToRuntime(msg: unknown): Promise<unknown> {
    await ensureRuntime();
    const g = globalThis as unknown as {
      chrome?: { runtime?: { sendMessage(msg: unknown): Promise<unknown> } };
    };
    if (!g.chrome?.runtime?.sendMessage) throw new Error('chrome.runtime messaging unavailable');
    return g.chrome.runtime.sendMessage({ ...msg as Record<string, unknown>, via: 'supervisor' });
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
      default:
        // All runtime operations live in the offscreen coordinator.
        return forwardToRuntime(msg);
    }
  }

  return { rehydrate, ensureRuntime, onMessage };
}

// ---- wiring (executed only inside the extension worker context) ----
export function wireExtensionRuntime(): void {
  if (typeof chrome === 'undefined') return;
  const supervisor = createSupervisor({
    snapshots: new ChromeStorageBackend(),
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
      void supervisor.onMessage(msg).then(respond);
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
