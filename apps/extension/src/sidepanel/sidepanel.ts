// Compact launcher panel: status summary, quick task creation, approval
// inbox, and agent overview. Deep work happens in the workspace tab.
// Shares components with the workspace; contains no agent logic itself.
import './sidepanel.css';
import type { Agent, ApprovalInboxItem } from '@cabot/runtime';
import { checked, el, errorText, statusGroup, type PanelClient, type TaskSummary } from '../ui/dom.js';
import { agentViews, openSettingsDialog, renderApprovals, renderStats } from '../ui/components.js';

export function renderSidePanel(root: HTMLElement, client: PanelClient): { refresh: () => Promise<void> } {
  root.innerHTML = '';
  const wrap = el('div', undefined, { id: 'cabot' });
  const header = el('h1');
  header.innerHTML = '<span class="dot dot-done">●</span> Cabot';
  const status = el('div', undefined, { id: 'cabot-status' });
  const stats = el('div', undefined, { id: 'cabot-stats', class: 'stats' });

  const openBtn = el('button', 'Open workspace');
  openBtn.onclick = () => {
    try {
      void chrome.tabs.create({ url: chrome.runtime.getURL('dist/workspace.html') });
    } catch (e) {
      setStatus(`cannot open workspace: ${errorText(e)}`);
    }
  };
  const gear = el('button', '⚙', { class: 'secondary' });
  gear.onclick = () => openSettingsDialog(client, setStatus);
  const topRow = el('div');
  topRow.append(openBtn, gear);

  const runnerBody = el('div');
  const runInput = el('input') as HTMLInputElement;
  runInput.placeholder = 'New task objective…';
  const runBtn = el('button', 'Run') as HTMLButtonElement;
  runBtn.onclick = () => {
    const objective = runInput.value.trim() || 'Summarize the active tab';
    runBtn.disabled = true;
    setStatus('starting…');
    checked(client.send<{ taskId: string }>({ type: 'cabot.run-summary', objective }))
      .then(() => {
        runInput.value = '';
        setStatus('task started — open the workspace to follow it');
        return refresh();
      })
      .catch((e) => setStatus(`run failed: ${errorText(e)}`))
      .finally(() => {
        runBtn.disabled = false;
      });
  };
  runnerBody.append(runInput, runBtn);

  const approvalsBody = el('div', undefined, { id: 'cabot-approvals' });
  const agentsBody = el('div', undefined, { id: 'cabot-agents' });

  const sec = (title: string, body: HTMLElement, cls = ''): HTMLElement => {
    const s = el('section');
    if (cls) s.setAttribute('class', cls);
    s.append(el('h3', title), body);
    return s;
  };
  wrap.append(
    header,
    status,
    topRow,
    sec('Overview', stats),
    sec('New task', runnerBody),
    sec('Approvals', approvalsBody, 'approvals'),
    sec('Agents', agentsBody),
  );
  root.append(wrap);

  function setStatus(t: string): void {
    status.textContent = t;
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
      renderStats(stats, tasks.tasks, approvals.approvals);
      renderApprovals(approvalsBody, approvals.approvals, (id, decision) =>
        checked(client.send({ type: 'cabot.decide-approval', approvalId: id, decision }))
          .then(() => refresh())
          .catch((e) => setStatus(errorText(e))),
      );
      agentsBody.innerHTML = '';
      const views = agentViews(agents.agents, tasks.tasks, approvals.approvals);
      if (views.length === 0) agentsBody.append(el('p', 'No agents yet.', { class: 'muted' }));
      for (const v of views.slice().reverse().slice(0, 5)) {
        const row = el('div', undefined, { class: 'task' });
        const dot = el('span', undefined, { class: `dot dot-${statusGroup(v.agent.status)}` });
        row.append(dot, el('strong', `${v.name} `), el('span', v.agent.status, { class: `status status-${v.agent.status}` }));
        if (v.pendingApprovals > 0) row.append(el('span', ` !${v.pendingApprovals}`, { class: 'status-WAITING_FOR_USER' }));
        row.onclick = () => {
          try {
            void chrome.tabs.create({ url: chrome.runtime.getURL(`dist/workspace.html#agent=${encodeURIComponent(v.agent.id)}`) });
          } catch (e) {
            setStatus(`cannot open workspace: ${errorText(e)}`);
          }
        };
        row.setAttribute('style', 'cursor:pointer');
        agentsBody.append(row);
      }
    } catch (e) {
      setStatus(`refresh failed: ${errorText(e)}`);
    }
  }

  void refresh();
  return { refresh };
}
