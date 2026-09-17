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
): void {
  container.innerHTML = '';
  const active = views.filter((v) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(v.agent.status));
  const history = views.filter((v) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(v.agent.status));
  if (views.length === 0) {
    container.append(el('p', 'No agents yet. Start a task to create one.', { class: 'muted' }));
    return;
  }
  for (const v of [...active].reverse()) container.append(railRow(v, selectedId, onSelect));
  if (history.length > 0) {
    const h = el('div', undefined, { class: 'rail-history' });
    h.append(el('div', `History (${history.length})`, { class: 'rail-history-title' }));
    for (const v of [...history].reverse()) h.append(railRow(v, selectedId, onSelect));
    container.append(h);
  }
}

function railRow(v: AgentView, selectedId: string | null, onSelect: (agentId: string) => void): HTMLElement {
  const row = el('button', undefined, { class: `rail-row${v.agent.id === selectedId ? ' selected' : ''}` });
  const dot = el('span', undefined, { class: `dot dot-${statusGroup(v.agent.status)}` });
  const main = el('span', undefined, { class: 'rail-main' });
  main.append(el('span', v.name, { class: 'rail-name' }));
  const sub = el('span', undefined, { class: 'rail-sub muted' });
  sub.textContent = `${v.agent.status}${v.task ? ` · ${v.task.status}` : ''} · model ${v.agent.spent.modelCalls} · tools ${v.agent.spent.toolCalls}`;
  main.append(sub);
  row.append(dot, main);
  if (v.pendingApprovals > 0) row.append(el('span', `!${v.pendingApprovals}`, { class: 'badge badge-warn' }));
  row.onclick = () => onSelect(v.agent.id);
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

/** Settings dialog shared by panel and workspace. Key stays write-only. */
export function openSettingsDialog(client: PanelClient, onStatus: (t: string) => void): void {
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
  const row = el('div', undefined, { class: 'modal-row' });
  const save = el('button', 'Save');
  const cancel = el('button', 'Cancel', { class: 'secondary' });
  cancel.onclick = () => overlay.remove();
  save.onclick = () => {
    checked(
      client.send({
        type: 'cabot.save-settings',
        settings: { endpoint: endpoint.value, modelId: model.value, apiKey: key.value || undefined },
      }),
    )
      .then(() => {
        onStatus('settings saved');
        overlay.remove();
      })
      .catch((e) => onStatus(`save failed: ${errorText(e)}`));
  };
  row.append(save, cancel);
  dialog.append(
    el('label', 'Endpoint'), endpoint,
    el('label', 'Model'), model,
    el('label', 'API key'), key, row,
    el('p', 'The key is stored locally and sent only as an Authorization header.', { class: 'muted' }),
  );
  overlay.append(dialog);
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };
  checked(client.send<{ settings: { endpoint: string; modelId: string } | null; hasApiKey: boolean }>({ type: 'cabot.get-settings' }))
    .then(({ settings, hasApiKey }) => {
      if (settings) {
        endpoint.value = settings.endpoint;
        model.value = settings.modelId;
      }
      if (hasApiKey) key.placeholder = '•••••••• (saved — leave blank to keep)';
    })
    .catch(() => {});
  document.body.append(overlay);
}
