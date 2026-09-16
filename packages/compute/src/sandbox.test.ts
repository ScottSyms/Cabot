import { describe, expect, it } from 'vitest';
import { ComputeTimeoutError, IsolationError, runSandboxed } from './sandbox.js';

describe('sandboxed compute', () => {
  it('runs useful computation with scoped inputs and captured output', async () => {
    const r = await runSandboxed({
      code: `print('sum', inputs.a + inputs.b); setResult({ sum: inputs.a + inputs.b });`,
      inputs: { a: 2, b: 3 },
    });
    expect(r.stdout).toContain('sum 5');
    expect(r.result).toEqual({ sum: 5 });
  });

  it('denies host access: process/require/fetch/child_process', async () => {
    for (const code of [
      `setResult(typeof process);`,
      `setResult(typeof require);`,
      `setResult(typeof fetch);`,
      `setResult(typeof globalThis.process);`,
      `require('child_process').execSync('id');`,
      `require('fs').readFileSync('/etc/hostname', 'utf8');`,
    ]) {
      const r = await runSandboxed({ code }).then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      // Either blocked (throws) or yields undefined — never host handles/contents.
      if (r.ok) {
        expect(['undefined', null]).toContain(r.v.result as unknown);
      } else {
        expect(r.e).toBeInstanceOf(IsolationError);
      }
    }
  });

  it('enforces timeout by terminating the context', async () => {
    await expect(
      runSandboxed({ code: `while (true) {}`, timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(ComputeTimeoutError);
  }, 10_000);

  it('enforces output limits', async () => {
    const { OutputLimitError } = await import('./sandbox.js');
    await expect(
      runSandboxed({ code: `while (true) { print('x'.repeat(1000)); }`, timeoutMs: 2000, maxOutputBytes: 4096 }),
    ).rejects.toBeInstanceOf(OutputLimitError);
  }, 10_000);
});
