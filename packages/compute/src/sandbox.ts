// Sandboxed compute prototype (Node spike of the browser design).
// Browser target: Pyodide/WASM in a sandboxed separate-origin context with
// a narrow message interface (ADR-001). This Node spike proves the same
// interface properties with untrusted JS: no host access, scoped inputs,
// captured outputs, timeout enforced by terminating the context.
// API mirrors the planned python.execute tool: { code, inputs, timeoutMs }
// -> { stdout, result, durationMs } or throws IsolationError/TimeoutError.
import { Worker } from 'node:worker_threads';

export class IsolationError extends Error {}
export class ComputeTimeoutError extends Error {}
export class OutputLimitError extends Error {}

export interface ComputeRequest {
  code: string;
  inputs?: unknown;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ComputeResult {
  stdout: string;
  result?: unknown;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;

const WORKER_SOURCE = `
const { parentPort } = require('worker_threads');
const vm = require('vm');
parentPort.on('message', (msg) => {
  const { code, inputsJson, vmTimeoutMs, maxOutputBytes } = msg;
  let stdout = '';
  let settled = false;
  const finish = (out) => { if (!settled) { settled = true; parentPort.postMessage(out); } };
  try {
    const inputs = JSON.parse(inputsJson);
    const print = (...args) => {
      const line = args.map((a) => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return '[unserializable]'; }
      }).join(' ');
      stdout += line + '\\n';
      if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes) {
        throw new Error('OUTPUT_LIMIT_EXCEEDED');
      }
    };
    let resultHolder = { value: undefined };
    const sandbox = Object.create(null);
    sandbox.inputs = inputs;
    sandbox.print = print;
    sandbox.Math = Math;
    sandbox.JSON = JSON;
    sandbox.Number = Number;
    sandbox.String = String;
    sandbox.Boolean = Boolean;
    sandbox.Array = Array;
    sandbox.Object = Object;
    sandbox.setResult = (v) => { resultHolder.value = v; };
    // Freeze globals that could be used for escape via constructor chains.
    const ctx = vm.createContext(sandbox);
    const wrapped = '"use strict";\\n' + msg.code + '\\n';
    vm.runInContext(wrapped, ctx, { timeout: vmTimeoutMs });
    let resultJson = 'null';
    try { resultJson = JSON.stringify(resultHolder.value ?? null); } catch { resultJson = 'null'; }
    if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes) {
      finish({ ok: false, error: 'OUTPUT_LIMIT_EXCEEDED', stdout });
    } else {
      finish({ ok: true, stdout, resultJson });
    }
  } catch (e) {
    const message = e && e.message ? String(e.message) : String(e);
    if (message.includes('OUTPUT_LIMIT_EXCEEDED')) {
      finish({ ok: false, error: 'OUTPUT_LIMIT_EXCEEDED', stdout });
    } else {
      finish({ ok: false, error: message, stdout });
    }
  }
});
`;

export function runSandboxed(req: ComputeRequest): Promise<ComputeResult> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true });
    } catch (e) {
      reject(new IsolationError(`cannot create sandbox worker: ${String(e)}`));
      return;
    }
    const timer = setTimeout(() => {
      void worker.terminate().then(() => {
        reject(new ComputeTimeoutError(`compute exceeded ${timeoutMs}ms; context terminated`));
      });
    }, timeoutMs + 250);
    // Allow process to exit even if worker lingers; cleared on settle.
    (timer as unknown as { unref?: () => void }).unref?.();

    worker.on('message', (msg: { ok: boolean; stdout: string; resultJson?: string; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      const durationMs = Date.now() - started;
      if (!msg.ok) {
        if (msg.error === 'OUTPUT_LIMIT_EXCEEDED') {
          reject(new OutputLimitError('compute output exceeded limit'));
          return;
        }
        if (/timed out|timeout/i.test(msg.error ?? '')) {
          reject(new ComputeTimeoutError(`compute exceeded ${timeoutMs}ms; context terminated`));
          return;
        }
        reject(new IsolationError(msg.error ?? 'sandbox execution failed'));
        return;
      }
      let result: unknown;
      try {
        result = msg.resultJson ? JSON.parse(msg.resultJson) : undefined;
      } catch {
        result = undefined;
      }
      resolve({ stdout: msg.stdout, result, durationMs });
    });
    worker.on('error', (e) => {
      clearTimeout(timer);
      reject(new IsolationError(`sandbox worker error: ${String(e)}`));
    });
    let inputsJson: string;
    try {
      inputsJson = JSON.stringify(req.inputs ?? null);
    } catch {
      clearTimeout(timer);
      void worker.terminate();
      reject(new IsolationError('inputs not serializable'));
      return;
    }
    worker.postMessage({ code: req.code, inputsJson, vmTimeoutMs: timeoutMs, maxOutputBytes });
  });
}
