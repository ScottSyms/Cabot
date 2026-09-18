// Workspace file tools: let the agent create durable files (reports, notes,
// data) that appear in the project's Files view. Bytes live in the blob
// store (OPFS in the extension); metadata is committed to the store only
// after the bytes are verified — the same staged→publish discipline used by
// compute outputs, so a crash cannot leave a file reference without content.
import type { CabotTool } from '@cabot/contracts';
import { DurableStore, sha256HexBytes } from '@cabot/storage/browser-chrome';
import type { ToolExecution, ToolExecutor } from '@cabot/runtime';

/** Async blob store (OPFS-backed in the extension). */
export interface AsyncBlobStore {
  writeStaged(id: string, bytes: Uint8Array): Promise<void>;
  publish(id: string): Promise<void>;
  read(id: string): Promise<Uint8Array>;
  listOrphanStaged(): Promise<string[]>;
}

export const WORKSPACE_WRITE_TOOL: CabotTool = {
  id: 'workspace.write',
  source: 'builtin',
  name: 'write',
  description:
    'Create or overwrite a file in the task workspace (e.g. "report.md", "data/notes.txt"). Use this to save summaries, reports, or any output the user asked to be written to a file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path, e.g. report.md or reports/summary.md' },
      content: { type: 'string', description: 'Full file contents' },
    },
    required: ['path', 'content'],
  },
  capabilityClass: 'reversible',
  provenance: 'builtin',
};

export const WORKSPACE_LIST_TOOL: CabotTool = {
  id: 'workspace.list',
  source: 'builtin',
  name: 'list',
  description: 'List files previously written in this task workspace.',
  inputSchema: { type: 'object', properties: {} },
  capabilityClass: 'read-only',
  provenance: 'builtin',
  annotations: { readOnlyHint: true },
};

export const WORKSPACE_READ_TOOL: CabotTool = {
  id: 'workspace.read',
  source: 'builtin',
  name: 'read',
  description: 'Read back a file previously written in this task workspace.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  capabilityClass: 'read-only',
  provenance: 'builtin',
  annotations: { readOnlyHint: true },
};

export const WORKSPACE_TOOLS: CabotTool[] = [WORKSPACE_WRITE_TOOL, WORKSPACE_LIST_TOOL, WORKSPACE_READ_TOOL];

export function registerWorkspaceTools(register: (t: CabotTool) => void): void {
  for (const t of WORKSPACE_TOOLS) register(t);
}

/** Reject path escapes and non-portable characters. */
export function sanitizeWorkspacePath(input: unknown): string {
  const raw = typeof input === 'string' ? input.trim().replace(/\\/g, '/').replace(/^\/+/, '') : '';
  if (!raw) throw new Error('path is required');
  if (raw.includes('..')) throw new Error(`unsafe path: ${raw}`);
  if (raw.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(raw)) throw new Error(`invalid path: ${raw}`);
  return raw;
}

export class WorkspaceToolExecutor implements ToolExecutor {
  constructor(
    private blobs: AsyncBlobStore,
    private store: DurableStore,
    private taskId: string,
    private projectId: string,
    private agentId: string,
  ) {}

  async execute(toolId: string, args: unknown): Promise<ToolExecution> {
    const a = (args as { path?: unknown; content?: unknown } | undefined) ?? {};
    try {
      switch (toolId) {
        case 'workspace.write':
          return await this.write(a.path, a.content);
        case 'workspace.list':
          return this.list();
        case 'workspace.read':
          return await this.read(a.path);
        default:
          return { ok: false, error: `unknown workspace tool ${toolId}` };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private artifacts() {
    return [...this.store.artifacts.values()].filter((x) => x.taskId === this.taskId && !x.staged);
  }

  private async write(pathInput: unknown, contentInput: unknown): Promise<ToolExecution> {
    const path = sanitizeWorkspacePath(pathInput);
    const content = typeof contentInput === 'string' ? contentInput : JSON.stringify(contentInput ?? '', null, 2);
    const bytes = new TextEncoder().encode(content);
    const hash = sha256HexBytes(bytes);
    const id = `ws_${this.taskId}_${path.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
    // Bytes first, then metadata: never a reference without content.
    await this.blobs.writeStaged(id, bytes);
    await this.blobs.publish(id);
    const meta = this.store.stageArtifact({
      projectId: this.projectId,
      taskId: this.taskId,
      agentId: this.agentId,
      path,
      bytes: bytes.length,
      sha256: hash,
    });
    this.store.artifacts.delete(meta.id);
    this.store.artifacts.set(id, { ...meta, id });
    this.store.publishArtifact(id, bytes.length, hash);
    this.store.appendConversation(this.taskId, this.agentId, 'tool', `workspace.write — wrote ${path}`, {
      toolId: 'workspace.write',
      ok: true,
      result: `wrote ${path} (${bytes.length} bytes)`,
    });
    return { ok: true, resultHash: hash, result: { path, bytes: bytes.length } };
  }

  private list(): ToolExecution {
    const files = this.artifacts().map((x) => ({ path: x.path, bytes: x.bytes }));
    return { ok: true, resultHash: sha256HexBytes(JSON.stringify(files)), result: { files } };
  }

  private async read(pathInput: unknown): Promise<ToolExecution> {
    const path = sanitizeWorkspacePath(pathInput);
    const art = this.artifacts().find((x) => x.path === path);
    if (!art) return { ok: false, error: `no such file: ${path}` };
    const bytes = await this.blobs.read(art.id);
    const text = new TextDecoder().decode(bytes).slice(0, 20_000);
    return { ok: true, resultHash: art.sha256, result: { path, content: text, truncated: bytes.length > 20_000 } };
  }
}
