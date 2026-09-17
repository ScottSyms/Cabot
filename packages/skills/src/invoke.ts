// Skill entry-point invocation: typed tools over packaged Python.
// The model receives the tool schema, never the implementation source.
// Execution flows through the same backend + artifact pipeline as
// python.execute, with the skill's declared packages and network policy
// enforced before anything runs.
import { DurableStore, sha256Hex, type BlobStore } from '@cabot/storage';
import {
  checkPackages,
  persistOutputs,
  type PackagePolicy,
  type PythonBackend,
} from '@cabot/compute';
import type { ToolExecution, ToolExecutor } from '@cabot/runtime';
import type { SkillRegistry } from './registry.js';

export class SkillToolExecutor implements ToolExecutor {
  constructor(
    private registry: SkillRegistry,
    private backend: PythonBackend,
    private blobs: BlobStore,
    private store: DurableStore,
    private taskId: string,
    private projectId: string,
    private agentId: string,
    private packagePolicy: PackagePolicy,
  ) {}

  async execute(toolId: string, args: unknown): Promise<ToolExecution> {
    const parts = toolId.split('.');
    if (parts.length !== 3 || parts[0] !== 'skill') {
      return { ok: false, error: `not a skill tool: ${toolId}` };
    }
    const [, skillName, entrypoint] = parts;
    let skill: ReturnType<SkillRegistry['get']>;
    try {
      skill = this.registry.get(skillName);
    } catch {
      return { ok: false, error: `skill not installed: ${skillName}` };
    }
    const ep = skill.manifest.python?.entrypoints[entrypoint];
    if (!ep) return { ok: false, error: `unknown entrypoint ${entrypoint} in skill ${skillName}` };
    if (skill.manifest.network !== 'none') {
      return { ok: false, error: `skill ${skillName} requests network; must be acquired via brokered fetch` };
    }
    const code = skill.files[ep.script];
    if (code === undefined) return { ok: false, error: `missing packaged script ${ep.script}` };
    const packages = skill.manifest.python?.packages ?? [];
    const policyCheck = checkPackages(this.packagePolicy, packages);
    if (!policyCheck.allowed) {
      this.store.appendEvent(this.taskId, 'tool.failed', `${toolId} denied: ${policyCheck.reason}`);
      return { ok: false, error: policyCheck.reason };
    }
    const a = (args as { args?: unknown; timeoutMs?: number; inputs?: Record<string, string>; outputs?: string[] } | undefined) ?? {};
    const inputs: Record<string, Uint8Array> = {};
    for (const [name, text] of Object.entries(a.inputs ?? {})) {
      inputs[name] = new TextEncoder().encode(text);
    }
    let result: Awaited<ReturnType<PythonBackend['execute']>>;
    try {
      result = await this.backend.execute({
        code,
        entrypoint: ep.function,
        args: a.args ?? null,
        packages,
        timeoutMs: a.timeoutMs ?? 30_000,
        inputs,
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const artifactIds = persistOutputs(
      this.blobs,
      this.store,
      { taskId: this.taskId, projectId: this.projectId, agentId: this.agentId, prefix: `skill_${skillName}_${entrypoint}` },
      result.outputs,
      a.outputs ?? Object.keys(result.outputs),
    );
    this.store.appendEvent(this.taskId, 'tool.completed', `${toolId} ok in ${result.durationMs}ms (${artifactIds.length} artifacts)`);
    let resultValue: unknown;
    try {
      resultValue = result.resultJson ? JSON.parse(result.resultJson) : undefined;
    } catch {
      resultValue = undefined;
    }
    return { ok: true, resultHash: sha256Hex(new TextEncoder().encode(result.stdout + result.stderr)), result: { result: resultValue, artifacts: artifactIds } };
  }
}
