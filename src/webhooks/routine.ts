import * as z from 'zod';
import { GatewayError } from '../errors.ts';
import { isThreadLink, isThreadId } from '../threadId.js';

export const routineOptionsSchema = z.strictObject({
  expectedEnvironmentId: z.string().min(1).max(2048).refine(isThreadId),
  expectedT3Origin: z.string().url().refine(value => {
    try { const u = new URL(value); return u.origin === value && !u.username && !u.password &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(u.hostname))); }
    catch { return false; }
  }).optional(),
  targetBot: z.string().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/),
});
export type RoutineOptions = z.output<typeof routineOptionsSchema>;

/** Fixed text only. Never infer task success or no-review-needed from an idle run. */
export function routinePayload(input: unknown, options: RoutineOptions): Record<string, string> | null {
  const event = z.object({
    eventId: z.uuid(), type: z.string(), threadId: z.string(), link: z.string(),
    waitingOnDelegatedWork: z.boolean(),
  }).safeParse(input);
  const fail = () => { throw new GatewayError('config_invalid', 'Routine event lacks a matching authenticated environment/thread identity.'); };
  if (!event.success) return fail();
  const p = event.data;
  if (!isThreadId(p.threadId)) return fail();
  let environmentId: string | undefined, threadId: string | undefined;
  if (isThreadLink(p.link) && p.link.startsWith('t3-thread://v2/')) {
    [environmentId, threadId] = p.link.slice('t3-thread://v2/'.length).split('/');
  } else {
    if (!options.expectedT3Origin) return fail();
    try {
      const url = new URL(p.link);
      const appLink = url.origin === 'https://app.t3.codes';
      if ((!appLink && url.origin !== options.expectedT3Origin) || url.username || url.password || url.search || url.hash) return fail();
      const prefix = appLink ? '/threads' : '';
      if (prefix && !url.pathname.startsWith(prefix + '/')) return fail();
      const parts = url.pathname.slice(prefix.length).split('/');
      if (parts.length !== 3 || parts[0] !== '') return fail();
      [environmentId, threadId] = parts.slice(1).map(decodeURIComponent);
      // Require the exact canonical T3 route; refuse aliases, double encoding and normalized paths.
      if (url.pathname !== `${prefix}/${encodeURIComponent(environmentId!)}/${encodeURIComponent(threadId!)}` ||
          p.link !== `${url.origin}${url.pathname}`) return fail();
    } catch { return fail(); }
  }
  if (environmentId !== options.expectedEnvironmentId || threadId !== p.threadId) return fail();
  if (p.type === 'idle' && p.waitingOnDelegatedWork) return null;
  const messages: Record<string, [string, string]> = {
    idle: ['completed', 'Turn completed; review requested. Task completion must be checked.'],
    needs_input: ['needs_input', 'Worker needs input, permissions, context or instructions.'],
    failed: ['needs_input', 'Worker turn failed; review and recovery instructions requested.'],
    cancelled: ['needs_input', 'Work cancelled; further instructions requested.'],
    delegated_work_ended: ['needs_input', 'Delegated work ended; orchestrator review requested.'],
    adopted: ['assign', 'Existing T3 thread registered; orchestrator handoff requested.'],
    running: ['assign', 'Work started; orchestrator handoff requested.'],
  };
  const message = messages[p.type];
  if (!message) return null;
  return { thread_id: p.threadId, environment_id: environmentId!, status: message[0]!,
    target_bot: options.targetBot, summary: `${message[1]} Event ${p.eventId}.` };
}
