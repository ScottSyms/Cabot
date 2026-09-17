// Shared render components used by the side panel and the workspace page.
// Pure functions over fetched data; all side effects flow through callbacks.
import type { Agent, ApprovalInboxItem, ConversationMessage, TaskDetail } from '@cabot/runtime';
import { checked, el, errorText, statusGroup, type PanelClient, type TaskSummary } from './dom.js';

export interface AgentView {
  agent: Agent;
  name: string;
  task?: TaskSummary;
  pendingApprovals: number;
}

export function agentViews(agents: Agent[], tasks: TaskSummary[], approvals: ApprovalInboxItem[]): AgentView[] {
  const byAgent = new Map<string, TaskSummary[]>();
  for (const t of tasks) {
    const list = byAgent.get(t.ownerAgentId) ?? [];
    list.push(t);
    byAgent.set(t.ownerAgentId, list);
  }
  const approvalsByTask = new Map<string, number>();
  for (const a of approvals) approvalsByTask.set(a.taskId, (approvalsByTask.get(a.taskId) ?? 0) + 1);
  return agents.map((agent) => {
    const owned = byAgent.get(agent.id) ?? [];
    const task = owned[owned.length - 1];
    const name = (task?.title || agent.objective || agent.role || 'Agent').slice(0, 60) || 'Agent';
    return {
      agent,
      name,
      task,
      pendingApprovals: task ? (approvalsByTask.get(task.id) ?? 0) : 0,
    };
  });
}

export function renderAgentRail(
  container: HTMLElement,
  views: AgentView[],
  selectedId: string | null,
  onSelect: (agentId: string) => void,
  onRemove?: (agentId: string) => void,
): void {
  container.innerHTML = '';
  const isTerminal = (s: string): boolean => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(s);
  const active = views.filter((v) => !isTerminal(v.agent.status));
  const history = views.filter((v) => isTerminal(v.agent.status));
  if (views.length === 0) {
    container.append(el('p', 'No agents yet. Start a task to create one.', { class: 'muted' }));
    return;
  }
  for (const v of [...active].reverse()) container.append(railRow(v, selectedId, onSelect, undefined));
  if (history.length > 0) {
    const h = el('div', undefined, { class: 'rail-history' });
    h.append(el('div', `History (${history.length})`, { class: 'rail-history-title' }));
    for (const v of [...history].reverse()) h.append(railRow(v, selectedId, onSelect, onRemove));
    container.append(h);
  }
}

function railRow(
  v: AgentView,
  selectedId: string | null,
  onSelect: (agentId: string) => void,
  onRemove?: (agentId: string) => void,
): HTMLElement {
  const row = el('div', undefined, { class: `rail-row${v.agent.id === selectedId ? ' selected' : ''}`, role: 'button', tabindex: '0' });
  const dot = el('span', undefined, { class: `dot dot-${statusGroup(v.agent.status)}` });
  const main = el('span', undefined, { class: 'rail-main' });
  main.append(el('span', v.name, { class: 'rail-name' }));
  const sub = el('span', undefined, { class: 'rail-sub muted' });
  const b = budgetLabel(v.agent);
  sub.textContent = `${v.agent.status}${v.task ? ` · ${v.task.status}` : ''} · ${b.text}`;
  if (b.exhausted) sub.className = 'rail-sub hint-warn';
  else if (b.low) sub.className = 'rail-sub rail-sub-low';
  main.append(sub);
  row.append(dot, main);
  if (v.pendingApprovals > 0) row.append(el('span', `!${v.pendingApprovals}`, { class: 'badge badge-warn' }));
  if (onRemove) {
    const remove = el('button', '✕', { class: 'rail-remove', title: 'Remove from history' });
    remove.onclick = (e) => {
      e.stopPropagation();
      onRemove(v.agent.id);
    };
    row.append(remove);
  }
  row.onclick = () => onSelect(v.agent.id);
  row.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(v.agent.id);
    }
  };
  return row;
}

export function renderConversation(container: HTMLElement, conversation: ConversationMessage[]): void {
  container.innerHTML = '';
  const capped = conversation.slice(-200);
  if (capped.length === 0) {
    container.append(el('p', 'No messages yet. The transcript appears here as you and the agent talk.', { class: 'muted' }));
    return;
  }
  for (const m of capped) {
    if (m.role === 'user') {
      const b = el('div', undefined, { class: 'msg msg-user' });
      b.append(el('div', 'You', { class: 'msg-who' }), el('div', m.text, { class: 'msg-text' }));
      container.append(b);
    } else if (m.role === 'agent') {
      const b = el('div', undefined, { class: 'msg msg-agent' });
      b.append(el('div', 'Agent', { class: 'msg-who' }), el('div', m.text, { class: 'msg-text' }));
      container.append(b);
    } else {
      const chip = el('div', undefined, { class: `chip${m.ok === false ? ' chip-bad' : ''}` });
      chip.append(el('span', m.ok === false ? '✗' : '✓', { class: 'chip-mark' }));
      chip.append(el('span', m.toolId ?? 'tool', { class: 'mono' }));
      if (m.ok === false && m.text) chip.append(el('span', m.text, { class: 'chip-err' }));
      container.append(chip);
    }
  }
}

export function renderActivity(container: HTMLElement, detail: TaskDetail): void {
  container.innerHTML = '';
  const events = el('ul', undefined, { class: 'activity' });
  for (const e of detail.events.slice(-60)) events.append(el('li', `[${e.type}] ${e.summary}`, { class: 'mono' }));
  if (detail.events.length === 0) events.append(el('li', 'No activity yet.', { class: 'muted' }));
  container.append(events);
}

export function renderSources(container: HTMLElement, detail: TaskDetail): void {
  container.innerHTML = '';
  if (detail.sources.length === 0) {
    container.append(el('p', 'Pages the agent reads are captured here with their origin.', { class: 'muted' }));
    return;
  }
  const list = el('ul');
  for (const s of detail.sources) list.append(el('li', `${s.uri} — ${s.origin}`, { class: 'mono' }));
  container.append(list);
}

export function renderFiles(container: HTMLElement, detail: TaskDetail): void {
  container.innerHTML = '';
  if (detail.artifacts.length === 0) {
    container.append(el('p', 'Files the agent produces appear here.', { class: 'muted' }));
    return;
  }
  const list = el('ul');
  for (const a of detail.artifacts) list.append(el('li', `${a.path} (${a.bytes} bytes)`, { class: 'mono' }));
  container.append(list);
}

export function renderApprovals(
  container: HTMLElement,
  items: ApprovalInboxItem[],
  onDecide: (id: string, decision: 'granted' | 'denied') => void,
): void {
  container.innerHTML = '';
  if (items.length === 0) {
    container.append(el('p', 'Nothing waiting.', { class: 'muted' }));
    return;
  }
  for (const a of items) {
    const row = el('div', undefined, { class: 'approval' });
    row.append(el('div', a.toolId, { class: 'tool mono' }));
    row.append(el('div', `${a.taskTitle} — requested by ${a.agentRole}`, { class: 'muted' }));
    const grant = el('button', 'Grant once', { class: 'good' });
    grant.onclick = () => onDecide(a.id, 'granted');
    const deny = el('button', 'Deny', { class: 'danger' });
    deny.onclick = () => onDecide(a.id, 'denied');
    row.append(grant, deny);
    container.append(row);
  }
}

export function renderStats(container: HTMLElement, tasks: TaskSummary[], approvals: ApprovalInboxItem[]): void {
  container.innerHTML = '';
  const active = tasks.filter((t) => !['COMPLETE', 'FAILED', 'CANCELLED'].includes(t.status)).length;
  const blocked = tasks.filter((t) => ['BLOCKED', 'APPROVAL_REQUIRED', 'INTERRUPTED'].includes(t.status)).length;
  for (const [n, label] of [[tasks.length, 'tasks'], [active, 'active'], [blocked, 'blocked'], [approvals.length, 'approvals']] as [number, string][]) {
    const d = el('div', undefined, { class: 'stat' });
    d.append(el('b', String(n)), el('span', label));
    container.append(d);
  }
}

/** Settings dialog shared by panel and workspace. Key stays write-only. */export function openSettingsDialog(client: PanelClient, onStatus: (t: string) => void): void {
  const overlay = el('div', undefined, { class: 'modal-overlay' });
  const dialog = el('div', undefined, { class: 'modal' });
  dialog.append(el('h3', 'Provider settings'));
  const endpoint = el('input') as HTMLInputElement;
  endpoint.placeholder = 'https://… or http://localhost:11434/v1';
  const model = el('input') as HTMLInputElement;
  model.placeholder = 'model id';
  const key = el('input') as HTMLInputElement;
  key.placeholder = 'API key (optional)';
  key.type = 'password';
  const prompt = el('textarea') as HTMLTextAreaElement;
  prompt.placeholder = 'Behavior instructions for the agent (optional)…';
  prompt.rows = 4;
  const budgetModel = el('input') as HTMLInputElement;
  budgetModel.type = 'number';
  budgetModel.min = '1';
  budgetModel.placeholder = '60';
  const budgetTools = el('input') as HTMLInputElement;
  budgetTools.type = 'number';
  budgetTools.min = '1';
  budgetTools.placeholder = '150';
  const budgetRow = el('div', undefined, { class: 'modal-row' });
  budgetRow.append(
    labelled('Max model calls', budgetModel),
    labelled('Max tool calls', budgetTools),
  );
  const row = el('div', undefined, { class: 'modal-row' });
  const save = el('button', 'Save');
  const cancel = el('button', 'Cancel', { class: 'secondary' });
  cancel.onclick = () => overlay.remove();
  save.onclick = () => {
    const num = (v: string): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    checked(
      client.send({
        type: 'cabot.save-settings',
        settings: {
          endpoint: endpoint.value,
          modelId: model.value,
          apiKey: key.value || undefined,
          systemPrompt: prompt.value.trim() || undefined,
          budget: { maxModelCalls: num(budgetModel.value), maxToolCalls: num(budgetTools.value) },
        },
      }),
    )
      .then(() => {
        onStatus('settings saved');
        overlay.remove();
      })
      .catch((e) => onStatus(`save failed: ${errorText(e)}`));
  };
  row.append(save, cancel);
  // Inline hint catches the common mistake (website root instead of API base)
  // before the user runs a task and hits the endpoint error.
  const hint = el('p', '', { class: 'muted' });
  const updateHint = (): void => {
    const v = endpoint.value.trim();
    if (!v) {
      hint.textContent = 'Example: https://openrouter.ai/api/v1 or http://localhost:11434/v1';
      return;
    }
    try {
      const u = new URL(v);
      const bareOrigin = u.pathname === '/' || u.pathname === '';
      if (bareOrigin && !['localhost', '127.0.0.1'].includes(u.hostname)) {
        hint.textContent = `This looks like a website root. Use the API base, e.g. ${u.origin}/v1`;
        hint.className = 'hint-warn';
      } else {
        hint.textContent = 'Base URL only — Cabot appends /chat/completions.';
        hint.className = 'muted';
      }
    } catch {
      hint.textContent = 'Enter a full URL, e.g. https://openrouter.ai/api/v1';
      hint.className = 'hint-warn';
    }
  };
  endpoint.oninput = updateHint;
  dialog.append(
    el('label', 'Endpoint'), endpoint, hint,
    el('label', 'Model'),
    model,
    el('label', 'API key'),
    key,
    el('label', 'System prompt (agent behavior)'),
    prompt,
    el('label', 'Budget per task'),
    budgetRow,
    row,
    el('p', 'The key is stored locally and sent only as an Authorization header. Your system prompt is added after a fixed safety preamble that cannot be overridden.', { class: 'muted' }),
  );
  overlay.append(dialog);
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };
  checked(
    client.send<{
      settings: { endpoint: string; modelId: string; systemPrompt?: string; budget?: { maxModelCalls?: number; maxToolCalls?: number } } | null;
      hasApiKey: boolean;
    }>({ type: 'cabot.get-settings' }),
  )
    .then(({ settings, hasApiKey }) => {
      if (settings) {
        endpoint.value = settings.endpoint;
        model.value = settings.modelId;
        prompt.value = settings.systemPrompt ?? '';
        if (settings.budget?.maxModelCalls) budgetModel.value = String(settings.budget.maxModelCalls);
        if (settings.budget?.maxToolCalls) budgetTools.value = String(settings.budget.maxToolCalls);
      }
      if (hasApiKey) key.placeholder = '•••••••• (saved — leave blank to keep)';
      updateHint();
    })
    .catch(() => updateHint());
  document.body.append(overlay);
}

function labelled(text: string, input: HTMLElement): HTMLElement {
  const wrap = el('div', undefined, { class: 'field' });
  wrap.append(el('label', text), input);
  return wrap;
}

/** "model 12/60 · tools 40/150", flagged when near or at the limit. */
export function budgetLabel(agent: Agent): { text: string; low: boolean; exhausted: boolean } {
  const ml = agent.budget.maxModelCalls;
  const tl = agent.budget.maxToolCalls;
  const text = `model ${agent.spent.modelCalls}${ml ? `/${ml}` : ''} · tools ${agent.spent.toolCalls}${tl ? `/${tl}` : ''}`;
  const modelLow = ml !== undefined && agent.spent.modelCalls >= ml * 0.8;
  const toolLow = tl !== undefined && agent.spent.toolCalls >= tl * 0.8;
  const exhausted =
    (ml !== undefined && agent.spent.modelCalls >= ml) || (tl !== undefined && agent.spent.toolCalls >= tl);
  return { text, low: modelLow || toolLow, exhausted };
}
