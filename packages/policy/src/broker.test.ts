import { describe, expect, it } from 'vitest';
import { DurableStore } from '@cabot/storage';
import { CapabilityBroker } from './broker.js';

function setup() {
  const store = new DurableStore();
  const broker = new CapabilityBroker(store);
  broker.registerTool({
    id: 'browser.read_page', source: 'builtin', name: 'read_page', description: 'read',
    inputSchema: { type: 'object' }, capabilityClass: 'read-only', provenance: 'builtin',
  });
  broker.registerTool({
    id: 'browser.submit', source: 'builtin', name: 'submit', description: 'submit form',
    inputSchema: { type: 'object' }, capabilityClass: 'consequential', provenance: 'builtin',
  });
  const project = store.createProject('P');
  const agentA = store.createAgent({
    projectId: project.id, role: 'a', objective: 'o', status: 'RUNNING',
    modelConfig: { providerId: 'fake', modelId: 'f' }, skillIds: [], budget: { maxDelegations: 1 }, workspaceMounts: [], delegationDepth: 0,
  });
  const agentB = store.createAgent({
    projectId: project.id, role: 'b', objective: 'o', status: 'RUNNING',
    modelConfig: { providerId: 'fake', modelId: 'f' }, skillIds: [], budget: {}, workspaceMounts: [], delegationDepth: 1, parentAgentId: agentA.id,
  });
  const task = store.createTask({ projectId: project.id, ownerAgentId: agentA.id, title: 'T', objective: 'O' });
  return { store, broker, project, agentA, agentB, task };
}

describe('capability broker', () => {
  it('rejects principal spoofing (channel binding mismatch)', () => {
    const { broker, task, agentA, agentB } = setup();
    broker.grant({ principal: { kind: 'core-agent', agentId: agentA.id }, toolId: 'browser.read_page', scope: 'task', taskId: task.id });
    const d = broker.evaluate({
      toolId: 'browser.read_page', args: {}, argsHash: 'h',
      principal: { kind: 'core-agent', agentId: agentB.id }, // channel says B...
      taskId: task.id, agentId: agentA.id, // ...but payload claims A
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/principal mismatch/);
  });

  it('child cannot use parent grant; delegation never increases authority', () => {
    const { broker, task, agentA, agentB } = setup();
    broker.grant({ principal: { kind: 'core-agent', agentId: agentA.id }, toolId: 'browser.read_page', scope: 'task', taskId: task.id });
    const d = broker.evaluate({
      toolId: 'browser.read_page', args: {}, argsHash: 'h',
      principal: { kind: 'delegated-agent', agentId: agentB.id },
      taskId: task.id, agentId: agentB.id,
    });
    expect(d.allowed).toBe(false);
  });

  it('consequential action requires approval bound to concrete args; changed args invalid', () => {
    const { broker, task, agentA } = setup();
    const req = {
      toolId: 'browser.submit', args: { to: 'x' }, argsHash: 'h1',
      principal: { kind: 'core-agent' as const, agentId: agentA.id },
      taskId: task.id, agentId: agentA.id, destination: 'https://example.com',
    };
    const d = broker.evaluate(req);
    expect(d.approvalRequired).toBe(true);
    broker.decideApproval(d.approvalId!, 'granted');
    expect(broker.authorizeDispatch(req, d.approvalId!).allowed).toBe(true);
    // attacker/model mutates args after approval
    expect(broker.authorizeDispatch({ ...req, argsHash: 'h2' }, d.approvalId!).allowed).toBe(false);
  });

  it('revoked grants deny at dispatch recheck', () => {
    const { broker, store, task, agentA } = setup();
    const g = broker.grant({ principal: { kind: 'core-agent', agentId: agentA.id }, toolId: 'browser.read_page', scope: 'task', taskId: task.id });
    const req = {
      toolId: 'browser.read_page', args: {}, argsHash: 'h',
      principal: { kind: 'core-agent' as const, agentId: agentA.id },
      taskId: task.id, agentId: agentA.id,
    };
    expect(broker.evaluate(req).allowed).toBe(true);
    broker.revoke(g.id);
    expect(broker.authorizeDispatch(req).allowed).toBe(false);
    void store;
  });
});
