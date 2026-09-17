// Side panel UI: thin client over runtime messages (spec §18-19).
// Renders tasks, activity, sources, approvals, and settings. Contains no
// agent logic, no tool dispatch, no model calls — everything goes through
// the supervisor → offscreen coordinator.
import type { ApprovalInboxItem, TaskDetail } from '@cabot/runtime';

export interface PanelClient {
  send<T>(msg: unknown): Promise<T>;
}

function el(tag: string, text?: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function renderSidePanel(root: HTMLElement, client: PanelClient): void {
  root.innerHTML = '';
  const wrap = el('div', undefined, { id: 'cabot' });
  wrap.append(
    section('Settings', buildSettings(client)),
    section('New page summary', buildRunner(client, () => refresh())),
    section('Tasks', buildTasks(client)),
    section('Approvals', buildApprovals(client)),
  );
  root.append(wrap);

  async function refresh(): Promise<void> {
    try {
      const [tasks, approvals] = await Promise.all([
        client.send<{ tasks: { id: string; title: string; status: string }[] }>({ type: 'cabot.list-tasks' }),
        client.send<{ approvals: ApprovalInboxItem[] }>({ type: 'cabot.pending-approvals' }),
      ]);
      renderTaskList(tasks.tasks);
      renderApprovals(approvals.approvals);
    } catch (e) {
      statusLine(`refresh failed: ${errorText(e)}`);
    }
  }

  function renderTaskList(tasks: { id: string; title: string; status: string }[]): void {
    const box = document.getElementById('cabot-tasks');
    if (!box) return;
    box.innerHTML = '';
    if (tasks.length === 0) box.append(el('p', 'No tasks yet.'));
    for (const t of tasks) {
      const row = el('div', undefined, { class: 'task' });
      row.append(el('strong', `${t.title} `), el('span', `[${t.status}]`));
      const btns = el('div');
      const detail = el('button', 'Detail');
      detail.onclick = () => showDetail(t.id).catch((e) => statusLine(errorText(e)));
      const pause = el('button', 'Pause');
      pause.onclick = () => client.send({ type: 'cabot.pause-task', taskId: t.id }).then(() => refresh()).catch((e) => statusLine(errorText(e)));
      const resume = el('button', 'Resume');
      resume.onclick = () => client.send({ type: 'cabot.resume-task', taskId: t.id }).then(() => refresh()).catch((e) => statusLine(errorText(e)));
      btns.append(detail, pause, resume);
      row.append(btns);
      box.append(row);
    }
  }

  function renderApprovals(items: ApprovalInboxItem[]): void {
    const box = document.getElementById('cabot-approvals');
    if (!box) return;
    box.innerHTML = '';
    if (items.length === 0) box.append(el('p', 'No pending approvals.'));
    for (const a of items) {
      const row = el('div', undefined, { class: 'approval' });
      row.append(el('div', `${a.toolId} — ${a.taskTitle} (${a.agentRole})`));
      const grant = el('button', 'Grant once');
      grant.onclick = () => decide(a.id, 'granted');
      const deny = el('button', 'Deny');
      deny.onclick = () => decide(a.id, 'denied');
      row.append(grant, deny);
      box.append(row);
    }
  }

  async function decide(approvalId: string, decision: 'granted' | 'denied'): Promise<void> {
    try {
      await client.send({ type: 'cabot.decide-approval', approvalId, decision });
      await refresh();
    } catch (e) {
      statusLine(`decision failed: ${errorText(e)}`);
    }
  }

  async function showDetail(taskId: string): Promise<void> {
    const { detail } = await client.send<{ detail: TaskDetail }>({ type: 'cabot.task-detail', taskId });
    let box = document.getElementById('cabot-detail');
    if (!box) {
      box = el('div', undefined, { id: 'cabot-detail' });
      wrap.append(section('Task detail', box));
    }
    box.innerHTML = '';
    box.append(el('h4', `${detail.task.title} [${detail.task.status}]`));
    box.append(el('h5', 'Recent activity'));
    const events = el('ul');
    for (const e of detail.events.slice(-20)) events.append(el('li', `[${e.type}] ${e.summary}`));
    box.append(events);
    box.append(el('h5', `Sources (${detail.sources.length})`));
    const sources = el('ul');
    for (const s of detail.sources) sources.append(el('li', `${s.uri} (${s.origin})`));
    box.append(sources);
    box.append(el('h5', `Operations (${detail.operations.length})`));
    const ops = el('ul');
    for (const o of detail.operations) ops.append(el('li', `${o.toolId} — ${o.status}`));
    box.append(ops);
  }

  void refresh();
}

function section(title: string, body: HTMLElement): HTMLElement {
  const s = el('section');
  s.append(el('h3', title), body);
  return s;
}

function statusLine(text: string): void {
  let s = document.getElementById('cabot-status');
  if (!s) {
    s = el('div', undefined, { id: 'cabot-status' });
    document.getElementById('cabot')?.prepend(s);
  }
  s.textContent = text;
}

function buildSettings(client: PanelClient): HTMLElement {
  const box = el('div');
  const endpoint = el('input', undefined, { placeholder: 'https://… or http://localhost:11434/v1', size: '40' }) as HTMLInputElement;
  const model = el('input', undefined, { placeholder: 'model id', size: '24' }) as HTMLInputElement;
  const key = el('input', undefined, { placeholder: 'API key (optional)', size: '24', type: 'password' }) as HTMLInputElement;
  const save = el('button', 'Save settings');
  save.onclick = () =>
    client
      .send({ type: 'cabot.save-settings', settings: { endpoint: endpoint.value, modelId: model.value, apiKey: key.value || undefined } })
      .then(() => statusLine('settings saved'))
      .catch((e) => statusLine(`save failed: ${errorText(e)}`));
  client
    .send<{ settings: { endpoint: string; modelId: string } | null }>({ type: 'cabot.get-settings' })
    .then(({ settings }) => {
      if (settings) {
        endpoint.value = settings.endpoint;
        model.value = settings.modelId;
      } else {
        statusLine('configure a model provider to begin');
      }
    })
    .catch((e) => statusLine(errorText(e)));
  box.append(el('label', 'Endpoint '), endpoint, el('br'), el('label', 'Model '), model, el('br'), el('label', 'Key '), key, el('br'), save);
  return box;
}

function buildRunner(client: PanelClient, after: () => void): HTMLElement {
  const box = el('div');
  const input = el('input', undefined, { placeholder: 'Summarize the active tab…', size: '40' }) as HTMLInputElement;
  const run = el('button', 'Run summary') as HTMLButtonElement;
  run.onclick = () => {
    run.disabled = true;
    statusLine('running… (approve nothing; read-only tools need no approval)');
    client
      .send<{ taskId: string; outcome: { status: string } }>({ type: 'cabot.run-summary', objective: input.value || 'Summarize the active tab' })
      .then(({ taskId, outcome }) => {
        statusLine(`done: ${taskId} → ${outcome.status}`);
        after();
      })
      .catch((e) => statusLine(`run failed: ${errorText(e)}`))
      .finally(() => {
        run.disabled = false;
      });
  };
  box.append(input, run);
  return box;
}

function buildTasks(_client: PanelClient): HTMLElement {
  return el('div', undefined, { id: 'cabot-tasks' });
}

function buildApprovals(_client: PanelClient): HTMLElement {
  return el('div', undefined, { id: 'cabot-approvals' });
}
