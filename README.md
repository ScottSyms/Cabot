# Cabot — Browser-Native Autonomous Agent Runtime

Cabot is a long-running, resumable autonomous agent that lives inside the
browser (Chromium/Edge MV3 extension). It plans multi-step work, uses tools,
executes code, delegates to subagents, and survives the death of any JS
execution context by checkpointing durable state.

Core principle: **the model may request capabilities; it never receives
ambient authority.** See `specification.md` (the normative spec) and
`docs/adr/` for the recorded architecture decisions.

## Status

Active foundation build. The durable core, capability broker, browser tools,
model providers, compute, and approval flows are implemented and tested
(40 tests green). The side-panel UI is still a thin stub; Skills, MCP, and
WebMCP adapters are not yet built.

## Layout

```text
apps/extension/          MV3 shell: manifest, service-worker supervisor,
                         offscreen coordinator, side-panel stub
packages/
  contracts/             Durable entities, lifecycles, tool/capability types
  storage/               DurableStore, SQLite snapshot/restore, blob stores
  policy/                Capability Broker (authorization boundary)
  runtime/               Checkpointed agent loop, CabotRuntimeService, inspection
  providers/             ModelProvider contract, fake + OpenAI-compatible adapters
  tools/                 Browser tools (read + write), Chrome/fake backends
  compute/               JS sandbox, python.execute, dev/fake Python backends
tests/
  recovery/              Cross-agent crash-recovery scenario
  persistence/           SQLite close/reopen durability
  research/              End-to-end read-only research task
docs/adr/                001 compute isolation, 002 storage authority,
                         003 capability principal binding
specification.md         Normative product + technical specification
```

## Invariants (enforced by tests, not by convention)

- **Durable, not immortal.** Every turn commits task + event + checkpoint.
  Anything `DISPATCHED` at restart becomes `UNCERTAIN` — never silently
  replayed. Retried steps reuse idempotency keys and skip duplicate dispatch.
- **Channel-bound principals.** The requesting principal comes from the
  supervisor's message-channel binding, never from an agent-supplied field.
  Spoofing is rejected; children inherit only explicitly delegated skills.
- **Approval-bound consequential actions.** Consequential tools require a
  grant *and* an explicit approval bound to task/agent/tool/args/target.
  Changed arguments invalidate the approval; revoked grants fail dispatch.
- **Staged artifact publication.** Blob bytes flush and verify (size + hash)
  before metadata commits; orphans are listed for post-crash GC.
- **Isolated compute.** Untrusted code runs with no host access (no
  `process`/`require`/`fetch`/fs), scoped inputs, captured outputs, timeout
  enforced by terminating the context.

## Develop

```bash
npm install
npm test          # vitest, all packages + integration suites
npm run typecheck # strict tsc --noEmit
```

## Run in Chrome / Edge (preview)

```bash
npm run build:extension
```

Then load unpacked:

1. Open `chrome://extensions`, enable Developer mode.
2. "Load unpacked" → select `apps/extension` (the folder containing
   `manifest.json`). The bundle lives in `apps/extension/dist` and is
   git-ignored; rebuild after pulling.
3. Open the side panel (action click opens it), configure the model
   provider (Settings: endpoint, model id, optional API key), and run a
   page summary.
4. Close and reopen the browser: tasks, sources, and approvals persist as
   OPFS files reconciled on startup.

Preview scope: read-only research tasks (list/read pages, capture sources).
Write-path tools, Python/Skills, and MCP are implemented and tested but not
yet wired into the panel. The Node `vm`/subprocess compute backends are
development-only and never ship in the bundle (no `node:` imports in
`dist/`).

Requirements: Node 22+ (`node:sqlite` used for the file-backed durability
spike; the browser target uses SQLite-WASM + OPFS behind the same SQL and
`BlobStore` interfaces). `python3` on PATH for the subprocess compute test
(dev-only backend — not a security boundary).

## Key entry points

- `packages/runtime/src/loop.ts` — `runAgentTurn` / `runUntilSettled`
- `packages/runtime/src/api.ts` — `CabotRuntimeService` (UI-facing API)
- `packages/runtime/src/inspect.ts` — task detail, approval inbox, dashboard
- `packages/policy/src/broker.ts` — `CapabilityBroker.evaluate` /
  `authorizeDispatch` / `decideApproval`
- `packages/storage/src/store.ts` — `DurableStore` transaction engine
- `packages/storage/src/sqlite-persist.ts` — `saveStore` / `loadStore`
- `packages/tools/src/browser.ts` — tool definitions + `BrowserToolExecutor`
- `packages/compute/src/python.ts` — `python.execute` + package policy
- `apps/extension/src/service-worker/supervisor.ts` — MV3 supervisor
