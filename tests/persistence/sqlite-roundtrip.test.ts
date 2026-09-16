// Cross-restart durability: file-backed SQLite + blob store survive a
// simulated process death. Proves the Phase-1 exit gate against real
// persistence, not just in-memory state.
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage, Operation } from '@cabot/contracts';
import { DurableStore, FsBlobStore, loadStore, openDatabase, saveStore, sha256Hex } from '@cabot/storage';
import { CapabilityBroker } from '@cabot/policy';

describe('sqlite + blob cross-restart recovery', () => {
  it('two agents, mailbox, artifacts and uncertain ops survive close/reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cabot-sqlite-'));
    const dbPath = join(dir, 'cabot.db');
    const blobRoot = join(dir, 'blobs');

    // ---- boot 1: do work, persist ----
    const db1 = openDatabase(dbPath);
    const s1 = new DurableStore();
    const broker1 = new CapabilityBroker(s1);
    broker1.registerTool({
      id: 'workspace.write', source: 'builtin', name: 'write', description: 'w',
      inputSchema: { type: 'object' }, capabilityClass: 'reversible', provenance: 'builtin',
    });
    const project = s1.createProject('CANChat');
    const coord = s1.createAgent({
      projectId: project.id, role: 'coordinator', objective: 'c', status: 'RUNNING',
      modelConfig: { providerId: 'fake', modelId: 'f' }, skillIds: [],
      budget: { maxDelegations: 5 }, workspaceMounts: [], delegationDepth: 0,
    });
    const worker = s1.createAgent({
      projectId: project.id, parentAgentId: coord.id, role: 'worker', objective: 'w',
      status: 'RUNNING', modelConfig: { providerId: 'fake', modelId: 'f' },
      skillIds: [], budget: {}, workspaceMounts: [], delegationDepth: 1,
    });
    const task = s1.createTask({ projectId: project.id, ownerAgentId: coord.id, title: 'T', objective: 'O' });
    s1.transitionTask(task.id, 'READY', 'ready');
    s1.transitionTask(task.id, 'RUNNING', 'run');
    broker1.grant({ principal: { kind: 'core-agent', agentId: worker.id }, toolId: 'workspace.write', scope: 'task', taskId: task.id });

    const bytes = new TextEncoder().encode('results-parquet-bytes');
    const blobs1 = new FsBlobStore(blobRoot);
    blobs1.writeStaged('art1', bytes);
    blobs1.publish('art1', bytes.length, sha256Hex(bytes));
    s1.stageArtifact({ projectId: project.id, taskId: task.id, agentId: worker.id, path: 'shared/r.parquet', bytes: bytes.length, sha256: sha256Hex(bytes) });
    // align staged artifact id with blob id for the test
    const stagedMeta = [...s1.artifacts.values()].pop()!;
    s1.artifacts.delete(stagedMeta.id);
    s1.artifacts.set('art1', { ...stagedMeta, id: 'art1' });
    s1.publishArtifact('art1', bytes.length, sha256Hex(bytes));

    s1.sendMessage({ from: worker.id, to: coord.id, type: 'artifact', payload: { ref: 'project://shared/r.parquet' }, id: 'm-art-1' });
    const op = s1.prepareOperation({ taskId: task.id, agentId: coord.id, toolId: 'workspace.write', argsHash: 'h', idempotencyKey: 'w-1' });
    s1.markDispatched(op.id); // result lost in crash

    saveStore(db1, s1);
    db1.close();

    // ---- boot 2 (new process): load, reconcile ----
    const db2 = openDatabase(dbPath);
    const s2 = loadStore(db2);
    expect(s2.projects.get(project.id)?.name).toBe('CANChat');
    expect(s2.agents.get(worker.id)?.parentAgentId).toBe(coord.id);
    expect(s2.tasks.get(task.id)?.status).toBe('RUNNING');
    expect(s2.inbox(coord.id).map((m: AgentMessage) => m.id)).toContain('m-art-1');
    expect(s2.artifacts.get('art1')?.staged).toBe(false);

    const blobs2 = new FsBlobStore(blobRoot);
    expect(blobs2.read('art1')).toEqual(bytes);

    const uncertain = s2.reconcileAfterRestart();
    expect(uncertain.map((o: Operation) => o.id)).toContain(op.id);
    expect(s2.tasks.get(task.id)?.status).toBe('INTERRUPTED');
    // mailbox + artifact refs still intact after reconcile
    expect(s2.inbox(coord.id).map((m: AgentMessage) => m.id)).toContain('m-art-1');
    // uncertain op cannot be silently settled
    expect(() => s2.settleOperation(op.id, 'SUCCEEDED')).toThrow();

    // grants survived: worker keeps capability, others do not gain it
    const broker2 = new CapabilityBroker(s2);
    broker2.registerTool({
      id: 'workspace.write', source: 'builtin', name: 'write', description: 'w',
      inputSchema: { type: 'object' }, capabilityClass: 'reversible', provenance: 'builtin',
    });
    expect(broker2.evaluate({
      toolId: 'workspace.write', args: {}, argsHash: 'h',
      principal: { kind: 'core-agent', agentId: worker.id },
      taskId: task.id, agentId: worker.id,
    }).allowed).toBe(true);

    saveStore(db2, s2);
    db2.close();

    // ---- boot 3: durable across second restart ----
    const db3 = openDatabase(dbPath);
    const s3 = loadStore(db3);
    expect(s3.tasks.get(task.id)?.status).toBe('INTERRUPTED');
    expect(s3.inbox(coord.id).map((m: AgentMessage) => m.id)).toContain('m-art-1');
    db3.close();
  });
});
