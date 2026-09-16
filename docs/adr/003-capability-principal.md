# ADR-003 — Authenticated capability requests

Status: accepted.

- Principal is derived from trusted message-channel bindings, never from an
  agent-supplied `agentId` field.
- Approvals bind principal + task + tool id/version + args hash + data hash +
  destination + document id + expiry + scope. Any change invalidates.
- Authorization is rechecked immediately before dispatch.
- `agent.spawn` is brokered; children inherit only explicitly delegated
  objective/context/mounts/skills/tools/budgets/permissions/deadlines.
- Tool annotations (`readOnlyHint`, `consequentialHint`) are advisory only.
