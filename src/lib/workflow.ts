import type { FieldMetaMap, FormValue } from './fields';
import type { PendingLink } from './links';
import type { McpPolicy } from './mcpTypes';

export interface CreateCompleteInput {
  requestId: string; projectKey: string; typeName: string; policyId: string;
  values: Record<string, FormValue>; parentKey?: string; links: PendingLink[];
  files: { name: string; size: number }[];
}
export interface WorkflowOperation {
  id: string; requestId: string; state: 'running' | 'awaiting_attachments' | 'blocked' | 'completed';
  issueKey?: string; status?: string; summary: string; projectKey: string; typeName: string; targetStatus: string;
  files: { name: string; size: number }[];
  error?: { code: string; message: string; fields?: FieldMetaMap; values?: Record<string, FormValue> };
  steps: { key: string; state: string }[];
}
export function completionRoute(p: McpPolicy): string {
  const destinations = new Set(p.steps.map(s => s.to));
  const start = p.steps.find(s => !destinations.has(s.from)) ?? p.steps[0];
  const route: string[] = []; const seen = new Set<string>(); let status: string | undefined = start?.from;
  while (status && !seen.has(status)) {
    route.push(status); seen.add(status);
    if (status === p.targetStatus) break;
    status = p.steps.find(s => s.from === status)?.to;
  }
  return route.join(' → ');
}
