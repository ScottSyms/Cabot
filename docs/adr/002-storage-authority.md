# ADR-002 — SQLite authoritative, OPFS files by content hash

Status: accepted.

- SQLite-WASM (owned by Storage Worker) is the authoritative metadata store.
- All multi-record mutations commit atomically (task + event + checkpoint
  + operation/message + budget reservation).
- OPFS holds immutable artifact blobs; publication is staged -> verify
  (bytes + sha256) -> commit metadata -> reconcile orphans.
- OPFS file writes + DB updates are never assumed to be one transaction.
