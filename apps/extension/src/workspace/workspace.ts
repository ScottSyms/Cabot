// Workspace orchestrator: agent rail + main pane. The skeleton is built
// once; refreshes update lists and content without touching the composer,
// so drafts and scroll position survive live updates.
import type { Agent, ApprovalInboxItem, TaskDetail } from '@cabot/runtime';
import { checked, el, errorText, statusClass, type PanelClient, type TaskSummary } from '../ui/dom.js';
import {
  agentViews,
  budgetLabel,
  openSettingsDialog,
  renderActivity,
  renderAgentRail,
  renderApprovals,
  renderConversation,
  renderFiles,
  renderSources,
  type AgentView,
} from '../ui/components.js';

type Tab = 'conversation' | 'activity' | 'sources' | 'files';

const TABS: { id: Tab; label: string }[] = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'activity', label: 'Activity' },
  { id: 'sources', label: 'Sources' },
  { id: 'files', label: 'Files' },
];

export function renderWorkspace(root: HTMLElement, client: PanelClient): { refresh: () => Promise<void> } {
  root.innerHTML = '';
  const wrap = el('div', undefined, { id: 'cabot' });

  const topbar = el('div', undefined, { class: 'topbar' });
  const title = el('h1');
  title.innerHTML = '<span class="dot dot-done">●</span> Cabot';
  const status = el('span', '', { id: 'cabot-status' });
  const spacer = el('span', undefined, { class: 'spacer' });
  const settingsBtn = el('button', '⚙ Settings', { class: 'secondary' });
  settingsBtn.onclick = () => openSettingsDialog(client, setStatus);
  topbar.append(title, status, spacer, settingsBtn);

  const layout = el('div', undefined, { class: 'layout' });
  const rail = el('aside', undefined, { class: 'rail' });
  const railTitle = el('h3', 'Agents');
  const railList = el('div', undefined, { id: 'ws-rail' });
  const newRow = el('div', undefined, { class: 'new-task' });
  const newInput = el('input') as HTMLInputElement;
  newInput.placeholder = 'New task objective…';
  const newBtn = el('button', '+ New task') as HTMLButtonElement;
  newRow.append(newInput, newBtn);
  rail.append(railTitle, railList, newRow);

  const pane = el('section', undefined, { class: 'pane' });
  const header = el('div', undefined, { class: 'ws-header' });
  const tabsBar = el('div', undefined, { class: 'tabs' });
  const inlineApprovals = el('div', undefined, { id: 'ws-approvals' });
  const content = el('div', undefined, { id: 'ws-content' });
  const composer = el('div', undefined, { class: 'composer' });
  const msgInput = el('textarea') as HTMLTextAreaElement;
  msgInput.placeholder = 'Message this agent… (Enter to send, Shift+Enter for newline)';
  const sendBtn = el('button', 'Send') as HTMLButtonElement;
  composer.append(msgInput, sendBtn);
  pane.append(header, tabsBar, inlineApprovals, content, composer);

  layout.append(rail, pane);
  wrap.append(topbar, layout);
  root.append(wrap);

  const state = {
    agents: [] as Agent[],
    tasks: [] as TaskSummary[],
    approvals: [] as ApprovalInboxItem[],
    views: [] as AgentView[],
    selectedAgentId: hashSelected(),
    tab: 'conversation' as Tab,
    drafts: new Map<string, string>(),
    detail: null as TaskDetail | null,
    busy: false,
  };

  function setStatus(t: string): void {
    status.textContent = t;
  }

  function selectedView(): AgentView | undefined {
    return state.views.find((v) => v.agent.id === state.selectedAgentId);
  }

  function stickToBottom(): boolean {
    return content.scrollHeight - content.scrollTop - content.clientHeight < 80;
  }

  async function refresh(): Promise<void> {
    try {
      const [tasks, approvals, agents] = await Promise.all([
        checked(client.send<{ tasks: TaskSummary[] }>({ type: 'cabot.list-tasks' })),
        checked(client.send<{ approvals: ApprovalInboxItem[] }>({ type: 'cabot.pending-approvals' })),
        checked(client.send<{ agents: Agent[] }>({ type: 'cabot.list-agents' })),
      ]);
      state.tasks = tasks.tasks;
      state.approvals = approvals.approvals;
      state.agents = agents.agents;
      state.views = agentViews(state.agents, state.tasks, state.approvals);
      if (!state.views.some((v) => v.agent.id === state.selectedAgentId)) {
        const firstActive = state.views.find((v) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(v.agent.status));
        state.selectedAgentId = (firstActive ?? state.views[state.views.length - 1])?.agent.id ?? null;
        syncHash();
      }
      renderAgentRail(railList, state.views, state.selectedAgentId, select, removeAgent);
      await renderMain();
    } catch (e) {
      setStatus(`refresh failed: ${errorText(e)}`);
    }
  }

  async function renderMain(): Promise<void> {
    const view = selectedView();
    header.innerHTML = '';
    tabsBar.innerHTML = '';
    inlineApprovals.innerHTML = '';
    if (!view) {
      header.append(el('h2', 'No agent selected'));
      content.innerHTML = '';
      content.append(el('p', 'Start a task from the rail to create your first agent.', { class: 'muted' }));
      composer.style.display = 'none';
      return;
    }
    composer.style.display = '';
    const title = el('h2', view.name);
    const badge = el('span', view.agent.status, { class: statusClass(view.agent.status) });
    const budget = budgetLabel(view.agent);
    const budgetEl = el('span', budget.text, { class: `mono budget${budget.low ? ' hint-warn' : ' muted'}` });
    header.append(title, badge, budgetEl);
    const spacerH = el('span', undefined, { class: 'spacer' });
    header.append(spacerH);
    if (view.task) {
      // Budget exhaustion is recoverable: raise the limit and keep going.
      if (budget.exhausted) {
        const extend = el('button', 'Continue with more budget', { class: 'good' });
        extend.onclick = () => extendAndContinue(view.agent.id, view.task!.id);
        header.append(extend);
      }
      const pause = el('button', 'Pause', { class: 'secondary' });
      pause.onclick = () => act({ type: 'cabot.pause-task', taskId: view.task!.id });
      const resume = el('button', 'Resume', { class: 'secondary' });
      resume.onclick = () => act({ type: 'cabot.resume-task', taskId: view.task!.id });
      const cancel = el('button', 'Cancel', { class: 'danger' });
      cancel.onclick = () => act({ type: 'cabot.cancel-task', taskId: view.task!.id });
      header.append(pause, resume, cancel);
    }
    for (const t of TABS) {
      const b = el('button', t.label, { class: state.tab === t.id ? 'active' : '' });
      b.onclick = () => {
        state.tab = t.id;
        void renderMain();
      };
      tabsBar.append(b);
    }
    if (view.task) {
      const mine = state.approvals.filter((a) => a.taskId === view.task!.id);
      if (mine.length > 0) {
        const card = el('div');
        card.append(el('h3', 'Needs your approval'));
        const list = el('div');
        renderApprovals(list, mine, (id, d) => act({ type: 'cabot.decide-approval', approvalId: id, decision: d }));
        card.append(list);
        inlineApprovals.append(card);
      }
    }
    await renderContent(view);
  }

  async function renderContent(view: AgentView): Promise<void> {
    const stick = stickToBottom();
    content.innerHTML = '';
    if (!view.task) {
      content.append(el('p', 'This agent has no task yet.', { class: 'muted' }));
      state.detail = null;
      return;
    }
    try {
      const { detail } = await checked(
        client.send<{ detail: TaskDetail }>({ type: 'cabot.task-detail', taskId: view.task.id }),
      );
      state.detail = detail;
    } catch (e) {
      content.append(el('p', `could not load detail: ${errorText(e)}`, { class: 'muted' }));
      return;
    }
    const d = state.detail;
    if (state.tab === 'conversation') renderConversation(content, d.conversation);
    else if (state.tab === 'activity') renderActivity(content, d);
    else if (state.tab === 'sources') renderSources(content, d);
    else renderFiles(content, d);
    if (stick) content.scrollTop = content.scrollHeight;
  }

  function select(agentId: string): void {
    // Stash the outgoing draft before switching.
    if (state.selectedAgentId) state.drafts.set(state.selectedAgentId, msgInput.value);
    state.selectedAgentId = agentId;
    syncHash();
    msgInput.value = state.drafts.get(agentId) ?? '';
    renderAgentRail(railList, state.views, state.selectedAgentId, select, removeAgent);
    void renderMain();
  }

  /**
   * Raise the agent's limits, resume the suspended task, and drive it on.
   * Extension is explicit and per-task: runaway protection stays intact.
   */
  function extendAndContinue(agentId: string, taskId: string): void {
    const view = state.views.find((v) => v.agent.id === agentId);
    if (!view) return;
    const nextModel = (view.agent.budget.maxModelCalls ?? view.agent.spent.modelCalls) + 60;
    const nextTools = (view.agent.budget.maxToolCalls ?? view.agent.spent.toolCalls) + 150;
    setStatus(`extending budget to ${nextModel} model / ${nextTools} tool calls…`);
    checked(client.send({ type: 'cabot.extend-budget', agentId, maxModelCalls: nextModel, maxToolCalls: nextTools }))
      .then(() => checked(client.send({ type: 'cabot.resume-task', taskId })))
      .then(() => checked(client.send<{ outcome?: { status: string }; queued?: boolean }>({ type: 'cabot.send-message', taskId, text: 'Continue and finish the task.' })))
      .then((res) => {
        setStatus(res.queued ? 'queued — the running turn will pick it up' : `agent replied: ${res.outcome?.status ?? 'done'}`);
        return refresh();
      })
      .catch((e) => setStatus(`extend failed: ${errorText(e)}`));
  }

  function removeAgent(agentId: string): void {    const view = state.views.find((v) => v.agent.id === agentId);
    const label = view?.name ?? agentId;
    if (!window.confirm(`Remove "${label}" and its transcript from history? This cannot be undone.`)) return;
    setStatus('removing…');
    checked(client.send<{ removed: { removedAgents: number; removedTasks: number } }>({ type: 'cabot.remove-agent', agentId }))
      .then((res) => {
        if (state.selectedAgentId === agentId) {
          state.selectedAgentId = null;
          state.drafts.delete(agentId);
        }
        setStatus(`removed ${res.removed.removedAgents} agent, ${res.removed.removedTasks} task`);
        return refresh();
      })
      .catch((e) => setStatus(`remove failed: ${errorText(e)}`));
  }

  async function act(msg: unknown): Promise<void> {
    try {
      await checked(client.send(msg));
      await refresh();
    } catch (e) {
      setStatus(errorText(e));
    }
  }

  function doSend(): void {
    const view = selectedView();
    if (!view?.task || state.busy) return;
    const text = msgInput.value;
    if (!text.trim()) return;
    state.busy = true;
    sendBtn.disabled = true;
    setStatus('sending…');
    checked(client.send<{ outcome?: { status: string }; queued?: boolean }>({ type: 'cabot.send-message', taskId: view.task.id, text }))
      .then((res) => {
        setStatus(res.queued ? 'queued — the running turn will pick it up' : `agent replied: ${res.outcome?.status ?? 'done'}`);
        msgInput.value = '';
        state.drafts.delete(view.agent.id);
        return refresh();
      })
      .catch((e) => setStatus(`send failed: ${errorText(e)}`))
      .finally(() => {
        state.busy = false;
        sendBtn.disabled = false;
      });
  }

  function doNewTask(): void {
    const objective = newInput.value.trim();
    if (!objective || state.busy) return;
    state.busy = true;
    newBtn.disabled = true;
    setStatus('starting task…');
    checked(client.send<{ taskId: string }>({ type: 'cabot.run-summary', objective }))
      .then(() => {
        newInput.value = '';
        return refresh();
      })
      .then(() => {
        // Select the newest agent.
        const newest = state.views[state.views.length - 1];
        if (newest) select(newest.agent.id);
      })
      .catch((e) => setStatus(`run failed: ${errorText(e)}`))
      .finally(() => {
        state.busy = false;
        newBtn.disabled = false;
      });
  }

  function hashSelected(): string | null {
    const m = location.hash.match(/agent=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function syncHash(): void {
    const base = location.hash.replace(/agent=[^&]*&?/, '').replace(/[?#&]$/, '');
    location.hash = state.selectedAgentId ? `${base}${base ? '&' : ''}agent=${encodeURIComponent(state.selectedAgentId)}` : base;
  }

  msgInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };
  sendBtn.onclick = doSend;
  newBtn.onclick = doNewTask;
  newInput.onkeydown = (e) => {
    if (e.key === 'Enter') doNewTask();
  };
  msgInput.value = state.selectedAgentId ? (state.drafts.get(state.selectedAgentId) ?? '') : '';

  void refresh();
  return { refresh };
}
