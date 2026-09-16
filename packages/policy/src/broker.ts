// Capability Broker: model may request capabilities, never receives ambient authority.
// Principal is derived from trusted channel bindings (passed explicitly by the
// supervisor), never from an agent-supplied `agentId` field in the payload.
import type {
  AgentId,
  Approval,
  BudgetReservation,
  CabotTool,
  CapabilityClass,
  CapabilityGrant,
  GrantScope,
  Principal,
  TaskId,
} from '@cabot/contracts';
import { DurableStore, newId, nowIso } from '@cabot/storage';

export interface ToolRequest {
  toolId: string;
  args: unknown;
  argsHash: string;
  /** Bound by the supervisor from the authenticated message channel. */
  principal: Principal;
  taskId: TaskId;
  agentId: AgentId;
  destination?: string;
  dataHash?: string;
  documentId?: string;
}

export interface BrokerDecision {
  allowed: boolean;
  approvalRequired?: boolean;
  approvalId?: string;
  reason: string;
}

const CONSEQUENTIAL: CapabilityClass = 'consequential';

export class CapabilityBroker {
  tools = new Map<string, CabotTool>();

  constructor(private store: DurableStore) {}

  registerTool(tool: CabotTool): void {
    this.tools.set(tool.id, tool);
  }

  /** Spawn is itself a brokered capability with explicit delegation (no inheritance). */
  authorizeSpawn(parentAgentId: AgentId, childSpec: { skills: string[]; budget: Record<string, number> }): { allowed: boolean; reason: string } {
    const parent = this.store.agents.get(parentAgentId);
    if (!parent) return { allowed: false, reason: 'unknown parent agent' };
    // Delegation depth guard
    if (parent.delegationDepth >= 5) return { allowed: false, reason: 'max delegation depth exceeded' };
    try {
      this.store.reserve({ taskId: parent.projectId as unknown as TaskId, agentId: parentAgentId, kind: 'delegations', amount: 1 } as BudgetReservation);
    } catch {
      return { allowed: false, reason: 'delegation budget exhausted' };
    }
    // Child receives ONLY explicitly delegated skills/budget — enforced by caller
    // using childSpec rather than copying parent grants.
    void childSpec;
    return { allowed: true, reason: 'spawn authorized with bounded delegation' };
  }

  evaluate(req: ToolRequest): BrokerDecision {
    const tool = this.tools.get(req.toolId);
    if (!tool) return { allowed: false, reason: `unknown tool ${req.toolId}` };

    // 1. Validate principal binding: channel principal agent must match claimed agent.
    if (req.principal.agentId && req.principal.agentId !== req.agentId) {
      return { allowed: false, reason: 'principal mismatch: channel binding does not match claimed agent' };
    }
    // Agents cannot act for other agents.
    if (req.principal.kind === 'delegated-agent' || req.principal.kind === 'core-agent') {
      if (!req.principal.agentId) return { allowed: false, reason: 'agent principal missing agentId' };
    }

    // 2. Persistent deny wins.
    for (const g of this.store.grants.values()) {
      if (g.revoked) continue;
      if (g.toolId === req.toolId && g.scope === 'persistent-deny' && this.principalMatches(g.principal, req.principal)) {
        return { allowed: false, reason: 'persistent deny' };
      }
    }

    // 3. Check grants: once | task | project | domain-server | persistent-allow.
    const grant = this.findGrant(req);
    const isConsequential = tool.capabilityClass === CONSEQUENTIAL;

    if (isConsequential) {
      // Least privilege first: without a grant there is nothing to approve.
      // With a grant, the grant narrows scope but the approval authorizes
      // the concrete action.
      if (!grant) {
        return { allowed: false, reason: `no grant for ${req.toolId}` };
      }
      const approvalId = newId('appr');
      const approval: Approval = {
        id: approvalId,
        taskId: req.taskId,
        agentId: req.agentId,
        toolId: req.toolId,
        argsHash: req.argsHash,
        dataHash: req.dataHash,
        destination: req.destination ?? req.principal.origin,
        documentId: req.documentId,
        capabilityClass: tool.capabilityClass,
        scope: 'once',
        createdAt: nowIso(),
      };
      this.store.approvals.set(approvalId, approval);
      this.store.appendEvent(req.taskId, 'approval.requested', `${req.toolId} requires approval`);
      return { allowed: false, approvalRequired: true, approvalId, reason: 'consequential action requires explicit approval' };
    }

    if (!grant) {
      return { allowed: false, reason: `no grant for ${req.toolId}` };
    }
    return { allowed: true, reason: `granted via ${grant.scope}` };
  }

  /** Decide an approval; execution must recheck binding before dispatch. */
  decideApproval(approvalId: string, decision: 'granted' | 'denied'): Approval {
    const a = this.store.approvals.get(approvalId);
    if (!a) throw new Error(`unknown approval ${approvalId}`);
    a.decision = decision;
    a.decidedAt = nowIso();
    this.store.appendEvent(a.taskId, decision === 'granted' ? 'approval.granted' : 'approval.denied', `${a.toolId} ${decision}`);
    return a;
  }

  /** Must be called immediately before dispatch: re-validates grant + approval binding. */
  authorizeDispatch(req: ToolRequest, approvalId?: string): { allowed: boolean; reason: string } {
    const tool = this.tools.get(req.toolId);
    if (!tool) return { allowed: false, reason: 'unknown tool' };
    if (tool.capabilityClass === CONSEQUENTIAL) {
      if (!approvalId) return { allowed: false, reason: 'consequential dispatch requires approval' };
      const a = this.store.approvals.get(approvalId);
      if (!a || a.decision !== 'granted') return { allowed: false, reason: 'approval not granted' };
      // Bind approval to concrete action: any change invalidates.
      if (a.taskId !== req.taskId || a.agentId !== req.agentId || a.toolId !== req.toolId || a.argsHash !== req.argsHash) {
        return { allowed: false, reason: 'approval binding mismatch — arguments changed after approval' };
      }
      if (a.dataHash !== req.dataHash || a.destination !== (req.destination ?? req.principal.origin) || a.documentId !== req.documentId) {
        return { allowed: false, reason: 'approval binding mismatch — target changed after approval' };
      }
      // Grant may have been revoked between approval and dispatch.
      if (!this.findGrant(req)) {
        return { allowed: false, reason: 'grant revoked after approval' };
      }
      return { allowed: true, reason: 'approval-bound dispatch authorized' };
    }
    return this.evaluate(req).allowed ? { allowed: true, reason: 'dispatch authorized' } : { allowed: false, reason: 'no grant at dispatch' };
  }

  grant(g: Omit<CapabilityGrant, 'id' | 'revoked'>): CapabilityGrant {
    const full: CapabilityGrant = { ...g, id: newId('grant') };
    this.store.grants.set(full.id, full);
    return full;
  }

  revoke(grantId: string): void {
    const g = this.store.grants.get(grantId);
    if (g) g.revoked = true;
  }

  private principalMatches(a: Principal, b: Principal): boolean {
    if (a.kind !== b.kind) return false;
    if (a.agentId && b.agentId) return a.agentId === b.agentId;
    return true;
  }

  private findGrant(req: ToolRequest): CapabilityGrant | undefined {
    for (const g of this.store.grants.values()) {
      if (g.revoked || g.toolId !== req.toolId) continue;
      if (!this.principalMatches(g.principal, req.principal)) continue;
      switch (g.scope) {
        case 'once':
        case 'task':
          if (g.taskId === req.taskId) return g;
          break;
        case 'project': {
          const task = this.store.tasks.get(req.taskId);
          if (task && g.projectId === task.projectId) return g;
          break;
        }
        case 'domain-server':
          if (g.origin && (g.origin === req.principal.origin || g.origin === req.destination)) return g;
          break;
        case 'persistent-allow':
          return g;
        case 'persistent-deny':
          break;
      }
    }
    return undefined;
  }
}
