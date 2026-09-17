// Side panel UI: thin client over runtime messages (spec §18-19).
// Renders dashboard stats, tasks with detail, sources, the approval inbox,
// and provider settings. Contains no agent logic, no tool dispatch, no
// model calls — everything goes through the supervisor → coordinator.
import './sidepanel.css';
import type { Agent, ApprovalInboxItem, TaskDetail } from '@cabot/runtime';

export interface PanelClient {
  send<T>(msg: unknown): Promise<T>;
}

interface TaskSummary {
  id: string;
  title: string;
  status: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, text?: string, attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Reject empty or error responses so UI code never destructures null. */
async function checked<T>(p: Promise<T>): Promise<Exclude<T, null | undefined>> {
  const res = await p;
  if (!res || typeof res !== 'object' || 'error' in (res as Record<string, unknown>)) {
    throw new Error((res as { error?: string } | null)?.error ?? 'runtime returned an empty response');
  }
  return res as Exclude<T, null | undefined>;
}

export function renderSidePanel(root: HTMLElement, client: PanelClient): { refresh: () => Promise<void> } {
  root.innerHTML = '';
  const wrap = el('div', undefined, { id: 'cabot' });
  const header = el('h1');
  header.innerHTML = '<span class="dot">●</span> Cabot';
  const status = el('div', undefined, { id: 'cabot-status' });
  const stats = el('div', undefined, { id: 'cabot-stats', class: 'stats' });

  const settingsBody = buildSettings(client);
  const runnerBody = buildRunner(client, () => refresh());
  const tasksBody = el('div', undefined, { id: 'cabot-tasks' });
  const agentsBody = el('div', undefined, { id: 'cabot-agents' });
  const approvalsBody = el('div', undefined, { id: 'cabot-approvals' });
  const detailBody = el('div', undefined, { id: 'cabot-detail' });

  wrap.append(
    header,
    status,
    section('Overview', stats, false),
    section('New page summary', runnerBody, true),
    section('Approvals', approvalsBody, true, 'approvals'),
    section('Tasks', tasksBody, true),
    section('Agents', agentsBody, true),
    section('Task detail', detailBody, false),
    section('Provider settings', settingsBody, false),
  );
  root.append(wrap);

  function setStatus(text: string): void {
    status.textContent = text;
  }

  async function refresh(): Promise<void> {
    try {
      const [tasks, approvals, agents, boot] = await Promise.all([
        checked(client.send<{ tasks: TaskSummary[] }>({ type: 'cabot.list-tasks' })),
        checked(client.send<{ approvals: ApprovalInboxItem[] }>({ type: 'cabot.pending-approvals' })),
        checked(client.send<{ agents: Agent[] }>({ type: 'cabot.list-agents' })),
        checked(client.send<{ warning: string | null }>({ type: 'cabot.boot-warning' })),
      ]);
      if (boot.warning) setStatus(`notice: ${boot.warning}`);
      renderStats(tasks.tasks, approvals.approvals);
      renderTaskList(tasks.tasks);
      renderApprovals(approvals.approvals);
      renderAgents(agents.agents);
    } catch (e) {
      setStatus(`refresh failed: ${errorText(e)}`);
    }
  }

  function renderStats(tasks: TaskSummary[], approvals: ApprovalInboxItem[]): void {
    stats.innerHTML = '';
    const active = tasks.filter((t) => !['COMPLETE', 'FAILED', 'CANCELLED'].includes(t.status)).length;
    const blocked = tasks.filter((t) => ['BLOCKED', 'APPROVAL_REQUIRED', 'INTERRUPTED'].includes(t.status)).length;
    for (const [n, label] of [[tasks.length, 'tasks'], [active, 'active'], [blocked, 'blocked'], [approvals.length, 'approvals']] as [number, string][]) {
      const d = el('div', undefined, { class: 'stat' });
      d.append(el('b', String(n)), el('span', label));
      stats.append(d);
    }
  }

  function renderTaskList(tasks: TaskSummary[]): void {
    tasksBody.innerHTML = '';
    if (tasks.length === 0) tasksBody.append(el('p', 'No tasks yet. Run a page summary above.', { class: 'muted' }));
    for (const t of tasks.slice().reverse()) {
      const row = el('div', undefined, { class: 'task' });
      const title = el('div');
      title.append(el('strong', t.title || '(untitled) '));
      title.append(el('span', t.status, { class: `status status-${t.status}` }));
      const btns = el('div');
      const detail = el('button', 'Inspect', { class: 'secondary' });
      detail.onclick = () => showDetail(t.id).catch((e) => setStatus(errorText(e)));
      const pause = el('button', 'Pause', { class: 'secondary' });
      pause.onclick = () => act({ type: 'cabot.pause-task', taskId: t.id });
      const resume = el('button', 'Resume', { class: 'secondary' });
      resume.onclick = () => act({ type: 'cabot.resume-task', taskId: t.id });
      const cancel = el('button', 'Cancel', { class: 'danger' });
      cancel.onclick = () => act({ type: 'cabot.cancel-task', taskId: t.id });
      btns.append(detail, pause, resume, cancel);
      row.append(title, btns);
      tasksBody.append(row);
    }
  }

  function renderAgents(agents: Agent[]): void {
    agentsBody.innerHTML = '';
    if (agents.length === 0) agentsBody.append(el('p', 'No agents yet. Each summary run creates one.', { class: 'muted' }));
    for (const a of agents.slice().reverse()) {
      const row = el('div', undefined, { class: 'task' });
      const title = el('div');
      title.append(el('strong', `${a.role} `));
      title.append(el('span', a.status, { class: `status status-${a.status}` }));
      const meta = el('div', undefined, { class: 'muted mono' });
      const spent = `model ${a.spent.modelCalls} · tools ${a.spent.toolCalls}`;
      const parent = a.parentAgentId ? ` · child of ${a.parentAgentId.slice(0, 12)}…` : '';
      const skills = a.skillIds.length > 0 ? ` · skills: ${a.skillIds.join(', ')}` : '';
      meta.textContent = `${a.id.slice(0, 14)}… · ${spent}${parent}${skills}`;
      row.append(title, meta);
      agentsBody.append(row);
    }
  }

  function renderApprovals(items: ApprovalInboxItem[]): void {    approvalsBody.innerHTML = '';
    if (items.length === 0) approvalsBody.append(el('p', 'Nothing waiting.', { class: 'muted' }));
    for (const a of items) {
      const row = el('div', undefined, { class: 'approval' });
      row.append(el('div', a.toolId, { class: 'tool' }));
      row.append(el('div', `${a.taskTitle} — requested by ${a.agentRole}`, { class: 'muted' }));
      const grant = el('button', 'Grant once', { class: 'good' });
      grant.onclick = () => decide(a.id, 'granted');
      const deny = el('button', 'Deny', { class: 'danger' });
      deny.onclick = () => decide(a.id, 'denied');
      row.append(grant, deny);
      approvalsBody.append(row);
    }
  }

  async function act(msg: unknown): Promise<void> {
    try {
      await client.send(msg);
      await refresh();
    } catch (e) {
      setStatus(errorText(e));
    }
  }

  async function decide(approvalId: string, decision: 'granted' | 'denied'): Promise<void> {
    await act({ type: 'cabot.decide-approval', approvalId, decision });
  }

  async function showDetail(taskId: string): Promise<void> {
    const { detail } = await checked(client.send<{ detail: TaskDetail }>({ type: 'cabot.task-detail', taskId }));
    detailBody.innerHTML = '';
    detailBody.append(el('h4', `${detail.task.title || '(untitled)'} `));
    detailBody.append(el('div', `Status: ${detail.task.status} · checkpoint r${detail.task.checkpointRevision}`, { class: 'muted' }));
    detailBody.append(el('h5', 'Activity'));
    const events = el('ul');
    for (const e of detail.events.slice(-25)) events.append(el('li', `[${e.type}] ${e.summary}`));
    if (detail.events.length === 0) events.append(el('li', 'No activity yet.', { class: 'muted' }));
    detailBody.append(events);
    detailBody.append(el('h5', `Sources (${detail.sources.length})`));
    const sources = el('ul');
    for (const s of detail.sources) sources.append(el('li', `${s.uri} — ${s.origin}`, { class: 'mono' }));
    if (detail.sources.length === 0) sources.append(el('li', 'None captured.', { class: 'muted' }));
    detailBody.append(sources);
    detailBody.append(el('h5', `Tool calls (${detail.operations.length})`));
    const ops = el('ul');
    for (const o of detail.operations) {
      ops.append(el('li', `${o.toolId} — ${o.status}${o.error ? `: ${o.error}` : ''}`, { class: 'mono' }));
    }
    if (detail.operations.length === 0) ops.append(el('li', 'None yet.', { class: 'muted' }));
    detailBody.append(ops);
    detailBody.append(el('h5', `Artifacts (${detail.artifacts.length})`));
    const arts = el('ul');
    for (const a of detail.artifacts) arts.append(el('li', `${a.path} (${a.bytes} bytes)`, { class: 'mono' }));
    if (detail.artifacts.length === 0) arts.append(el('li', 'None yet.', { class: 'muted' }));
    detailBody.append(arts);
    detailBody.append(el('h5', 'Message this agent'));
    const msgRow = el('div');
    const msgInput = el('input') as HTMLInputElement;
    msgInput.placeholder = 'Steer the agent… (Enter to send)';
    const send = el('button', 'Send') as HTMLButtonElement;
    const doSend = () => {
      const text = msgInput.value;
      if (!text.trim()) return;
      send.disabled = true;
      setStatus('sending…');
      checked(client.send<{ outcome: { status: string } }>({ type: 'cabot.send-message', taskId, text }))
        .then(({ outcome }) => {
          setStatus(`agent replied: ${outcome.status}`);
          msgInput.value = '';
          void refresh();
          void showDetail(taskId);
        })
        .catch((e) => setStatus(`send failed: ${errorText(e)}`))
        .finally(() => {
          send.disabled = false;
        });
    };
    send.onclick = doSend;
    msgInput.onkeydown = (e) => {
      if (e.key === 'Enter') doSend();
    };
    msgRow.append(msgInput, send);
    detailBody.append(msgRow);
  }

  void refresh();
  return { refresh };
}

function section(title: string, body: HTMLElement, open: boolean, cls = ''): HTMLElement {
  const s = el('section');
  if (cls) s.setAttribute('class', cls);
  s.append(el('h3', title), body);
  void open;
  return s;
}

function buildSettings(client: PanelClient): HTMLElement {
  const box = el('div');
  const endpoint = el('input') as HTMLInputElement;
  endpoint.placeholder = 'https://… or http://localhost:11434/v1';
  const model = el('input') as HTMLInputElement;
  model.placeholder = 'model id';
  const key = el('input') as HTMLInputElement;
  key.placeholder = 'API key (optional)';
  key.type = 'password';
  const save = el('button', 'Save settings');
  const note = el('p', 'Read-only research needs no approvals. Consequential actions always ask first.', { class: 'muted' });
  save.onclick = () =>
    client
      .send({
        type: 'cabot.save-settings',
        settings: { endpoint: endpoint.value, modelId: model.value, apiKey: key.value || undefined },
      })
      .then(() => {
        const st = document.getElementById('cabot-status');
        if (st) st.textContent = 'settings saved';
      })
      .catch((e) => {
        const st = document.getElementById('cabot-status');
        if (st) st.textContent = `save failed: ${errorText(e)}`;
      });
  client
    .send<{ settings: { endpoint: string; modelId: string } | null }>({ type: 'cabot.get-settings' })
    .then(({ settings }) => {
      if (settings) {
        endpoint.value = settings.endpoint;
        model.value = settings.modelId;
      } else {
        const st = document.getElementById('cabot-status');
        if (st) st.textContent = 'configure a model provider to begin';
      }
    })
    .catch(() => {});
  box.append(el('label', 'Endpoint'), endpoint, el('label', 'Model'), model, el('label', 'API key'), key, save, note);
  return box;
}

function buildRunner(client: PanelClient, after: () => void): HTMLElement {
  const box = el('div');
  const input = el('input') as HTMLInputElement;
  input.placeholder = 'Summarize the active tab…';
  const run = el('button', 'Run summary') as HTMLButtonElement;
  run.onclick = () => {
    run.disabled = true;
    const st = document.getElementById('cabot-status');
    if (st) st.textContent = 'running…';
    checked(
      client.send<{ taskId: string; outcome: { status: string } }>({
        type: 'cabot.run-summary',
        objective: input.value || 'Summarize the active tab',
      }),
    )
      .then(({ taskId, outcome }) => {
        if (st) st.textContent = `done: ${taskId} → ${outcome.status}`;
        after();
      })
      .catch((e) => {
        if (st) st.textContent = `run failed: ${errorText(e)}`;
      })
      .finally(() => {
        run.disabled = false;
      });
  };
  box.append(input, run);
  return box;
}
