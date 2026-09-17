// Shared DOM helpers for the panel and workspace surfaces.
export interface PanelClient {
  send<T>(msg: unknown): Promise<T>;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  ownerAgentId: string;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, text?: string, attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Reject empty or error responses so UI code never destructures null. */
export async function checked<T>(p: Promise<T>): Promise<Exclude<T, null | undefined>> {
  const res = await p;
  if (!res || typeof res !== 'object' || 'error' in (res as Record<string, unknown>)) {
    throw new Error((res as { error?: string } | null)?.error ?? 'runtime returned an empty response');
  }
  return res as Exclude<T, null | undefined>;
}

/** Status badge class shared by every surface. */
export function statusClass(status: string): string {
  return `status status-${status}`;
}

/** Dot color group for agent rail rows. */
export function statusGroup(status: string): 'active' | 'waiting' | 'paused' | 'done' | 'bad' {
  if (['RUNNING', 'READY', 'WAITING_FOR_MODEL', 'WAITING_FOR_TOOL', 'WAITING_FOR_AGENT', 'CREATED'].includes(status)) return 'active';
  if (status === 'WAITING_FOR_USER') return 'waiting';
  if (['PAUSED', 'SUSPENDED', 'BLOCKED', 'INTERRUPTED'].includes(status)) return 'paused';
  if (['COMPLETED', 'COMPLETE'].includes(status)) return 'done';
  return 'bad';
}

export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 14)}…` : id;
}
