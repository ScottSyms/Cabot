// Offscreen coordinator (spec §5.2): hosts agent workers, holds NO
// authoritative state in memory. Every turn result is checkpointed to the
// Storage Worker/SQLite; this document may be destroyed at any time and the
// supervisor recreates it. Workers are disposable execution resources.
import { DurableStore, loadStore, openDatabase } from '@cabot/storage';
import { CapabilityBroker } from '@cabot/policy';
import type { ModelProvider } from '@cabot/providers';
import { CabotRuntimeService } from '@cabot/runtime';

const DB_NAME = 'cabot.db';

export interface CoordinatorDeps {
  openDb: () => ReturnType<typeof openDatabase>;
  model: ModelProvider;
  tools: { registerDefaults(broker: CapabilityBroker): void };
}

export function createCoordinator(deps: CoordinatorDeps) {
  let store: DurableStore | undefined;
  let broker: CapabilityBroker | undefined;
  let runtime: CabotRuntimeService | undefined;

  function boot(): void {
    const db = deps.openDb();
    try {
      store = loadStore(db);
      store.reconcileAfterRestart();
    } finally {
      db.close();
    }
    broker = new CapabilityBroker(store);
    deps.tools.registerDefaults(broker);
    runtime = new CabotRuntimeService(store, broker, deps.model);
  }

  function getRuntime(): CabotRuntimeService {
    if (!runtime) boot();
    return runtime!;
  }

  /** Replaceable after loss: re-boot from durable state, nothing cached elsewhere. */
  function reboot(): void {
    store = undefined;
    broker = undefined;
    runtime = undefined;
    boot();
  }

  return { boot, reboot, getRuntime };
}
