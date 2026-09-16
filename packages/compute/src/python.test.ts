import { describe, expect, it } from 'vitest';
import { DurableStore, MemoryBlobStore } from '@cabot/storage';
import { CapabilityBroker } from '@cabot/policy';
import { FakeModelProvider } from '@cabot/providers';
import { CabotRuntimeService } from '@cabot/runtime';
import {
  PYTHON_EXECUTE_TOOL,
  PythonToolExecutor,
} from './python.js';
import { FakePythonBackend, SubprocessPythonBackend } from './python-backends.js';

const POLICY = { allowed: ['pandas', 'numpy'], denied: ['requests'] };

function setup() {
  const store = new DurableStore();
  const broker = new CapabilityBroker(store);
  broker.registerTool(PYTHON_EXECUTE_TOOL);
  const project = store.createProject('P');
  const agent = store.createAgent({
    projectId: project.id, role: 'analyst', objective: 'analyze', status: 'RUNNING',
    modelConfig: { providerId: 'fake', modelId: 'fake-1' }, skillIds: [],
    budget: { maxModelCalls: 20, maxToolCalls: 20 }, workspaceMounts: [], delegationDepth: 0,
  });
  const task = store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
  broker.grant({ principal: { kind: 'core-agent', agentId: agent.id }, toolId: 'python.execute', scope: 'task', taskId: task.id });
  return { store, broker, project, agent, task };
}

describe('python.execute', () => {
  it('runs through the brokered loop and persists declared outputs as artifacts', async () => {
    const { store, broker, project, agent, task } = setup();
    const backend = new FakePythonBackend(() => ({
      stdout: 'mean=3.0',
      stderr: '',
      resultJson: JSON.stringify({ mean: 3 }),
      outputs: { 'summary.csv': new TextEncoder().encode('mean\n3.0\n') },
      packagesUsed: ['numpy'],
      durationMs: 5,
    }));
    const blobs = new MemoryBlobStore();
    const executor = new PythonToolExecutor(backend, blobs, store, task.id, project.id, agent.id, POLICY);
    const model = new FakeModelProvider();
    model.script(task.id, [
      {
        kind: 'tool', toolId: 'python.execute',
        args: { code: 'print("hi")', packages: ['numpy'], outputs: ['summary.csv'] },
        argsHash: 'h1', idempotencyKey: 'py1',
      },
      { kind: 'done', summary: 'analyzed' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');

    const published = [...store.artifacts.values()].filter((a) => a.taskId === task.id && !a.staged);
    expect(published).toHaveLength(1);
    expect(published[0].path).toBe('outputs/summary.csv');
    expect(new TextDecoder().decode(blobs.read(published[0].id))).toBe('mean\n3.0\n');
  });

  it('denies non-pre-approved and denied packages before execution', async () => {
    const { store, broker, project, agent, task } = setup();
    let ran = false;
    const backend = new FakePythonBackend(() => {
      ran = true;
      return { stdout: '', stderr: '', outputs: {}, packagesUsed: [], durationMs: 1 };
    });
    const blobs = new MemoryBlobStore();
    const executor = new PythonToolExecutor(backend, blobs, store, task.id, project.id, agent.id, POLICY);
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'python.execute', args: { code: 'x', packages: ['requests'] }, argsHash: 'h1', idempotencyKey: 'py1' },
      { kind: 'tool', toolId: 'python.execute', args: { code: 'x', packages: ['scipy'] }, argsHash: 'h2', idempotencyKey: 'py2' },
      { kind: 'done', summary: 'done' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');
    expect(ran).toBe(false);
    const failed = store.events.filter((e) => e.type === 'tool.failed');
    expect(failed.some((e) => e.summary.includes('denied by policy: requests'))).toBe(true);
    expect(failed.some((e) => e.summary.includes('not pre-approved: scipy'))).toBe(true);
  });

  it('subprocess backend runs real Python with timeout kill', async () => {
    const backend = new SubprocessPythonBackend();
    const ok = await backend.execute({
      args: { n: 21 },
      packages: [],
      timeoutMs: 10_000,
      inputs: {},
      code: 'import json\nargs["doubled"] = args["n"] * 2\nopen(OUTPUT_DIR + "/out.json", "w").write(json.dumps(args))\nprint("ran")\nset_result({"doubled": args["doubled"]})',
    });
    expect(ok.stdout).toContain('ran');
    expect(JSON.parse(ok.resultJson ?? '{}')).toEqual({ doubled: 42 });
    expect(JSON.parse(new TextDecoder().decode(ok.outputs['out.json']))).toMatchObject({ doubled: 42 });

    await expect(
      backend.execute({ args: null, packages: [], timeoutMs: 500, inputs: {}, code: 'import time\ntime.sleep(30)' }),
    ).rejects.toThrow(/exceeded 500ms/);
  }, 30_000);
});
