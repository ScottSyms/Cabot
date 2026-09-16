# Cabot — Browser-Native Autonomous Agent Runtime

**Document:** Product and Technical Specification  
**Status:** Draft 0.3  
**Date:** 2026-09-16  
**Target:** Chromium / Microsoft Edge Manifest V3 extension  
**Codename/Product name:** Cabot

---

## 1. Executive Summary

Cabot is a long-running, resumable autonomous agent that operates primarily inside the web browser.

It is intended to provide the practical benefits associated with full agent harnesses such as Hermes—multi-step reasoning, persistent projects, tool use, skills, code execution, delegation, long-running tasks, artifact creation, memory, and recovery—while retaining the security advantages of the browser sandbox.

Cabot is not a chatbot embedded in a browser. It is a **browser-native agent runtime** with a conversational interface.

The browser is both:

1. Cabot's primary execution environment; and
2. Cabot's primary tool surface.

Cabot SHALL use browser security boundaries, Web Workers, Manifest V3 permissions, the Origin Private File System (OPFS), explicit capability brokering, user approvals, and sandboxed WebAssembly/Python execution to ensure that model-generated actions cannot directly inherit unrestricted browser or operating-system privileges.

Cabot SHALL be designed on the assumption that any browser execution context may disappear without warning. Long-running work SHALL therefore be represented as durable state machines whose state is checkpointed to persistent browser storage and can be reconstructed after worker termination, browser suspension, extension reload, browser restart, or system restart.

Cabot SHALL support:

- persistent projects and workspaces;
- long-running and resumable agent tasks;
- tool use against browser-native capabilities;
- Skills containing instructions and executable code;
- Python execution through Pyodide;
- WebAssembly and SQL execution;
- Model Context Protocol (MCP) clients;
- WebMCP tools exposed by websites;
- browser automation through an explicit capability broker;
- local and remote model providers;
- per-task memory, project memory, and reusable knowledge;
- human approval for sensitive or consequential operations;
- auditing and inspection of agent activity;
- multiple concurrent agents and delegated subtasks;
- offline-capable operation where model and tool dependencies permit it.

The core architectural principle is:

> **The model may request capabilities. It never receives ambient authority.**

---

# 2. Product Goals

## 2.1 Primary Goals

Cabot SHALL provide an autonomous agent environment capable of performing substantial multi-step work while remaining contained inside the browser.

Cabot SHALL:

1. Execute multi-step tasks over minutes, hours, or longer periods while the browser is available.
2. Recover incomplete tasks after execution contexts are destroyed.
3. Maintain persistent project workspaces independent of individual conversations.
4. Browse, inspect, navigate, and interact with websites under explicit permission controls.
5. Prefer structured web interfaces such as WebMCP when available.
6. Consume remote and local MCP servers.
7. Execute agent-authored or skill-provided Python inside a Pyodide sandbox.
8. Support reusable Skills containing instructions, schemas, Python, SQL, WASM, templates, tests, and reference material.
9. Support dynamic generation of code and artifacts without granting host operating-system access.
10. Provide users with visibility into what the agent is doing, what resources it is using, and what actions require approval.
11. Separate reasoning/model execution from privileged browser actions.
12. Allow multiple model providers and model-routing policies.
13. Remain useful even when no native host companion application is installed.
14. Provide a clean internal API so multiple user interfaces and agent clients can control the same runtime.
15. Support multiple independent and cooperating agents as durable, separately permissioned actors within a project.

## 2.2 Secondary Goals

Cabot SHOULD:

- support local WebGPU inference where feasible;
- allow tasks to delegate bounded subtasks;
- provide a command palette in addition to chat;
- support right-click and page-selection interactions;
- support task scheduling while the browser is running;
- support task export/import;
- provide developer tooling for creating and testing Skills;
- support enterprise policy controls;
- support centralized allow/deny lists for tools, MCP servers, models, packages, and websites.

## 2.3 Non-Goals

The initial Cabot implementation SHALL NOT attempt to provide unrestricted:

- host shell access;
- arbitrary execution of native binaries;
- access to the user's entire filesystem;
- SSH access;
- Docker or container-daemon access;
- arbitrary local process creation;
- access to browser secrets, cookies, credentials, or authentication tokens outside explicit browser APIs and policy;
- execution while the browser and operating system are completely shut down.

A future native companion MAY provide selected host capabilities, but these SHALL remain optional and SHALL NOT weaken the browser-only security model for installations that do not enable them.

---

# 3. Design Principles

## 3.1 Durable, Not Immortal

Cabot SHALL NOT depend on a JavaScript execution context remaining alive indefinitely.

Tasks SHALL persist enough state to resume after interruption.

Durability SHALL come from persisted state and deterministic recovery rather than keep-alive tricks.

## 3.2 Explicit Capability Security

No LLM, Skill, Python program, MCP server, WebMCP tool, webpage, or generated script SHALL directly receive extension-level privileges merely because Cabot can access them.

Privileged operations SHALL pass through a Capability Broker.

## 3.3 Projects, Not Chats

Conversation history is an interface artifact. Cabot's durable unit of work SHALL be the **Project**.

Projects contain tasks, files, memory, skills, structured state, sources, and artifacts.

## 3.4 Structured Interfaces Before UI Guessing

For interacting with websites, Cabot SHOULD use the following preference order when possible:

1. WebMCP tools;
2. explicit application/API integrations;
3. semantic DOM/accessibility representations;
4. deterministic DOM interaction;
5. visual interaction/screenshot reasoning as a fallback.

## 3.5 Data Is Not Instruction

Content obtained from webpages, files, MCP resources, MCP tools, WebMCP tools, downloaded documents, model outputs, and user-generated web content SHALL be treated as untrusted data unless explicitly elevated by policy.

Tool descriptions and tool results SHALL NOT be permitted to silently redefine Cabot's system policy.

## 3.6 Least Privilege by Default

New Skills, MCP servers, domains, Python packages, and actions SHALL receive the minimum capabilities necessary to function.

## 3.7 Inspectability

Users SHALL be able to determine:

- what Cabot is currently doing;
- which task is active;
- which tools have been used;
- what external systems were contacted;
- what files were read or written;
- what approvals were granted;
- what artifacts were generated;
- where a task stopped;
- why a task is blocked.

---

# 4. High-Level Architecture

```text
                         Chromium / Edge
┌─────────────────────────────────────────────────────────────┐
│ Cabot Manifest V3 Extension                                │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ User Interfaces                                       │  │
│  │ Side Panel | Task Dashboard | Command Palette         │  │
│  │ Page Actions | Approval Inbox | Workspace Explorer    │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │                                   │
│                         ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ MV3 Service Worker                                    │  │
│  │ Events | Browser API Broker | Scheduler | Supervisor  │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │ chrome.runtime messaging           │
│                         ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Offscreen Runtime Document                            │  │
│  │                                                       │  │
│  │  ┌───────────────┐       ┌─────────────────────────┐  │  │
│  │  │ Agent Runtime │       │ Capability Coordinator  │  │  │
│  │  └──────┬────────┘       └───────────┬─────────────┘  │  │
│  │         │                            │                │  │
│  │    ┌────┴──────────────┬─────────────┼───────────┐    │  │
│  │    ▼                   ▼             ▼           ▼    │  │
│  │ Agent Workers     Storage Worker  Pyodide    Other    │  │
│  │                                  Workers    Workers   │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │                                   │
│                         ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ OPFS                                                  │  │
│  │ Projects | Tasks | SQLite | Artifacts | Skills        │  │
│  │ Cache | Model data | Checkpoints | Logs               │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  Tool/Protocol Adapters                                     │
│  ├── Browser tools                                          │
│  ├── WebMCP                                                 │
│  ├── MCP                                                    │
│  ├── Pyodide                                                │
│  ├── SQL / DuckDB-Wasm                                      │
│  ├── WASM                                                   │
│  └── Model providers                                        │
└─────────────────────────────────────────────────────────────┘
```

---

# 5. Browser Runtime

## 5.1 Manifest V3 Service Worker

The extension service worker SHALL be treated as an event-driven supervisor, not as the durable agent process.

Responsibilities SHALL include:

- handling browser extension events;
- receiving UI requests;
- requesting extension permissions;
- executing privileged `chrome.*` APIs;
- maintaining alarms and wake-up signals;
- creating or locating the offscreen runtime;
- routing messages between browser contexts;
- rehydrating task execution after restart;
- acting as the final extension-privilege boundary.

Persistent task state SHALL NOT exist solely in service-worker globals.

Chrome explicitly advises extension developers to persist state rather than rely on global variables because service workers can terminate and restart. Long operations are also bounded by worker lifecycle rules. Cabot SHALL therefore assume termination is routine rather than exceptional.

## 5.2 Offscreen Runtime Document

Cabot SHOULD use a Manifest V3 offscreen document with the `WORKERS` reason to host browser workers required by the agent runtime.

The offscreen document SHALL:

- remain non-interactive and non-user-visible;
- communicate with the extension through `chrome.runtime` messaging;
- spawn dedicated workers;
- avoid holding authoritative task state only in memory;
- be replaceable after loss without corrupting tasks.

Cabot SHALL NOT treat the offscreen document as guaranteed immortal execution.

## 5.3 Dedicated Workers

Cabot SHOULD use dedicated workers for isolation and responsiveness.

Expected worker classes:

- Agent Worker
- Storage Worker
- Pyodide Worker
- SQL / DuckDB Worker
- Embedding Worker
- Local Model Worker
- Document Processing Worker

Workers SHALL communicate through structured messages and/or `MessagePort` channels.

Where `SharedArrayBuffer` is required, the extension MAY opt into the browser's cross-origin isolation mechanisms.

---

# 6. Durable Task Runtime

## 6.1 Task as State Machine

Every long-running Cabot task SHALL be represented by durable state rather than by an assumed continuous loop.

A simplified lifecycle is:

```text
CREATED
  ↓
READY
  ↓
RUNNING
  ├── MODEL_PENDING
  ├── TOOL_PENDING
  ├── COMPUTE_PENDING
  ├── APPROVAL_REQUIRED
  ├── WAITING_EXTERNAL
  └── CHECKPOINTING
  ↓
COMPLETE

Alternative terminal states:
FAILED | CANCELLED

Recoverable states:
INTERRUPTED | SUSPENDED | BLOCKED
```

## 6.2 Checkpointing

Cabot SHALL checkpoint at least after:

- model responses that change the task plan;
- tool calls;
- tool results;
- artifact creation;
- browser navigation that materially changes state;
- approval requests;
- approval decisions;
- delegation;
- external task handles;
- Python/SQL/WASM execution results;
- explicit user pause;
- task completion or failure.

The runtime MAY additionally checkpoint periodically.

## 6.3 Event Journal

Each task SHOULD have an append-oriented event journal.

Example events:

```text
task.created
plan.updated
model.requested
model.responded
tool.requested
tool.started
tool.completed
tool.failed
artifact.created
approval.requested
approval.granted
approval.denied
subtask.created
subtask.completed
checkpoint.committed
task.paused
task.resumed
task.completed
```

The journal SHALL contain operational summaries and structured state, not hidden model chain-of-thought.

## 6.4 Recovery

At startup Cabot SHALL query durable task storage for non-terminal tasks.

Recovery SHALL:

1. identify interrupted tasks;
2. determine the last committed checkpoint;
3. reconcile any in-flight external operation where possible;
4. mark uncertain non-idempotent operations for explicit recovery handling;
5. reconstruct worker-local state;
6. resume automatically where policy permits;
7. otherwise mark the task `BLOCKED` or `APPROVAL_REQUIRED`.

## 6.5 Idempotency

Tools that can modify external state SHOULD expose or derive idempotency identifiers when possible.

Cabot SHALL avoid automatically replaying a consequential action when it cannot determine whether the previous execution succeeded.

---

# 7. Persistent Storage and OPFS

## 7.1 OPFS Role

The Origin Private File System SHALL be Cabot's primary local persistent workspace.

OPFS SHALL store:

- project files;
- task files;
- task checkpoints;
- databases;
- agent memory;
- downloaded/derived artifacts;
- Skill packages;
- package caches;
- local model data where practical;
- execution scratch data;
- audit logs;
- indexes.

## 7.2 Proposed Layout

```text
/cabot/
  config/
  projects/
    <project-id>/
      project.json
      memory/
      files/
      sources/
      artifacts/
      tasks/
        <task-id>/
          task.json
          checkpoint.json
          events/
          inputs/
          outputs/
          runtime/
  skills/
    installed/
    user/
    generated/
  databases/
  packages/
  models/
  cache/
  logs/
```

## 7.3 Storage Worker

Cabot SHOULD centralize database and critical filesystem writes through a Storage Worker.

This avoids uncontrolled concurrent writes and makes transaction semantics easier to enforce.

The Storage Worker MAY expose an internal RPC interface such as:

```typescript
storage.read(path)
storage.write(path, bytes)
storage.atomicWrite(path, bytes)
storage.list(path)
storage.remove(path)
storage.transaction(...)
db.query(...)
db.execute(...)
```

## 7.4 Databases

Cabot SHOULD use SQLite-WASM or an equivalent embedded browser database for transactional metadata, including:

- Projects
- Tasks
- Events
- Checkpoints
- Permissions
- Approvals
- Skill registry
- MCP registry
- Sources
- Artifact metadata
- Memories

DuckDB-Wasm MAY be used separately for analytical data.

## 7.5 Storage Persistence

Cabot SHOULD request persistent browser storage where supported.

The system SHALL expose storage usage and quota information to the user.

---

# 8. Agent Runtime

## 8.1 Agent Loop

The agent runtime SHALL implement a bounded, checkpointed loop approximately equivalent to:

```text
load durable state
      ↓
observe task + environment
      ↓
select next action
      ↓
policy evaluation
      ↓
execute model/tool/compute step
      ↓
record result
      ↓
checkpoint
      ↓
repeat or suspend
```

The exact reasoning framework SHALL be model-provider independent.

## 8.2 Context Construction

Context MAY include:

- system policy;
- project instructions;
- active Skill instructions;
- current task objective;
- task plan;
- task state;
- relevant project memory;
- relevant source excerpts;
- browser observation;
- available tools;
- tool results;
- recent task events;
- user messages.

Cabot SHOULD minimize context by retrieving only relevant durable information rather than replaying complete project history on every model call.

## 8.3 Model Providers

Cabot SHALL support pluggable model providers.

Possible providers include:

- OpenAI-compatible APIs;
- vendor-specific APIs;
- enterprise gateways;
- locally hosted OpenAI-compatible endpoints;
- WebGPU/browser-local models.

A provider interface SHOULD include:

```typescript
interface ModelProvider {
  listModels(): Promise<ModelDescriptor[]>;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

## 8.4 Model Routing

Cabot MAY route tasks by capability and cost.

Examples:

- small local model for classification;
- remote high-capability model for planning;
- code-specialized model for code generation;
- vision model for screenshots;
- embedding model for retrieval.

Routing SHALL remain separate from tool authorization.

---

# 9. Capability Broker

## 9.1 Purpose

The Capability Broker is Cabot's central authority for privileged actions.

The model SHALL never directly call extension APIs.

Instead:

```text
Model / Skill / Python
        │
        ▼
  Tool Request
        │
        ▼
 Capability Broker
   ├── validate schema
   ├── identify principal
   ├── check task policy
   ├── check project policy
   ├── check domain policy
   ├── classify consequence
   ├── request approval if needed
   ├── audit
   └── dispatch
        │
        ▼
 Browser / MCP / WebMCP / Compute
```

## 9.2 Principal Identity

Every request SHOULD identify its principal, for example:

- core agent;
- delegated agent;
- Skill identifier/version;
- generated Python execution;
- MCP server;
- WebMCP origin;
- user action.

Permissions MAY differ by principal.

## 9.3 Capability Classes

Cabot SHOULD classify capabilities into categories:

### Read-only
Examples:

- inspect active page;
- read selected text;
- query project files;
- query approved MCP resources;
- execute analytical SQL.

### Reversible
Examples:

- open a tab;
- create an internal project file;
- modify a draft artifact;

### External-state mutation
Examples:

- submitting a form;
- posting content;
- modifying a remote record;
- uploading a document;

### Consequential
Examples:

- purchases;
- financial actions;
- sending external communications;
- deleting important remote data;
- publishing externally;
- actions affecting accounts or permissions.

Consequential actions SHALL normally require explicit user confirmation immediately before execution.

## 9.4 Permission Scope

Permissions SHOULD support:

- once;
- for this task;
- for this project;
- for this domain/server;
- persistent allow;
- persistent deny.

---

# 10. Browser Tooling

Cabot SHOULD expose browser interaction through stable tools rather than direct browser API access by the model.

Initial browser tools SHOULD include:

```text
browser.get_active_tab
browser.list_tabs
browser.open_tab
browser.close_tab
browser.navigate
browser.go_back
browser.go_forward
browser.read_page
browser.read_selection
browser.find_text
browser.get_links
browser.get_forms
browser.get_accessibility_tree
browser.click
browser.type
browser.select
browser.submit
browser.scroll
browser.screenshot
browser.download
browser.wait_for
```

Tools SHALL use stable semantic element identifiers where possible rather than exposing raw transient selectors to the model.

Cabot SHOULD log significant browser actions.

---

# 11. WebMCP Integration

## 11.1 Purpose

WebMCP SHALL be treated as Cabot's preferred structured interaction mechanism for cooperating webpages.

As of 2026-09-15, WebMCP is published as a W3C Web Machine Learning Community Group draft, not a W3C Recommendation. Cabot SHALL therefore encapsulate WebMCP behind an adapter to tolerate specification changes.

The current draft exposes a `ModelContext` through:

```javascript
document.modelContext
```

and allows web applications to register structured tools for browser agents.

## 11.2 Discovery

For each eligible page, Cabot SHOULD detect whether WebMCP tools are available.

Discovered tools SHALL be associated with:

- page origin;
- tab/frame identity;
- tool name;
- description;
- input schema;
- annotations;
- lifecycle.

## 11.3 WebMCP Annotations

Cabot SHOULD consume current WebMCP annotations including:

- `readOnlyHint`
- `untrustedContentHint`
- `consequentialHint`

These are advisory signals, not authoritative permission decisions.

Cabot SHALL apply its own policy regardless of annotations supplied by a webpage.

## 11.4 WebMCP Security

Cabot SHALL assume:

- tool descriptions may contain prompt injection;
- tool output may contain prompt injection;
- tool metadata may be misleading;
- an origin may intentionally misclassify a consequential tool;
- cross-origin information can be sensitive.

WebMCP tool metadata and outputs SHALL therefore be marked with origin provenance and processed as untrusted external content.

## 11.5 Preference Over Screen Automation

When a suitable WebMCP tool exists, Cabot SHOULD normally prefer it over visual clicking or brittle DOM automation.

Example:

```text
Website exposes:
  shopping.add_to_cart(productId)

Prefer:
  WebMCP call

Over:
  find button visually → click coordinates
```

---

# 12. MCP Integration

## 12.1 MCP Client

Cabot SHALL include an MCP client capable of connecting to approved MCP servers.

The MCP implementation SHOULD target the current 2026-07-28 MCP specification while maintaining protocol-version negotiation and compatibility adapters where practical.

The 2026-07-28 MCP core is stateless at the protocol layer. Cabot SHALL keep its own durable execution state independently of the transport.

## 12.2 MCP Capabilities

Cabot SHOULD consume relevant MCP primitives and extensions including:

- tools;
- resources;
- prompts where supported and useful;
- authorization;
- the MCP Tasks extension;
- future extension capabilities through adapters.

## 12.3 MCP Tasks

Cabot SHOULD support the `io.modelcontextprotocol/tasks` extension.

When an MCP tool returns an asynchronous task handle, Cabot SHALL persist the handle as part of the local Cabot task checkpoint.

Cabot MAY then resume polling or status retrieval after its own execution context has restarted.

This creates two task layers:

```text
Cabot durable task
       │
       └── external MCP task handle
```

These SHALL not be conflated.

## 12.4 MCP Security

Each MCP server SHALL have a trust record containing at minimum:

- server identity;
- endpoint;
- authorization method;
- approved capabilities;
- user/project scope;
- tool allow/deny policy;
- observed tool schemas;
- last approval/change time.

Changes to a server's tool definitions SHOULD trigger re-evaluation when materially significant.

Cabot SHALL not assume an MCP server is trustworthy merely because it uses MCP.

## 12.5 MCP Transport Boundary

Cabot's internal tool representation SHOULD be protocol-neutral.

MCP tools SHALL be normalized into the same capability registry used by browser tools, WebMCP, Skills, and compute tools.

---

# 13. Skills System

## 13.1 Definition

A Cabot Skill is a portable, inspectable capability package containing instructions and optionally executable assets.

A Skill is more than a prompt.

A Skill MAY contain:

- natural-language instructions;
- typed tool declarations;
- Python source code;
- SQL;
- WebAssembly;
- JavaScript where policy permits;
- JSON schemas;
- templates;
- tests;
- reference documents;
- examples;
- static assets;
- package/dependency declarations.

## 13.2 Skill Layout

Recommended layout:

```text
skills/
  ais-analysis/
    SKILL.md
    skill.yaml

    python/
      parse_ais.py
      detect_anomalies.py
      summarize_tracks.py

    sql/
      hourly_summary.sql

    wasm/
      fast_geo.wasm

    schemas/
      anomaly-report.schema.json

    templates/
      report.md

    references/
      ais-schema.md

    tests/
      test_detect_anomalies.py
      fixtures/
```

## 13.3 SKILL.md

`SKILL.md` SHALL describe:

- purpose;
- when to use the Skill;
- when not to use it;
- expected workflow;
- available entry points;
- assumptions;
- interpretation guidance;
- expected outputs;
- failure/recovery guidance.

## 13.4 skill.yaml

Example:

```yaml
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
    - pyarrow
    - h3

  entrypoints:
    detect_anomalies:
      script: python/detect_anomalies.py
      function: detect_anomalies
      input_schema: schemas/detect-input.schema.json
      output_schema: schemas/anomaly-report.schema.json

permissions:
  network: none
  filesystem:
    read:
      - task://inputs/**
    write:
      - task://outputs/**

risk:
  side_effects: none
```

## 13.5 Skill Python

Skills SHALL be permitted to include Python code.

Python contained in a Skill SHALL NOT receive browser privileges directly.

It SHALL execute through the Cabot Pyodide subsystem and Capability Broker.

Example call exposed to the model:

```text
skill.run(
  skill="ais-analysis",
  entrypoint="detect_anomalies",
  arguments={
    "source": "task://inputs/positions.parquet"
  }
)
```

The model SHOULD NOT need to inject or reinterpret the implementation source on each invocation.

## 13.6 Skill Entry Points as Tools

Skill entry points MAY be registered as typed Cabot tools.

Example:

```text
ais.detect_anomalies
iceberg.inspect_manifest
report.generate_brief
geospatial.h3_candidates
```

The model receives the tool schema, not necessarily the implementation source.

## 13.7 Skill Trust Levels

Cabot SHOULD distinguish at least:

- built-in Skills;
- administrator-approved Skills;
- user-installed Skills;
- locally authored Skills;
- agent-generated Skills;
- untrusted/imported Skills.

Trust affects approval and execution policy, not whether the Skill bypasses sandboxing.

No Skill SHALL bypass the capability boundary solely because it is trusted.

## 13.8 Agent-Generated Skills

Cabot MAY support transforming repeated successful workflows into reusable Skills.

A generated Skill SHOULD pass through:

```text
generate
  ↓
static validation
  ↓
dependency inspection
  ↓
tests
  ↓
sandbox trial
  ↓
user/admin approval
  ↓
installed registry
```

---

# 14. Python / Pyodide Runtime

## 14.1 Role

Pyodide SHALL be the reference implementation for Cabot's Python execution capability.

Pyodide provides CPython compiled for WebAssembly and can run inside browser workers.

Python SHALL be treated as a compute subsystem, not as part of Cabot's trusted extension core.

## 14.2 Worker Isolation

Python SHALL run in dedicated module-type Web Workers.

The agent worker SHALL NOT run arbitrary Python inside its own execution context.

A typical flow is:

```text
Agent Worker
   │
   ▼
python.execute request
   │
   ▼
Capability Broker
   │
   ▼
Pyodide Worker
   │
   ├── sandbox filesystem
   ├── approved packages
   ├── captured stdout/stderr
   └── bounded execution
```

## 14.3 Pyodide Is Not the Security Boundary by Itself

Pyodide Python can interoperate with JavaScript and browser Web APIs. Cabot SHALL therefore not assume that "running in Pyodide" automatically means untrusted code is harmless.

Cabot SHALL constrain the worker environment and exposed bridges.

## 14.4 Python Execution Modes

Cabot SHOULD support:

### Ephemeral Execution

Default for dynamically generated code.

```text
create worker
load runtime
load approved inputs
execute
capture outputs
persist declared artifacts
destroy worker
```

### Task Session

Optional for analytical workloads requiring reusable in-memory state.

A task session MAY preserve:

- imports;
- variables;
- loaded packages;
- cached data.

However, task correctness SHALL NOT depend on the worker surviving indefinitely.

Important data SHALL be materialized to OPFS.

## 14.5 Python Filesystem

Each Python execution SHALL receive a scoped workspace.

Example:

```text
/projects/<project>/tasks/<task>/runtime/python/<execution>/
```

Python SHALL NOT receive unrestricted access to all Cabot files.

Inputs and outputs SHALL be mounted/copied according to declared capability grants.

## 14.6 Network Policy

Default:

```yaml
network: none
```

Python that needs remote content SHOULD normally request Cabot to acquire it through an approved browser, MCP, or fetch capability.

Direct Python networking MAY be enabled through explicit policy.

## 14.7 Packages

Cabot MAY use `pyodide.loadPackage()` and `micropip` for supported packages.

Package installation SHALL be policy-controlled.

Cabot SHOULD support:

- pre-approved package lists;
- package/version pinning;
- package caching;
- integrity metadata;
- administrator-denied packages;
- Skill-declared dependencies;
- offline package bundles.

Unknown dependencies MAY require approval.

## 14.8 Python Tool Interface

Suggested interface:

```typescript
interface PythonExecuteRequest {
  taskId: string;
  code?: string;
  skill?: string;
  entrypoint?: string;
  arguments?: unknown;
  timeoutMs?: number;
  network?: "none" | "approved";
  inputs?: WorkspaceMount[];
  outputs?: string[];
}

interface PythonExecuteResult {
  executionId: string;
  stdout: string;
  stderr: string;
  result?: unknown;
  artifacts: ArtifactDescriptor[];
  packagesUsed: string[];
  durationMs: number;
}
```

## 14.9 Resource Limits

Cabot SHOULD permit policy to set:

- execution timeout;
- worker memory budget where enforceable;
- output size limit;
- filesystem quota;
- package limits;
- concurrency limits.

---

# 15. Additional Compute Engines

## 15.1 DuckDB-Wasm

Cabot SHOULD provide analytical SQL through DuckDB-Wasm or equivalent.

Typical tool:

```text
sql.execute(query, inputs)
```

This SHOULD be preferred over Python for simple filtering, joins, aggregation, Parquet processing, and other relational operations when efficient.

## 15.2 WebAssembly

Skills MAY package WASM modules for deterministic or performance-sensitive computation.

WASM modules SHALL be subject to capability and resource constraints.

## 15.3 JavaScript Sandbox

Cabot MAY offer restricted JavaScript execution.

Generated JavaScript SHALL NOT run in a privileged extension context.

## 15.4 WebGPU

Cabot MAY use WebGPU for:

- local LLM inference;
- embeddings;
- vision models;
- matrix/vector workloads;
- specialized Skill computation.

WebGPU acceleration SHALL remain optional.

---

# 16. Memory and Retrieval

## 16.1 Memory Scopes

Cabot SHOULD distinguish:

- task memory;
- project memory;
- user-configured durable memory;
- transient execution context;
- cached source content.

## 16.2 Project Memory

Project memory SHOULD capture durable facts and decisions relevant to future tasks in that project.

It SHALL NOT be implemented solely as accumulated chat transcripts.

## 16.3 Retrieval

Cabot MAY combine:

- SQLite full-text search;
- embeddings;
- vector indexes;
- structured metadata;
- recency;
- provenance;
- explicit user pinning.

Retrieved content SHALL retain source provenance.

---

# 17. Multi-Agent Runtime and Delegation

Multi-agent operation is a first-class Cabot capability, not an optional orchestration layer.

Cabot SHALL support multiple logical agents existing and progressing concurrently within the same browser runtime. Agents MAY be independent, cooperative, hierarchical, or task-specific. The runtime SHALL NOT require that one agent finish before another can exist or make progress.

A Cabot agent is a durable actor with its own identity, task ownership, state, mailbox, skills, model configuration, budget, capability grants, and workspace view. An agent is not merely a chat session or a transient model invocation.

## 17.1 Agent Identity and State

Each agent SHALL have a stable `AgentId` and SHALL persist at minimum:

- role and objective;
- lifecycle state;
- current task and plan position;
- model/provider configuration;
- assigned Skills;
- capability grants;
- budgets and limits;
- mailbox cursor and pending messages;
- workspace mounts and artifact references;
- parent/child relationships where applicable;
- checkpoint and recovery metadata.

Agent state SHALL be persisted independently enough that failure, cancellation, or corruption of one agent does not require discarding unrelated agents.

Suggested lifecycle states include:

```text
CREATED
READY
RUNNING
WAITING_FOR_MODEL
WAITING_FOR_TOOL
WAITING_FOR_AGENT
WAITING_FOR_USER
PAUSED
COMPLETED
FAILED
CANCELLED
```

## 17.2 Independent Agents

Cabot SHALL permit multiple unrelated agents to operate at the same time. For example:

```text
Cabot Runtime
  ├── Agent A — research Canadian-hosted models
  ├── Agent B — analyze AIS data
  ├── Agent C — monitor a permitted website
  └── Agent D — prepare project documentation
```

Each independent agent SHALL retain separate task state, budgets, permissions, and working context even when the agents share a project.

## 17.3 Cooperating Agents

Cabot SHALL support cooperating agent topologies, including coordinator/worker arrangements.

Example:

```text
Coordinator Agent
  ├── Research Agent
  ├── Analysis Agent
  ├── Verification Agent
  └── Writer Agent
```

A coordinating agent MAY decompose a goal into independently durable child tasks, assign those tasks to existing agents, or request creation of bounded child agents.

A child or delegated agent SHALL inherit only explicitly delegated:

- objective;
- context;
- files or workspace mounts;
- Skills;
- tools;
- model/provider selection;
- token, compute, time, and tool budgets;
- permissions;
- deadlines.

Subagents SHALL NOT automatically inherit all parent permissions, credentials, workspace visibility, model access, or budget. Delegation SHALL never increase authority unless the Capability Broker independently authorizes that increase.

## 17.4 Agent Creation and `agent.spawn`

Cabot SHALL expose controlled agent-management capabilities to authorized agents and user interfaces. At minimum:

```text
agent.spawn
agent.status
agent.message
agent.await
agent.pause
agent.resume
agent.cancel
```

A representative spawn request is:

```typescript
agent.spawn({
  role: "researcher",
  goal: "Determine current WebMCP support",
  skills: ["web-research", "technical-analysis"],
  budget: {
    maxModelCalls: 20,
    maxRuntimeMinutes: 30
  }
})
```

`agent.spawn` SHALL itself be a brokered capability. Cabot SHALL enforce configurable limits on:

- recursive delegation depth;
- number of agents per task;
- number of agents per project;
- number of concurrently runnable agents;
- model-call concurrency;
- compute concurrency;
- browser-interaction concurrency;
- aggregate cost/token budgets.

These limits SHALL prevent uncontrolled recursive spawning and browser resource exhaustion.

## 17.5 Agent Communication

Agents SHALL communicate through durable messages rather than direct mutation of another agent's internal state.

A conceptual message envelope is:

```typescript
interface AgentMessage {
  id: MessageId;
  from: AgentId;
  to: AgentId;
  type: "request" | "result" | "event" | "artifact" | "cancel";
  payload: unknown;
  createdAt: string;
}
```

Messages SHALL be persisted before delivery acknowledgment so that they can survive worker termination or browser restart. Delivery SHOULD be at-least-once with message IDs or equivalent deduplication semantics.

Agents SHALL NOT rely on another agent's in-memory context as the only copy of information needed for task completion.

## 17.6 Shared Artifacts and Project Exchange

Large intermediate results SHALL be exchanged by reference rather than copied through model context or inter-agent messages.

Example:

```text
Analysis Agent
      │
      ├── writes project://shared/results.parquet
      │
      └── sends artifact reference to Reviewer Agent
```

Cabot SHALL support project-level shared artifact spaces in addition to private agent/task workspaces. Access to shared artifacts SHALL remain capability-controlled.

Agents SHOULD exchange:

- artifact URIs;
- structured summaries;
- provenance;
- schemas;
- validation results;

rather than embedding unnecessarily large payloads in agent messages.

## 17.7 Scheduler and Concurrency

Cabot SHALL distinguish logical agent concurrency from physical execution concurrency. Many agents MAY be defined or waiting while only a bounded number actively consume browser resources.

The scheduler SHALL manage independently constrained execution classes such as:

```text
20 logical agents
  ├── 6 runnable
  ├── 3 active model turns
  ├── 1 Pyodide execution
  └── 2 concurrent browser actions
```

Waiting agents SHALL release unnecessary workers and SHALL be reconstructed from durable state when they become runnable.

Scheduling policy MAY consider:

- user priority;
- dependency readiness;
- fairness;
- resource class;
- model/provider limits;
- project budgets;
- deadlines;
- user interaction latency.

## 17.8 Multi-Agent Skills and Models

Skills and model providers SHALL be assignable per agent. Different agents in the same project MAY use different:

- Skills;
- models;
- model providers;
- tool sets;
- Python package allowances;
- MCP servers;
- WebMCP policies;
- browser permissions;
- cost and runtime budgets.

This SHALL permit role specialization without granting every agent the union of all capabilities used by the project.

## 17.9 Multi-Agent Recovery

Delegated tasks and agent mailboxes SHALL be durable and independently checkpointable.

After extension reload, browser restart, or worker termination, Cabot SHALL be able to reconstruct:

1. all non-terminal agents;
2. their lifecycle states;
3. parent/child relationships;
4. pending inter-agent messages;
5. unresolved tool/model operations where recoverable;
6. shared artifact references;
7. outstanding approvals; and
8. runnable dependencies.

Recovery SHALL NOT assume that the same JavaScript worker, Pyodide worker, model session, or tab still exists.

## 17.10 Multi-Agent Security Invariants

Multiple agents SHALL NOT weaken Cabot's capability model. Specifically:

- agents SHALL NOT directly grant capabilities to other agents;
- child agents SHALL NOT automatically inherit parent authority;
- an agent SHALL NOT directly mutate another agent's durable state;
- shared storage SHALL be accessed through explicit workspace grants;
- agent messages SHALL be treated as untrusted input by the receiving agent;
- the Capability Broker SHALL remain authoritative for browser actions regardless of which agent requested them;
- an agent SHALL NOT use delegation to bypass approval requirements, budgets, origin policies, or tool restrictions;
- cancellation of a parent MAY cascade to descendants according to policy, but SHALL NOT affect unrelated agents.

---

# 18. User Interface

## 18.1 Side Panel

The browser side panel SHALL be the primary interactive UI.

It SHOULD include:

- conversation/command input;
- current task state;
- current plan;
- activity stream;
- artifacts;
- sources;
- pause/resume/stop controls;
- permission requests;
- task switching;
- agent switching and agent hierarchy inspection;
- per-agent state, skills, model, budget, and permission inspection.

## 18.2 Task Dashboard

Users SHALL be able to inspect:

- running tasks;
- queued tasks;
- blocked tasks;
- suspended tasks;
- failed tasks;
- completed tasks;
- delegated subtasks;
- external MCP tasks.

## 18.3 Project Workspace

Projects SHOULD appear as durable workspaces rather than chat folders.

Example:

```text
Projects
├── AIS Warehouse
│   ├── Tasks
│   ├── Files
│   ├── Sources
│   ├── Artifacts
│   ├── Skills
│   └── Memory
└── CANChat
```

## 18.4 Workspace Explorer

The user SHOULD be able to inspect the agent's OPFS workspace through a safe virtual file explorer.

## 18.5 Approval Inbox

Cabot SHALL present clear approval requests for operations that require consent.

Approval UI SHOULD show:

- requested action;
- requesting task;
- requesting Skill/tool/server;
- target website/system;
- data being transmitted where practical;
- consequence classification;
- requested permission duration.

## 18.6 Command Palette

Cabot SHOULD support a keyboard-first command palette.

Examples:

```text
> research WebMCP security
> continue AIS index task
> show blocked agents
> summarize current page
> add page to project CANChat
```

## 18.7 Context Menu

Page selection/right-click actions MAY include:

- Ask Cabot
- Explain selection
- Research this
- Add to project
- Add as source
- Create task
- Extract table
- Monitor page

---

# 19. Programmatic Internal API

Cabot SHALL expose a stable internal API between UI components and the runtime.

Example:

```typescript
interface CabotRuntime {
  createProject(request: CreateProjectRequest): Promise<ProjectId>;
  createTask(request: TaskRequest): Promise<TaskId>;
  sendMessage(taskId: TaskId, message: string): Promise<void>;

  pauseTask(taskId: TaskId): Promise<void>;
  resumeTask(taskId: TaskId): Promise<void>;
  cancelTask(taskId: TaskId): Promise<void>;

  inspectTask(taskId: TaskId): Promise<TaskState>;
  listTasks(filter?: TaskFilter): Promise<TaskSummary[]>;

  spawnAgent(request: AgentSpawnRequest): Promise<AgentId>;
  inspectAgent(agentId: AgentId): Promise<AgentState>;
  listAgents(filter?: AgentFilter): Promise<AgentSummary[]>;
  sendAgentMessage(agentId: AgentId, message: AgentMessageInput): Promise<void>;
  pauseAgent(agentId: AgentId): Promise<void>;
  resumeAgent(agentId: AgentId): Promise<void>;
  cancelAgent(agentId: AgentId): Promise<void>;

  readArtifact(id: ArtifactId): Promise<Artifact>;
  subscribe(filter: EventFilter): AsyncIterable<CabotEvent>;
}
```

The side panel SHALL consume this API rather than containing agent logic itself.

---

# 20. Tool Registry

Cabot SHALL normalize tools from different sources into a common representation.

Tool sources include:

- built-in browser tools;
- Cabot compute tools;
- Skill entry points;
- MCP tools;
- WebMCP tools;
- enterprise connectors;
- future plugin systems.

Suggested representation:

```typescript
interface CabotTool {
  id: string;
  source: "builtin" | "skill" | "mcp" | "webmcp" | "compute";
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  provenance: ToolProvenance;
  annotations: ToolAnnotations;
  policy: ToolPolicy;
}
```

The registry SHALL maintain provenance so similarly named tools cannot masquerade as one another.

---

# 21. Security Model

## 21.1 Trust Zones

Cabot SHALL distinguish at minimum:

```text
Trusted extension core
        │
        ▼
Capability Broker
        │
 ┌──────┼───────────┬────────────┐
 ▼      ▼           ▼            ▼
Agent  Skills     Pyodide      MCP/WebMCP
              untrusted/bounded domains
```

## 21.2 Prompt Injection

Cabot SHALL treat prompt injection as an architectural threat rather than solely a model-alignment problem.

Controls SHOULD include:

- source provenance;
- trusted/untrusted content labels;
- strict separation of instructions from retrieved data;
- action authorization outside the LLM;
- consequence classification;
- domain-scoped capabilities;
- explicit approval for high-risk actions;
- blocking arbitrary privilege escalation from webpage content;
- limiting cross-site data movement.

## 21.3 Cross-Site Data Leakage

Cabot SHALL prevent a tool on one origin from implicitly gaining access to unrelated project/browser data.

Sending information from one trust domain to another SHOULD be an auditable capability decision.

## 21.4 Secrets

Secrets SHALL NOT be written into model prompts unless required and explicitly authorized.

Cabot SHOULD prefer browser-managed authentication or token indirection over exposing raw credentials to the model.

## 21.5 Remote Code

Manifest V3 restrictions on remotely hosted extension code SHALL be respected.

Cabot SHALL distinguish between:

- executable extension code;
- model-generated code executed in a sandbox;
- Skill assets;
- data downloaded from remote sources.

Remote data SHALL NOT be executed in privileged extension contexts.

## 21.6 Audit

Cabot SHOULD log security-relevant actions including:

- permission grants;
- permission denials;
- website actions;
- MCP connections;
- tool schema changes;
- external writes;
- package installation;
- generated code execution;
- Skill installation/update;
- approval decisions.

---

# 22. Networking

Network access SHALL be capability-driven.

Potential network actors:

- model provider;
- browser fetch tools;
- MCP client;
- WebMCP page tools;
- Skill code;
- Pyodide;
- WASM modules.

The default policy SHOULD be:

```text
Agent-generated compute: no direct network
Browser tools: approved origins/capabilities
MCP: configured servers only
WebMCP: current page/origin policy
Model providers: configured endpoints only
```

---

# 23. Scheduling and Long-Running Work

Cabot MAY use browser alarms and browser events to resume eligible tasks while the browser is running.

Scheduled work SHALL be represented in durable storage rather than relying on in-memory timers.

Cabot SHALL clearly state that browser-only execution cannot continue while the browser and device are fully shut down.

External MCP tasks or cloud services MAY continue independently if their own service supports asynchronous execution. Cabot can reconcile them when it resumes.

---

# 24. Task Budgets and Runaway Protection

Each task SHOULD support configurable limits including:

- maximum model calls;
- maximum token budget;
- maximum monetary budget;
- maximum wall-clock duration;
- maximum tool calls;
- maximum delegated tasks;
- maximum browser navigations;
- maximum compute runtime;
- storage quota;
- external-write count.

Cabot SHOULD suspend rather than silently exceed configured limits.

---

# 25. Observability

The UI SHALL expose concise operational summaries such as:

```text
Searching Apache Iceberg documentation
Reading 4 sources
Running Python analysis
Waiting for MCP task task_731
Needs approval to submit form on example.com
Writing report.md
```

Cabot SHALL NOT require or expose hidden chain-of-thought to provide observability.

The runtime SHOULD provide structured metrics including:

- task runtime;
- model latency;
- tool latency;
- tool error rates;
- retries;
- tokens;
- estimated cost;
- worker restarts;
- checkpoint latency;
- storage use.

---

# 26. Failure Handling

Cabot SHALL define recovery behavior for:

- service-worker termination;
- offscreen-document termination;
- worker crash;
- browser restart;
- network loss;
- model timeout;
- MCP timeout;
- WebMCP tool disappearance;
- page navigation;
- stale DOM targets;
- Pyodide crash;
- package-installation failure;
- storage quota exhaustion;
- schema mismatch;
- non-idempotent tool ambiguity.

Failures SHALL be persisted with enough diagnostic context to support user inspection and retry.

---

# 27. Testing Requirements

## 27.1 Unit Tests

Required areas SHOULD include:

- task state transitions;
- checkpoint serialization;
- permission resolution;
- tool schema validation;
- Skill parsing;
- MCP adapters;
- WebMCP adapters;
- Python execution bridge;
- storage transactions.

## 27.2 Recovery Tests

Cabot SHALL be explicitly tested by terminating execution contexts during active work.

Test cases SHALL include:

- terminate service worker before/after tool call;
- terminate offscreen document;
- terminate agent worker;
- terminate Pyodide worker;
- close and reopen browser;
- lose network mid-MCP task;
- navigate page mid-WebMCP action;
- duplicate recovery event.

A successful recovery test means Cabot either resumes safely or explicitly reports uncertainty; it SHALL NOT silently duplicate consequential actions.

## 27.3 Security Tests

Test suites SHOULD include:

- webpage prompt injection;
- malicious WebMCP tool descriptions;
- malicious WebMCP outputs;
- malicious MCP outputs;
- misleading tool annotations;
- Skill attempting undeclared file access;
- Python attempting undeclared network access;
- Python attempting to reach privileged extension APIs;
- cross-origin data exfiltration attempts;
- package dependency attacks;
- duplicate/replayed consequential operations.

## 27.4 Skill Tests

Skills SHOULD be able to include their own tests and fixtures.

Cabot developer mode SHOULD permit running those tests inside the same sandboxed environment used in production.

---

# 28. Proposed Implementation Phases

## Phase 1 — Durable Core

Deliver:

- MV3 extension shell;
- side panel;
- OPFS abstraction;
- SQLite metadata database;
- task state machine;
- checkpoint/event journal;
- service-worker supervisor;
- offscreen runtime;
- Agent Worker;
- one remote model provider;
- basic read-only browser tools.

Exit criterion:

> A task survives worker termination and browser restart and continues from the last safe checkpoint.

## Phase 2 — Capability Broker and Browser Agent

Deliver:

- formal tool registry;
- capability policies;
- site permissions;
- approval UI;
- navigation/click/type tools;
- semantic page representation;
- artifact workspace;
- task dashboard.

Exit criterion:

> Cabot can safely perform a multi-page research task and generate persistent artifacts.

## Phase 3 — Compute Runtime

Deliver:

- Pyodide workers;
- `python.execute`;
- package policy;
- scoped Python workspaces;
- DuckDB-Wasm;
- SQL tool;
- execution artifacts;
- compute budgets.

Exit criterion:

> Cabot can acquire a dataset, analyze it in Python/SQL, recover from interruption, and produce an artifact without host execution.

## Phase 4 — Skills

Deliver:

- Skill package format;
- `SKILL.md`;
- `skill.yaml`;
- Python entry points;
- SQL/WASM assets;
- schemas;
- Skill registry;
- Skill tests;
- trust levels.

Exit criterion:

> A Skill containing tested Python can be installed, authorized, invoked as a typed tool, and executed entirely in the browser sandbox.

## Phase 5 — MCP

Deliver:

- MCP client;
- authorization support;
- tool/resource discovery;
- capability normalization;
- MCP Tasks extension support;
- durable external-task handles;
- server policy registry.

Exit criterion:

> Cabot can initiate an asynchronous MCP tool call, restart, recover the task handle, and collect the final result safely.

## Phase 6 — WebMCP

Deliver:

- WebMCP detection;
- tool discovery;
- tool execution;
- provenance;
- annotation handling;
- preference over brittle DOM automation;
- prompt-injection defenses.

Exit criterion:

> Cabot can use structured WebMCP tools on a cooperating website while preserving Cabot's own permission model.

## Phase 7 — Multi-Agent and Local Models

Deliver:

- multiple concurrent durable agents;
- independent and cooperating agent topologies;
- coordinator/worker delegation;
- `agent.spawn`, `agent.message`, `agent.await`, and lifecycle controls;
- durable per-agent mailboxes;
- per-agent skills, models, budgets, workspaces, and capability restrictions;
- scheduler-enforced concurrency limits;
- resumable parent/child agent relationships;
- shared artifacts passed by durable reference;
- local embeddings;
- WebGPU model providers;
- model routing;
- advanced memory and retrieval.

Exit criterion:

> Cabot can run at least two independently progressing agents plus a coordinator/worker delegation flow, interrupt the browser runtime, recover all non-terminal agents and pending messages from OPFS, and continue without broadening any agent's permissions.

---

# 29. Minimum Viable Product Acceptance Criteria

The initial useful Cabot release SHALL demonstrate all of the following:

1. User creates a Project.
2. User gives Cabot a multi-step research task.
3. Cabot navigates multiple websites with explicit host permissions.
4. Cabot records source provenance.
5. Cabot writes files to an OPFS-backed workspace.
6. Cabot executes Python in Pyodide to analyze gathered data.
7. Browser/worker execution is intentionally interrupted.
8. Cabot resumes from durable state without starting over.
9. Cabot can load and execute a Skill containing Python code.
10. Cabot can connect to at least one MCP server.
11. Cabot can discover and invoke a WebMCP tool where browser support is available.
12. A consequential browser action is blocked pending user approval.
13. The user can inspect task state, actions, sources, artifacts, and permissions.
14. Cabot can run at least two logical agents concurrently with separate state, budgets, permissions, and workspaces.
15. An authorized agent can delegate a bounded subtask through `agent.spawn`.
16. Inter-agent messages and shared artifact references survive an intentional runtime interruption.
17. A child agent cannot inherit or acquire a capability that was not explicitly delegated and authorized.
18. No model or sandboxed program is given direct unrestricted extension API access.

---

# 30. Example End-to-End Workflow

User:

> Research browser-resident analytical databases, benchmark three approaches against this dataset, and write a recommendation in the project.

Cabot:

```text
1. Creates durable task
2. Builds initial plan
3. Searches/browses sources
4. Stores source material and provenance
5. Detects WebMCP tools when available
6. Uses MCP research tools if configured
7. Downloads approved dataset into task workspace
8. Loads data into DuckDB-Wasm
9. Invokes Python Skill for benchmark harness
10. Stores benchmark results in OPFS
11. Checkpoints after each stage
12. Browser worker is terminated
13. Supervisor restarts runtime
14. Task is reconstructed from checkpoint
15. Cabot verifies benchmark outputs
16. Writes report.md
17. Presents artifacts and source trail
18. Marks task complete
```

At no stage does generated code gain unrestricted host access.

---

# 31. Reference Security Invariant

A conforming Cabot implementation SHOULD be able to state:

> A malicious webpage, malicious document, malicious MCP server, malicious WebMCP tool, compromised Skill, or mistaken model can attempt to persuade Cabot to perform an action, but it cannot acquire capabilities that the Cabot runtime has not granted through policy and the Capability Broker.

This is the architectural objective. Model behavior is one defensive layer; it is not the authorization system.

---

# 32. Technology Baseline and External Specifications

Cabot's implementation SHALL isolate fast-changing external standards behind adapters.

Current baseline as of 2026-09-16:

- **Chromium Manifest V3 Offscreen API** — supports offscreen documents; `WORKERS` is a defined reason for spawning workers. Non-audio reasons do not themselves impose a fixed lifetime limit, but Cabot still assumes termination is possible.  
  https://developer.chrome.com/docs/extensions/reference/api/offscreen

- **Chromium Extension Service Worker lifecycle** — service workers are event-driven and can be terminated; persistent state should not rely on global variables.  
  https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

- **OPFS / File System API** — browser-private persistent filesystem. Workers can use `FileSystemSyncAccessHandle` for synchronous file operations.  
  https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system

- **Pyodide** — CPython compiled to WebAssembly for browsers/Node.js; supports JavaScript/Python interop and a broad package ecosystem.  
  https://pyodide.org/en/stable/

- **Pyodide Web Workers** — Pyodide supports running in module-type Web Workers so synchronous Python computation does not block the UI thread.  
  https://pyodide.org/en/stable/usage/webworker.html

- **Pyodide package loading / micropip** — supports Pyodide packages plus pure-Python wheels and compatible wasm/emscripten wheels.  
  https://pyodide.org/en/stable/usage/loading-packages.html

- **MCP 2026-07-28** — current release uses a stateless protocol core and an extension framework.  
  https://blog.modelcontextprotocol.io/posts/2026-07-28/

- **MCP Tasks extension** — durable server-side task handles for asynchronous tool operations through `tasks/get`, `tasks/update`, and `tasks/cancel`.  
  https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks

- **WebMCP** — W3C Web Machine Learning Community Group draft enabling webpages to expose JavaScript-based tools to browser agents through `document.modelContext`. Current annotations include `readOnlyHint`, `untrustedContentHint`, and `consequentialHint`.  
  https://webmachinelearning.github.io/webmcp/

Because MCP, WebMCP, browser APIs, and local browser AI capabilities are evolving, protocol-specific implementation code SHALL remain behind versioned adapters.

---

# 33. Summary

Cabot is a browser-native agent workbench with four defining characteristics:

1. **Autonomous and multi-agent** — it can plan, use tools, write and execute code, run multiple independent or cooperating agents, delegate bounded work, and perform long multi-step tasks.
2. **Durable** — every significant operation is checkpointed so tasks can recover after browser execution contexts disappear.
3. **Extensible** — Skills, Python, SQL, WASM, MCP, WebMCP, model providers, and browser tools all plug into a common tool/capability architecture.
4. **Contained** — the browser sandbox and Capability Broker remain authoritative; neither the model nor executable Skill code receives ambient extension or host privileges.

The intended result is a system with much of the practical power of a general-purpose autonomous agent harness, but whose default execution boundary is the browser rather than the host operating system.
