// MV3 service worker: event-driven supervisor, NOT the durable agent process.
// Responsibilities (spec §5.1): extension events, UI requests, permission
// prompts, privileged chrome.* calls, alarms/wake-up, offscreen lifecycle,
// message routing, rehydration after restart. Authoritative state lives in
// SQLite (Storage Worker); never in service-worker globals.
import { DurableStore, loadStore, openDatabase } from '@cabot/storage';

const DB_NAME = 'cabot.db';
const OFFSCREEN_URL = 'dist/offscreen.html';
const REHYDRATE_ALARM = 'cabot-rehydrate';

export interface SupervisorDeps {
  openDb: (name: string) => ReturnType<typeof openDatabase>;
  ensureOffscreenDocument: () => Promise<void>;
  notifyClients: (msg: unknown) => void;
}

export function createSupervisor(deps: SupervisorDeps) {
  let cachedStore: DurableStore | undefined;

  /** Load durable state; reconcile non-terminal tasks after any restart. */
  function rehydrate(): DurableStore {
    const db = deps.openDb(DB_NAME);
    try {
      const store = loadStore(db);
      const uncertain = store.reconcileAfterRestart();
      cachedStore = store;
      deps.notifyClients({ type: 'rehydrated', uncertainOperations: uncertain.map((o) => o.id) });
      return store;
    } finally {
      db.close();
    }
  }

  async function ensureRuntime(): Promise<void> {
    // Supervisor never executes agent turns itself; it guarantees the
    // offscreen coordinator exists, then steps aside.
    await deps.ensureOffscreenDocument();
  }

  async function onMessage(msg: unknown): Promise<unknown> {
    const m = msg as { type?: string };
    switch (m.type) {
      case 'cabot.ping':
        return { type: 'cabot.pong' };
      case 'cabot.rehydrate': {
        const store = rehydrate();
        await ensureRuntime();
        return { type: 'rehydrated', tasks: [...store.tasks.keys()] };
      }
      case 'cabot.ensure-runtime':
        await ensureRuntime();
        return { type: 'runtime-ensured' };
      default:
        return { type: 'unknown-message' };
    }
  }

  return { rehydrate, ensureRuntime, onMessage, getCachedStore: () => cachedStore };
}

// ---- wiring (executed only inside the extension worker context) ----
export function wireExtensionRuntime(): void {
  if (typeof chrome === 'undefined') return;
  const supervisor = createSupervisor({
    openDb: (name: string) => openDatabase(name),
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
  });
  chrome.alarms.create(REHYDRATE_ALARM, { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === REHYDRATE_ALARM) {
      supervisor.rehydrate();
      void supervisor.ensureRuntime();
    }
  });
  void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
