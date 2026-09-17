// Brokered Python execution (spec §14).
// The model requests `python.execute`; the Capability Broker authorizes it;
// PythonToolExecutor runs it against a PythonBackend and persists declared
// outputs as verified artifacts. Backends:
//   - PyodideBackend (browser target): Pyodide in the sandboxed
//     separate-origin compute context (ADR-001). Implemented at packaging.
//   - SubprocessPythonBackend (dev/test only): restricted local python3 with
//     timeout kill. NOT a security boundary — never for untrusted code.
//   - FakePythonBackend: deterministic scripted results for loop tests.
// Package installation is policy-controlled: anything outside the
// pre-approved list is denied before execution; unknown packages never
// install silently.
import type { CabotTool } from '@cabot/contracts';
import { DurableStore, sha256Hex, type BlobStore } from '@cabot/storage';
import type { ToolExecution, ToolExecutor } from '@cabot/runtime';

export const PYTHON_EXECUTE_TOOL: CabotTool = {
  id: 'python.execute',
  source: 'compute',
  name: 'execute',
  description: 'Execute Python code or a Skill entrypoint in the sandboxed compute worker. Declared outputs persist as task artifacts.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      entrypoint: { type: 'string' },
      args: { type: 'object' },
      packages: { type: 'array', items: { type: 'string' } },
      timeoutMs: { type: 'number' },
      inputs: { type: 'object' },
      outputs: { type: 'array', items: { type: 'string' } },
    },
  },
  capabilityClass: 'reversible',
  provenance: 'compute',
};

export interface PythonExecuteArgs {
  code?: string;
  entrypoint?: string;
  args?: unknown;
  packages?: string[];
  timeoutMs?: number;
  inputs?: Record<string, string>;
  outputs?: string[];
}

export interface PythonBackendRequest {
  code?: string;
  entrypoint?: string;
  args: unknown;
  packages: string[];
  timeoutMs: number;
  inputs: Record<string, Uint8Array>;
}

export interface PythonBackendResult {
  stdout: string;
  stderr: string;
  resultJson?: string;
  outputs: Record<string, Uint8Array>;
  packagesUsed: string[];
  durationMs: number;
}

export interface PythonBackend {
  execute(req: PythonBackendRequest): Promise<PythonBackendResult>;
}

export interface PackagePolicy {
  allowed: string[];
  denied: string[];
}

export function checkPackages(policy: PackagePolicy, requested: string[]): { allowed: boolean; reason: string } {
  for (const p of requested) {
    const name = p.split('==')[0].split('>=')[0].trim();
    if (policy.denied.includes(name)) return { allowed: false, reason: `package denied by policy: ${name}` };
    if (!policy.allowed.includes(name)) return { allowed: false, reason: `package not pre-approved: ${name}` };
  }
  return { allowed: true, reason: 'packages approved' };
}

/** Persist backend outputs as verified artifacts; shared by code and Skill entrypoints. */
export function persistOutputs(
  blobs: BlobStore,
  store: DurableStore,
  ctx: { taskId: string; projectId: string; agentId: string; prefix: string },
  outputs: Record<string, Uint8Array>,
  declared: string[],
): string[] {
  const artifactIds: string[] = [];
  for (const name of declared) {
    const bytes = outputs[name];
    if (!bytes) continue;
    const id = `${ctx.prefix}_${ctx.taskId}_${name.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
    const hash = sha256Hex(bytes);
    blobs.writeStaged(id, bytes);
    blobs.publish(id, bytes.length, hash);
    const meta = store.stageArtifact({
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      path: `outputs/${name}`,
      bytes: bytes.length,
      sha256: hash,
    });
    // Align metadata id with blob id for durable cross-reference.
    store.artifacts.delete(meta.id);
    store.artifacts.set(id, { ...meta, id });
    store.publishArtifact(id, bytes.length, hash);
    artifactIds.push(id);
  }
  return artifactIds;
}

export class PythonToolExecutor implements ToolExecutor {
  constructor(
    private backend: PythonBackend,
    private blobs: BlobStore,
    private store: DurableStore,
    private taskId: string,
    private projectId: string,
    private agentId: string,
    private policy: PackagePolicy,
  ) {}

  async execute(toolId: string, args: unknown): Promise<ToolExecution> {
    if (toolId !== 'python.execute') return { ok: false, error: `unknown compute tool ${toolId}` };
    const a = (args as PythonExecuteArgs | undefined) ?? {};
    if (!a.code && !a.entrypoint) return { ok: false, error: 'python.execute requires code or entrypoint' };
    const packages = a.packages ?? [];
    const policyCheck = checkPackages(this.policy, packages);
    if (!policyCheck.allowed) {
      this.store.appendEvent(this.taskId, 'tool.failed', `python.execute denied: ${policyCheck.reason}`);
      return { ok: false, error: policyCheck.reason };
    }
    const inputs: Record<string, Uint8Array> = {};
    for (const [name, text] of Object.entries(a.inputs ?? {})) {
      inputs[name] = new TextEncoder().encode(text);
    }
    let result: PythonBackendResult;
    try {
      result = await this.backend.execute({
        code: a.code,
        entrypoint: a.entrypoint,
        args: a.args ?? null,
        packages,
        timeoutMs: a.timeoutMs ?? 30_000,
        inputs,
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // Persist declared outputs as verified artifacts: blob first, then metadata.
    const declared = a.outputs ?? Object.keys(result.outputs);
    const artifactIds = persistOutputs(
      this.blobs,
      this.store,
      { taskId: this.taskId, projectId: this.projectId, agentId: this.agentId, prefix: 'py' },
      result.outputs,
      declared,
    );
    this.store.appendEvent(this.taskId, 'tool.completed', `python.execute ok in ${result.durationMs}ms (${artifactIds.length} artifacts)`);
    let resultValue: unknown;
    try {
      resultValue = result.resultJson ? JSON.parse(result.resultJson) : undefined;
    } catch {
      resultValue = undefined;
    }
    return { ok: true, resultHash: sha256Hex(new TextEncoder().encode(result.stdout + result.stderr)), result: { result: resultValue, artifacts: artifactIds, packagesUsed: result.packagesUsed } };
  }
}
