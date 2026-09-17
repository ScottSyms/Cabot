import { describe, expect, it } from 'vitest';
import { DurableStore, MemoryBlobStore } from '@cabot/storage';
import { CapabilityBroker } from '@cabot/policy';
import { FakeModelProvider } from '@cabot/providers';
import { FakePythonBackend } from '@cabot/compute';
import { CabotRuntimeService } from '@cabot/runtime';
import { SkillRegistry } from './registry.js';
import { SkillToolExecutor } from './invoke.js';
import { parseSkillYaml, SkillValidationError } from './manifest.js';

const YAML = `
name: ais-analysis
version: 1.2.0
description: Analyze AIS vessel position data and identify movement anomalies.
capabilities:
  required:
    - workspace.read
    - workspace.write
    - python.execute
python:
  runtime: pyodide
  packages:
    - pandas
    - numpy
  entrypoints:
    detect_anomalies:
      script: python/detect_anomalies.py
      function: detect_anomalies
permissions:
  network: none
  filesystem:
    read:
      - task://inputs/**
    write:
      - task://outputs/**
risk:
  side_effects: none
`;

const SKILL_MD = `# ais-analysis\nPurpose: detect anomalies.\nWorkflow: run detect_anomalies on positions.\n`;

const FILES = {
  'python/detect_anomalies.py': 'set_result({"anomalies": 2})',
};

describe('skill manifests', () => {
  it('parses the spec example', () => {
    const m = parseSkillYaml(YAML);
    expect(m.name).toBe('ais-analysis');
    expect(m.python?.packages).toEqual(['pandas', 'numpy']);
    expect(Object.keys(m.python?.entrypoints ?? {})).toEqual(['detect_anomalies']);
    expect(m.network).toBe('none');
  });

  it('rejects unknown capabilities, bad versions, path escapes', () => {
    expect(() => parseSkillYaml(YAML.replace('workspace.read', 'host.shell'))).toThrow(SkillValidationError);
    expect(() => parseSkillYaml(YAML.replace('version: 1.2.0', 'version: latest'))).toThrow(SkillValidationError);
    expect(() => parseSkillYaml(YAML.replace('python/detect_anomalies.py', '../evil.py'))).toThrow(SkillValidationError);
    expect(() => parseSkillYaml('not: [valid')).toThrow(SkillValidationError);
  });
});

describe('skill registry', () => {
  it('installs, versions, and exposes namespaced tools', () => {
    const reg = new SkillRegistry();
    reg.install(YAML, SKILL_MD, 'user-installed', FILES);
    expect(reg.list()).toHaveLength(1);
    // Downgrade / reinstall rejected.
    expect(() => reg.install(YAML, SKILL_MD, 'user-installed', FILES)).toThrow(/supersede/);
    // Missing entrypoint script rejected.
    expect(() => reg.install(YAML, SKILL_MD, 'user-installed', {})).toThrow(/missing script/);
    // Empty SKILL.md rejected.
    expect(() => reg.install(YAML, '', 'user-installed', FILES)).toThrow(/SKILL.md/);

    const tools = reg.toolsFor('ais-analysis');
    expect(tools.map((t) => t.id)).toEqual(['skill.ais-analysis.detect_anomalies']);
    expect(tools[0].source).toBe('skill');
    expect(tools[0].provenance).toBe('skill:ais-analysis@1.2.0');
  });

  it('marks untrusted skills so models treat their content as data', () => {
    const reg = new SkillRegistry();
    reg.install(YAML, SKILL_MD, 'untrusted', FILES);
    expect(reg.toolsFor('ais-analysis')[0].annotations?.untrustedContentHint).toBe(true);
  });
});

describe('skill entrypoint invocation', () => {
  function setup() {
    const store = new DurableStore();
    const broker = new CapabilityBroker(store);
    const reg = new SkillRegistry();
    reg.install(YAML, SKILL_MD, 'user-installed', FILES);
    for (const t of reg.toolsForAll()) broker.registerTool(t);
    const project = store.createProject('P');
    const agent = store.createAgent({
      projectId: project.id, role: 'analyst', objective: 'o', status: 'RUNNING',
      modelConfig: { providerId: 'fake', modelId: 'fake-1' }, skillIds: ['ais-analysis'],
      budget: { maxModelCalls: 20, maxToolCalls: 20 }, workspaceMounts: [], delegationDepth: 0,
    });
    const task = store.createTask({ projectId: project.id, ownerAgentId: agent.id, title: 'T', objective: 'O' });
    broker.grant({
      principal: { kind: 'core-agent', agentId: agent.id },
      toolId: 'skill.ais-analysis.detect_anomalies', scope: 'task', taskId: task.id,
    });
    return { store, broker, project, agent, task, reg };
  }

  it('invokes a tested entrypoint as a typed tool without exposing source', async () => {
    const { store, broker, project, agent, task, reg } = setup();
    let seenCode: string | undefined;
    const backend = new FakePythonBackend((req) => {
      seenCode = req.code;
      return {
        stdout: '2 anomalies', stderr: '',
        resultJson: JSON.stringify({ anomalies: 2 }),
        outputs: { 'report.json': new TextEncoder().encode('{"anomalies":2}') },
        packagesUsed: ['pandas'],
        durationMs: 4,
      };
    });
    const blobs = new MemoryBlobStore();
    const executor = new SkillToolExecutor(reg, backend, blobs, store, task.id, project.id, agent.id, {
      allowed: ['pandas', 'numpy'], denied: [],
    });
    const model = new FakeModelProvider();
    model.script(task.id, [
      {
        kind: 'tool', toolId: 'skill.ais-analysis.detect_anomalies',
        args: { args: { source: 'task://inputs/positions.parquet' } },
        argsHash: 'h1', idempotencyKey: 'sk1',
      },
      { kind: 'done', summary: 'anomalies reported' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');
    // Implementation source reached the backend, never the model context.
    expect(seenCode).toBe(FILES['python/detect_anomalies.py']);
    const published = [...store.artifacts.values()].filter((a) => a.taskId === task.id && !a.staged);
    expect(published.map((a) => a.path)).toEqual(['outputs/report.json']);
  });

  it('denies skills whose packages fall outside policy', async () => {
    const { store, broker, project, agent, task, reg } = setup();
    let ran = false;
    const backend = new FakePythonBackend(() => {
      ran = true;
      return { stdout: '', stderr: '', outputs: {}, packagesUsed: [], durationMs: 1 };
    });
    const blobs = new MemoryBlobStore();
    const executor = new SkillToolExecutor(reg, backend, blobs, store, task.id, project.id, agent.id, {
      allowed: ['numpy'], denied: [],
    });
    const model = new FakeModelProvider();
    model.script(task.id, [
      { kind: 'tool', toolId: 'skill.ais-analysis.detect_anomalies', args: {}, argsHash: 'h1', idempotencyKey: 'sk1' },
      { kind: 'done', summary: 'done' },
    ]);
    const svc = new CabotRuntimeService(store, broker, model, executor);
    expect((await svc.runTask(task.id, agent.id)).status).toBe('complete');
    expect(ran).toBe(false); // pandas not in policy
  });
});
