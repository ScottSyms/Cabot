# ADR-001 — Compute isolation boundary

Status: accepted (prototype required before Phase 4).

Decision: Pyodide/WASM execute only inside a sandboxed, separate-origin
(or opaque-origin) context hosting compute workers. No direct access to
OPFS, credentials, privileged extension APIs, or unrestricted network.
All inputs/outputs transfer through a narrow message interface validated
by the Capability Broker.

Rationale: a dedicated Worker on the extension origin is execution
separation, not a security boundary — especially with Pyodide JS interop.

Validation: adversarial Python attempting undeclared file/network access
and JS-bridge escape must fail while useful computation succeeds.
Timeout enforced by terminating the execution context.
