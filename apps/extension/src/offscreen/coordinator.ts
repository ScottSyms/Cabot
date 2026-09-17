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
import { BrowserToolExecutor, ChromeBrowserBackend, registerBrowserTools } from '@cabot/tools';

export interface ProviderSettings {
  endpoint: string;
  apiKey?: string;
  modelId: string;
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
  | { type: 'cabot.pending-approvals' }
  | { type: 'cabot.decide-approval'; approvalId: string; decision: 'granted' | 'denied' }
  | { type: 'cabot.pause-task'; taskId: string }
  | { type: 'cabot.resume-task'; taskId: string }
  | { type: 'cabot.cancel-task'; taskId: string }
  | { type: 'cabot.run-summary'; objective: string; projectName?: string }
  | { type: 'cabot.send-message'; taskId: string; text: string }
  | { type: 'cabot.get-settings' }
  | { type: 'cabot.save-settings'; settings: ProviderSettings };

export interface CoordinatorDeps {
  snapshots: SnapshotBackend;
  settings: SettingsStore;
}

export function createCoordinator(deps: CoordinatorDeps) {
  let store: DurableStore | undefined;
  let broker: CapabilityBroker | undefined;
  let warning: string | null = null;

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

  async function continueTask(taskId: string): Promise<unknown> {
    const { store: s, broker: b } = ready();
    const task = s.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    const settings = await deps.settings.load();
    if (!settings) throw new Error('provider not configured — open Settings first');
    const provider = new OpenAICompatibleProvider({ endpoint: settings.endpoint, apiKey: settings.apiKey, modelId: settings.modelId });
    const project = s.projects.get(task.projectId);
    if (!project) throw new Error('project missing for task');
    const executor = new BrowserToolExecutor(new ChromeBrowserBackend(), s, task.id, project.id);
    const svc = new CabotRuntimeService(s, b, provider, executor);
    const outcome = await svc.runTask(task.id, task.ownerAgentId, 25, () => persist().catch(() => {}));
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
      skillIds: [], budget: { maxModelCalls: 20, maxToolCalls: 30 },
      workspaceMounts: [], delegationDepth: 0,
    });
    const task = s.createTask({ projectId: project.id, ownerAgentId: agent.id, title: objective.slice(0, 80), objective });
    for (const toolId of ['browser.list_tabs', 'browser.get_active_tab', 'browser.read_page', 'browser.read_selection', 'browser.get_links']) {
      b.grant({ principal: { kind: 'core-agent', agentId: agent.id }, toolId, scope: 'task', taskId: task.id });
    }
    const executor = new BrowserToolExecutor(new ChromeBrowserBackend(), s, task.id, project.id);
    const svc = new CabotRuntimeService(s, b, provider, executor);
    await persist();
    const outcome = await svc.runTask(task.id, agent.id, 25, () => persist().catch(() => {}));
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
      case 'cabot.cancel-task':
        queries.cancelTask(msg.taskId);
        await persist();
        return { ok: true };
      case 'cabot.run-summary':
        return runSummary(msg.objective, msg.projectName);
      case 'cabot.send-message': {
        queries.sendUserMessage(msg.taskId, msg.text);
        await persist();
        emit('user-message', msg.taskId);
        return { taskId: msg.taskId, ...(await continueTask(msg.taskId) as Record<string, unknown>) };
      }
      case 'cabot.get-settings':
        return { settings: await deps.settings.load() };
      case 'cabot.save-settings':
        await deps.settings.save(msg.settings);
        return { ok: true };
      default:
        throw new Error(`unknown message ${(msg as { type: string }).type}`);
    }
  }

  return { boot, reboot, persist, runSummary, handleMessage, ready, bootWarning: () => warning };
}
