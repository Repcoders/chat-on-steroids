import { z } from 'zod';
import { REASONING_EFFORTS, type ReasoningEffort } from './session.js';

/**
 * A named worker setup saved in Settings → Agents & automation, for example "Reviewer" on one
 * model at High. `agents action=spawn` selects one with `workers[].role`; an empty model or
 * reasoning leaves that half to the saved sub-agent default.
 */
export interface WorkerRole {
  name: string;
  model: string;
  reasoning: ReasoningEffort | '';
}

export const MAX_WORKER_ROLES = 8;
export const MAX_WORKER_ROLE_NAME_CHARS = 40;

const roleKey = (name: string): string => name.trim().toLowerCase();

/** Names are matched trimmed and case-insensitively, so two rows may not share one. */
export const workerRolesSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(MAX_WORKER_ROLE_NAME_CHARS),
      model: z.string().trim().max(80),
      reasoning: z.enum(['', ...REASONING_EFFORTS])
    }).strict()
  )
  .max(MAX_WORKER_ROLES)
  .refine((roles) => new Set(roles.map((role) => roleKey(role.name))).size === roles.length, 'Worker role names must be unique');

export function findWorkerRole(roles: readonly WorkerRole[] | undefined, name: string): WorkerRole | undefined {
  const key = roleKey(name);
  return key ? roles?.find((role) => roleKey(role.name) === key) : undefined;
}
