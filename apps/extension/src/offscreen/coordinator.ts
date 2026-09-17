// Offscreen coordinator (spec §5.2): hosts agent workers, holds NO
// authoritative state in memory. Every turn persists the snapshot; this
// document may be destroyed at any time and the supervisor recreates it.
// Workers are disposable execution resources.
import {
  DurableStore,
  restoreStore,
  serializeStore,
  type SnapshotBackend,
} from '@cabot/storage/browser-chrome';
import { CapabilityBroker } from '@cabot/policy';
import { OpenAICompatibleProvider } from '@cabot/providers';
import { CabotRuntimeService } from '@cabot/runtime';
import type { TaskId } from '@cabot/contracts';
import { BrowserToolExecutor, registerBrowserTools, type BrowserBackend } from '@cabot/tools';

export interface ProviderSettings {
  endpoint: string;
  apiKey?: string;
  modelId: string;
  /** Operator behavior instructions, appended to the fixed safety preamble. */
  systemPrompt?: string;
  /** Default per-agent limits applied when a task creates its agent. */
  budget?: { maxModelCalls?: number; maxToolCalls?: number; maxRuntimeMinutes?: number };
}

export const DEFAULT_BUDGET = { maxModelCalls: 60, maxToolCalls: 150, maxRuntimeMinutes: 30 };

export function effectiveBudget(settings: ProviderSettings | null): { maxModelCalls: number; maxToolCalls: number } {
  return {
    maxModelCalls: settings?.budget?.maxModelCalls ?? DEFAULT_BUDGET.maxModelCalls,
    maxToolCalls: settings?.budget?.maxToolCalls ?? DEFAULT_BUDGET.maxToolCalls,
  };
}

export interface SettingsStore {
  load(): Promise<ProviderSettings | null>;
  save(s: ProviderSettings): Promise<void>;
}

export const SETTINGS_KEY = 'cabot.settings.v1';

export function chromeSettingsStore(): SettingsStore {
  const area = () => {
    const g = globalThis as unknown as { chrome?: { storage?: { local?: {
      get(k: string): Promise<Record<string, unknown>>;
      set(o: Record<string, unknown>): Promise<void>;
    } } } };
    if (!g.chrome?.storage?.local) throw new Error('chrome.storage.local unavailable');
    return g.chrome.storage.local;
  };
  return {
    async load(): Promise<ProviderSettings | null> {
      const got = await area().get(SETTINGS_KEY);
      const v = got[SETTINGS_KEY] as ProviderSettings | undefined;
      return v && typeof v.endpoint === 'string' ? v : null;
    },
    async save(s: ProviderSettings): Promise<void> {
      await area().set({ [SETTINGS_KEY]: s });
    },
  };
}

export type CoordinatorMessage =
  | { type: 'cabot.ping' }
  | { type: 'cabot.boot-warning' }
  | { type: 'cabot.list-tasks' }
  | { type: 'cabot.task-detail'; taskId: string }
  | { type: 'cabot.list-agents' }
  | { type: 'cabot.agent-detail'; agentId: string }
  | { type: 'cabot.remove-agent'; agentId: string }
  | { type: 'cabot.pending-approvals' }
  | { type: 'cabot.decide-approval'; approvalId: string; decision: 'granted' | 'denied' }
  | { type: 'cabot.pause-task'; taskId: string }
  | { type: 'cabot.resume-task'; taskId: string }
  | { type: 'cabot.cancel-task'; taskId: string }
  | { type: 'cabot.run-summary'; objective: string; projectName?: string }
  | { type: 'cabot.send-message'; taskId: string; text: string }
  | { type: 'cabot.extend-budget'; agentId: string; maxModelCalls?: number; maxToolCalls?: number }
  | { type: 'cabot.get-settings' }
  | { type: 'cabot.save-settings'; settings: ProviderSettings };
export interface CoordinatorDeps {
  snapshots: SnapshotBackend;
  settings: SettingsStore;
  /** Browser backend: relay-to-supervisor in the extension, fake in tests. */
  browserBackend: BrowserBackend;
}

/**
 * One loop per task. A second run request while one is in flight is rejected
 * so steering messages queue into the active run instead of racing it.
 */
export function createRunLock() {
  const inFlight = new Set<string>();
  return {
    isRunning: (id: string): boolean => inFlight.has(id),
    tryAcquire: (id: string): boolean => {
      if (inFlight.has(id)) return false;
      inFlight.add(id);
      return true;
    },
    release: (id: string): void => {
      inFlight.delete(id);
    },
    async runExclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
      if (!this.tryAcquire(id)) throw new Error(`run already in flight for ${id}`);
      try {
        return await fn();
      } finally {
        this.release(id);
      }
    },
  };
}

/** File-backed settings (e.g. OPFS) with latch-to-fallback on failure. */
export function withFallbackSettings(primary: SettingsStore, fallback: SettingsStore): SettingsStore {
  let useFallback = false;
  return {
    async load(): Promise<ProviderSettings | null> {
      if (!useFallback) {
        try {
          return await primary.load();
        } catch {
          useFallback = true;
        }
      }
      return fallback.load();
    },
    async save(s: ProviderSettings): Promise<void> {
      if (!useFallback) {
        try {
          await primary.save(s);
          return;
        } catch {
          useFallback = true;
        }
      }
      await fallback.save(s);
    },
  };
}

/** Settings persisted as JSON through any snapshot backend. */
export function fileSettingsStore(snapshots: SnapshotBackend): SettingsStore {
  return {
    async load(): Promise<ProviderSettings | null> {
      const raw = await snapshots.load();
      if (!raw) return null;
      try {
        const v = JSON.parse(raw) as ProviderSettings;
        return v && typeof v.endpoint === 'string' ? v : null;
      } catch {
        return null;
      }
    },
    async save(s: ProviderSettings): Promise<void> {
      await snapshots.save(JSON.stringify(s));
    },
  };
}

/** Safety turn cap aligned with the model-call budget so budget is the real
 *  limit; the cap only prevents an unbounded loop when no budget is set. */
export function turnCapFor(agent: { budget: { maxModelCalls?: number } }): number {
  return Math.max(25, (agent.budget.maxModelCalls ?? DEFAULT_BUDGET.maxModelCalls) + 2);
}

export function createCoordinator(deps: CoordinatorDeps) {
  let store: DurableStore | undefined;
  let broker: CapabilityBroker | undefined;
  let warning: string | null = null;
  const runs = createRunLock();

  async function persist(): Promise<void> {
    if (store) await deps.snapshots.save(serializeStore(store));
  }

  async function boot(): Promise<void> {
    warning = null;
    const raw = await deps.snapshots.load();
    store = new DurableStore();
    if (raw) {
      try {
        store = restoreStore(raw);
      } catch (e) {
        // A corrupt snapshot must never brick the runtime forever: quarantine
        // the payload for inspection and start fresh.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        try {
          await deps.snapshots.saveBackup?.(`corrupt-${stamp}`, raw);
        } catch {
          // Backup is best-effort; booting fresh matters more.
        }
        const cause = e instanceof Error ? e.message : String(e);
        warning = `stored snapshot unreadable (${cause}); quarantined backup, started fresh`;
        console.warn(`[cabot] ${warning}`);
      }
    }
    store.reconcileAfterRestart();
    broker = new CapabilityBroker(store);
    registerBrowserTools((t) => broker!.registerTool(t));
    await persist();
    const switches = (deps.snapshots as unknown as { switches?: string[] }).switches;
    if (switches && switches.length > 0 && !warning) {
      warning = `snapshots: ${switches[switches.length - 1]}`;
    }
  }

  function ready(): { store: DurableStore; broker: CapabilityBroker } {
    if (!store || !broker) throw new Error('coordinator not booted');
    return { store, broker };
  }

  /** Replaceable after loss: re-boot from durable state. */
  async function reboot(): Promise<void> {
    store = undefined;
    broker = undefined;
    await boot();
  }

  /** Query-only service: model never invoked by inspection paths. */
  function queryService(): CabotRuntimeService {
    const { store: s, broker: b } = ready();
    return new CabotRuntimeService(
      s,
      b,
      {
        id: 'none',
        listModels: async () => [],
        decide: async () => {
          throw new Error('no model configured for queries');
        },
      },
    );
  }

  /** Broadcast a runtime event to extension UIs (panel refreshes on these). */
  function emit(kind: string, taskId?: string, extra?: Record<string, unknown>): void {
    try {
      const g = globalThis as unknown as { chrome?: { runtime?: { sendMessage(m: unknown): void } } };
      g.chrome?.runtime?.sendMessage({ type: 'cabot.event', kind, taskId, ...extra });
    } catch {
      // No listeners (e.g. tests) — safe to ignore.
    }
  }

  /**
   * Recover work lost to a runtime termination (extension reload, offscreen
   * kill, browser restart). Interrupted tasks with no uncertain operation
   * resume automatically; ones with an uncertain external effect are parked
   * BLOCKED for review. Never runs without a configured provider.
   */
  async function resumeInterrupted(): Promise<TaskId[]> {
    const resumed = queryService().resumeInterruptedTasks();
    if (resumed.length === 0) return [];
    await persist();
    emit('auto-resumed', undefined, { taskIds: resumed });
    const settings = await deps.settings.load().catch(() => null);
    if (!settings) return resumed; // parked READY; runs once configured
    for (const taskId of resumed) {
      void continueTask(taskId).catch(async (e: unknown) => {
        const { store: s } = ready();
        s.appendEvent(taskId, 'task.blocked', `auto-resume failed: ${e instanceof Error ? e.message : String(e)}`);
        await persist().catch(() => {});
      });
    }
    return resumed;
  }

  async function continueTask(taskId: string): Promise<unknown> {
    const { store: s, broker: b } = ready();
    const task = s.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    const settings = await deps.settings.load();
    if (!settings) throw new Error('provider not configured — open Settings first');
    const provider = new OpenAICompatibleProvider({ endpoint: settings.endpoint, apiKey: settings.apiKey, modelId: settings.modelId });
    const project = s.projects.get(task.projectId);
    if (!project) throw new Error('project missing for task');
    const executor = new BrowserToolExecutor(deps.browserBackend, s, task.id, project.id);
    const svc = new CabotRuntimeService(s, b, provider, executor);
    // Hold the task lock for the whole run so cancel/send can tell whether a
    // loop is actually in flight.
    const outcome = await runs.runExclusive(task.id, () =>
      svc.runTask(
        task.id,
        task.ownerAgentId,
        turnCapFor(s.agents.get(task.ownerAgentId) ?? { budget: {} }),
        () => {
          // Per-turn: persist, then tell UIs to refresh (selection, drafts,
          // and scroll are preserved panel-side).
          emit('task-progress', task.id);
          return persist().catch(() => {});
        },
        { systemPrompt: settings.systemPrompt },
      ),
    );
    await persist();
    const status = (outcome as { status: string }).status;
    emit(status === 'approval-required' ? 'approval-requested' : `task-${status}`, task.id, { outcome });
    return { outcome };
  }

  async function runSummary(objective: string, projectName = 'Research'): Promise<{ taskId: string; outcome: unknown }> {
    const { store: s, broker: b } = ready();
    const settings = await deps.settings.load();
    if (!settings) throw new Error('provider not configured — open Settings first');
    const provider = new OpenAICompatibleProvider({ endpoint: settings.endpoint, apiKey: settings.apiKey, modelId: settings.modelId });

    let project = [...s.projects.values()].find((p) => p.name === projectName);
    if (!project) project = s.createProject(projectName);
    const agent = s.createAgent({
      projectId: project.id, role: 'researcher', objective, status: 'RUNNING',
      modelConfig: { providerId: 'openai-compatible', modelId: settings.modelId },
      skillIds: [], budget: effectiveBudget(settings),
      workspaceMounts: [], delegationDepth: 0,
    });
    const task = s.createTask({ projectId: project.id, ownerAgentId: agent.id, title: objective.slice(0, 80), objective });
    for (const toolId of ['browser.list_tabs', 'browser.get_active_tab', 'browser.read_page', 'browser.read_selection', 'browser.get_links']) {
      b.grant({ principal: { kind: 'core-agent', agentId: agent.id }, toolId, scope: 'task', taskId: task.id });
    }
    const executor = new BrowserToolExecutor(deps.browserBackend, s, task.id, project.id);
    const svc = new CabotRuntimeService(s, b, provider, executor);
    await persist();
    const outcome = await runs.runExclusive(task.id, () =>
      svc.runTask(
        task.id,
        agent.id,
        turnCapFor(agent),
        () => {
          emit('task-progress', task.id);
          return persist().catch(() => {});
        },
        { systemPrompt: settings.systemPrompt },
      ),
    );
    await persist();
    const done = (outcome as { status: string }).status;
    emit(done === 'approval-required' ? 'approval-requested' : `task-${done}`, task.id, { outcome });
    return { taskId: task.id, outcome };
  }

  async function handleMessage(msg: CoordinatorMessage): Promise<unknown> {
    // Lightweight service for read-only queries (no model needed).
    const queries = queryService();
    switch (msg.type) {
      case 'cabot.ping':
        return { type: 'cabot.pong' };
      case 'cabot.boot-warning':
        return { warning: warning };
      case 'cabot.list-tasks':
        return { tasks: queries.listTasks() };
      case 'cabot.task-detail':
        return { detail: queries.getTaskDetail(msg.taskId) };
      case 'cabot.list-agents':
        return { agents: queries.listAgents() };
      case 'cabot.agent-detail':
        return { agent: queries.inspectAgent(msg.agentId) };
      case 'cabot.remove-agent': {
        const removed = queries.removeAgent(msg.agentId);
        await persist();
        emit('agent-removed', undefined, { agentId: msg.agentId });
        return { ok: true, removed };
      }
      case 'cabot.pending-approvals':
        return { approvals: queries.listPendingApprovals() };
      case 'cabot.decide-approval':
        queries.decideApproval(msg.approvalId, msg.decision);
        await persist();
        return { ok: true };
      case 'cabot.pause-task':
        queries.pauseTask(msg.taskId);
        await persist();
        return { ok: true };
      case 'cabot.resume-task':
        queries.resumeTask(msg.taskId);
        await persist();
        return { ok: true };
      case 'cabot.cancel-task': {
        // A running loop observes a cooperative request at the next turn
        // boundary. With no loop in flight nobody would ever observe it, so
        // cancel directly and let the task/agent move to history.
        const cooperative = runs.isRunning(msg.taskId);
        if (cooperative) queries.cancelTask(msg.taskId);
        else queries.cancelTaskNow(msg.taskId);
        await persist();
        emit('task-cancelled', msg.taskId, { cooperative });
        return { ok: true, cooperative };
      }
      case 'cabot.run-summary':
        // Each run creates its own task; the lock is taken inside runSummary.
        return runSummary(msg.objective, msg.projectName);
      case 'cabot.send-message': {
        queries.sendUserMessage(msg.taskId, msg.text);
        await persist();
        if (runs.isRunning(msg.taskId)) {
          // A loop is already working this task; the message is in its
          // context and the next turn picks it up. Never start a second loop.
          emit('user-message-queued', msg.taskId);
          return { taskId: msg.taskId, queued: true as const };
        }
        return {
          taskId: msg.taskId,
          ...(await continueTask(msg.taskId) as Record<string, unknown>),
        };
      }
      case 'cabot.extend-budget': {
        const agent = queries.extendBudget(msg.agentId, {
          maxModelCalls: msg.maxModelCalls,
          maxToolCalls: msg.maxToolCalls,
        });
        await persist();
        emit('budget-extended', undefined, { agentId: msg.agentId, budget: agent.budget });
        return { ok: true, budget: agent.budget, spent: agent.spent };
      }
      case 'cabot.get-settings': {
        const s = await deps.settings.load();
        // The key never leaves the coordinator toward UI contexts; the panel
        // only learns whether one is stored. Prompt and budget are safe to show.
        return {
          settings: s
            ? { endpoint: s.endpoint, modelId: s.modelId, systemPrompt: s.systemPrompt, budget: s.budget }
            : null,
          hasApiKey: !!s?.apiKey,
        };
      }
      case 'cabot.save-settings': {
        const prev = await deps.settings.load().catch(() => null);
        const incoming = msg.settings;
        // Blank key means "keep the stored one", not "delete it".
        await deps.settings.save({
          endpoint: incoming.endpoint,
          modelId: incoming.modelId,
          apiKey: incoming.apiKey || prev?.apiKey,
          systemPrompt: incoming.systemPrompt,
          budget: incoming.budget,
        });
        return { ok: true };
      }
      default:
        throw new Error(`unknown message ${(msg as { type: string }).type}`);
    }
  }

  return { boot, reboot, persist, runSummary, handleMessage, ready, resumeInterrupted, bootWarning: () => warning };
}
