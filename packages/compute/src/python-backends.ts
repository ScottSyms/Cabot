// Test/dev Python backends. FakePythonBackend is deterministic for loop
// tests. SubprocessPythonBackend runs a real interpreter for dev spikes with
// timeout kill and a scoped scratch dir — explicitly NOT a security boundary.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { PythonBackend, PythonBackendRequest, PythonBackendResult } from './python.js';

export class FakePythonBackend implements PythonBackend {
  constructor(private handler: (req: PythonBackendRequest) => PythonBackendResult | Promise<PythonBackendResult>) {}

  execute(req: PythonBackendRequest): Promise<PythonBackendResult> {
    return Promise.resolve(this.handler(req));
  }
}

export interface SubprocessOptions {
  pythonBin?: string;
  defaultTimeoutMs?: number;
}

export class SubprocessPythonBackend implements PythonBackend {
  constructor(private opts: SubprocessOptions = {}) {}

  async execute(req: PythonBackendRequest): Promise<PythonBackendResult> {
    const started = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'cabot-py-'));
    try {
      const inputDir = join(dir, 'inputs');
      const outputDir = join(dir, 'outputs');
      mkdirSync(inputDir, { recursive: true });
      mkdirSync(outputDir, { recursive: true });
      for (const [name, bytes] of Object.entries(req.inputs)) {
        writeFileSync(join(inputDir, name), bytes);
      }
      writeFileSync(join(dir, 'args.json'), JSON.stringify(req.args ?? null));
      const runner = `
import json, sys, traceback
args = json.load(open(${JSON.stringify(join(dir, 'args.json'))}))
INPUT_DIR = ${JSON.stringify(inputDir)}
OUTPUT_DIR = ${JSON.stringify(outputDir)}
__result = None
def set_result(v):
    global __result
    __result = v
${req.entrypoint ? `# entrypoint ${req.entrypoint} resolved by the Skill loader in production\n` : ''}${req.code ?? 'set_result(None)'}
print("__CABOT_RESULT__" + json.dumps(__result if __result is not None else None))
`;
      writeFileSync(join(dir, 'main.py'), runner);
      const timeoutMs = req.timeoutMs;
      const proc = spawnSync(this.opts.pythonBin ?? 'python3', ['-I', '-E', join(dir, 'main.py')], {
        cwd: dir,
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      if (proc.error) {
        const err = proc.error as NodeJS.ErrnoException & { code?: string };
        if (err.code === 'ETIMEDOUT') throw new Error(`python exceeded ${timeoutMs}ms; process killed`);
        throw new Error(`python launch failed: ${String(proc.error)}`);
      }
      if (proc.status !== 0) {
        throw new Error(`python exited ${proc.status}: ${(proc.stderr ?? '').slice(0, 2000)}`);
      }
      const stdout = proc.stdout ?? '';
      const marker = '__CABOT_RESULT__';
      const idx = stdout.lastIndexOf(marker);
      const resultJson = idx >= 0 ? stdout.slice(idx + marker.length).trim().split('\n')[0] : undefined;
      const cleanStdout = idx >= 0 ? stdout.slice(0, idx) : stdout;
      const outputs: Record<string, Uint8Array> = {};
      for (const f of readdirSync(outputDir)) {
        outputs[f] = new Uint8Array(readFileSync(join(outputDir, f)));
      }
      return {
        stdout: cleanStdout,
        stderr: proc.stderr ?? '',
        resultJson,
        outputs,
        packagesUsed: [],
        durationMs: Date.now() - started,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
