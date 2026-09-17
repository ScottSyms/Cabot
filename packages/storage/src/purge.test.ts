import { describe, expect, it } from 'vitest';
import { DurableStore } from './store.js';

function seed() {
  const store = new DurableStore();
  const project = store.createProject('P');
  const agent = store.createAgent({
    projectId: project.id, role: 'r', objective: 'o', status: 'RUNNING',
    modelConfig: { providerId: 'x', modelId: 'y' }, skillIds: [],
    budget: {}, workspaceMounts: [], delegationDepth: 0,
  });
  const task = store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
  store.appendConversation(task.id, agent.id, 'user', 'hi');
  store.appendConversation(task.id, agent.id, 'agent', 'hello');
  return { store, project, agent, task };
}

function finish(store: DurableStore, taskId: string, agentId: string): void {
  store.transitionTask(taskId, 'READY', 'r');
  store.transitionTask(taskId, 'RUNNING', 'r');
  store.transitionTask(taskId, 'COMPLETE', 'done');
  store.setAgentStatus(agentId, 'COMPLETED');
}

describe('agent history removal', () => {
  it('purges a terminal agent with its task, transcript, and records', () => {
    const { store, agent, task } = seed();
    store.captureSource({ projectId: 'p', taskId: task.id, uri: 'https://e.com', origin: 'https://e.com', sha256: 'ab' });
    store.sendMessage({ from: agent.id, to: agent.id, type: 'event', payload: {}, id: 'm1' });
    finish(store, task.id, agent.id);

    const res = store.purgeAgent(agent.id);
    expect(res.removedAgents).toBe(1);
    expect(res.removedTasks).toBe(1);
    expect(store.agents.has(agent.id)).toBe(false);
    expect(store.tasks.has(task.id)).toBe(false);
    expect(store.forTaskConversation(task.id)).toHaveLength(0);
    expect([...store.sources.values()]).toHaveLength(0);
    expect(store.events.some((e) => e.taskId === task.id)).toBe(false);
    expect(store.messages.has('m1')).toBe(false);
    expect(store.queue.has(agent.id)).toBe(false);
  });

  it('refuses to remove an agent that is still active', () => {
    const { store, agent } = seed();
    expect(() => store.purgeAgent(agent.id)).toThrow(/not terminal/);
    expect(store.agents.has(agent.id)).toBe(true);
  });

  it('refuses while an owned task is still non-terminal', () => {
    const { store, agent, task } = seed();
    store.setAgentStatus(agent.id, 'COMPLETED'); // agent lies about being done
    expect(() => store.purgeAgent(agent.id)).toThrow(/not terminal/);
    expect(store.tasks.has(task.id)).toBe(true);
  });

  it('purges a terminal subtree but refuses a live descendant', () => {
    const { store, project, agent, task } = seed();
    const child = store.createAgent({
      projectId: project.id, parentAgentId: agent.id, role: 'c', objective: 'co', status: 'RUNNING',
      modelConfig: { providerId: 'x', modelId: 'y' }, skillIds: [], budget: {}, workspaceMounts: [], delegationDepth: 1,
    });
    const childTask = store.createTask({ projectId: project.id, ownerAgentId: child.id, title: 'C', objective: 'CO' });
    finish(store, task.id, agent.id); // parent's own task must be terminal too
    store.setAgentStatus(child.id, 'RUNNING');
    expect(() => store.purgeAgent(agent.id)).toThrow(/descendant .* not terminal/);

    // Finish the child; the whole subtree goes together.
    finish(store, childTask.id, child.id);
    const res = store.purgeAgent(agent.id);
    expect(res.removedAgents).toBe(2);
    expect(store.agents.has(agent.id)).toBe(false);
    expect(store.agents.has(child.id)).toBe(false);
  });

  it('leaves unrelated agents untouched', () => {
    const { store, project, agent, task } = seed();
    const other = store.createAgent({
      projectId: project.id, role: 'other', objective: 'o2', status: 'RUNNING',
      modelConfig: { providerId: 'x', modelId: 'y' }, skillIds: [], budget: {}, workspaceMounts: [], delegationDepth: 0,
    });
    const otherTask = store.createTask({ projectId: project.id, ownerAgentId: other.id, title: 'O', objective: 'OO' });
    store.appendConversation(otherTask.id, other.id, 'agent', 'kept');
    finish(store, task.id, agent.id);
    store.purgeAgent(agent.id);
    expect(store.agents.has(other.id)).toBe(true);
    expect(store.forTaskConversation(otherTask.id)).toHaveLength(1);
  });
});
