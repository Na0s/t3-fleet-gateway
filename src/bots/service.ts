import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import type { GatewayConfig } from '../config.ts';
import { GatewayError, isGatewayError } from '../errors.ts';
import { isThreadId } from '../threadId.js';
import { loadRoute, resolveRuntimeRoute, type WebhookRoute } from '../webhooks/config.ts';
import { prepareRuntime, type FetchProfile, type RuntimeManifest } from '../webhooks/runtimeLoader.ts';
import { postWebhook } from '../webhooks/sender.ts';
import type { AttemptResult } from '../webhooks/store.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const COLORS = ['#2DD4BF', '#FB7185', '#A78BFA', '#60A5FA', '#FBBF24', '#4ADE80'];
const ICONS = ['◈', '✦', '✺', '◆', '✧', '●'];
type Route = RuntimeManifest['routes'][number];
export interface Bot { id: string; name: string; icon: string; color: string }
function botId(route: Route): string {
  const slug = route.targetBot.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 54);
  return route.presentation?.id ?? (slug || `bot-${digest(route.targetBot).slice(0, 12)}`);
}
const invalid = () => new GatewayError('invalid_argument', 'Invalid bot message or unsupported recipient/environment.');
const unavailable = () => new GatewayError('config_invalid', 'Bot routing unavailable; check the private manifest, enrollment and receipt directory.');

/** Only display metadata crosses the operator command boundary; no credential lookup or database open. */
export function listBots(manifest: RuntimeManifest): { bots: Bot[] } {
  const bots = new Map<string, Bot>();
  for (const route of manifest.routes) {
    const id = botId(route);
    const n = Number.parseInt(digest(id).slice(0, 8), 16);
    const bot = { id, name: route.targetBot, icon: route.presentation?.icon ?? ICONS[n % ICONS.length]!,
      color: route.presentation?.color ?? COLORS[n % COLORS.length]! };
    const existing = bots.get(id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(bot)) throw unavailable();
    bots.set(id, bot);
  }
  return { bots: [...bots.values()] };
}

export const botMessageSchema = z.strictObject({
  botId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  environmentId: z.string().min(1).max(2048).refine(isThreadId),
  threadId: z.string().min(1).max(2048).refine(isThreadId),
  requestId: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/),
  message: z.string().min(1).max(16000).refine(value => value.trim().length > 0),
});
export type BotMessage = z.output<typeof botMessageSchema>;
export interface BotReceipt {
  botId: string; requestId: string; status: 'accepted' | 'unknown' | 'failed'; duplicate: boolean; httpStatus: number | null;
}
const savedSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['accepted', 'unknown', 'failed']),
  httpStatus: z.number().int().min(100).max(599).nullable(),
});
type Saved = z.output<typeof savedSchema>;

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || (st.mode & 0o077) || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw unavailable();
}
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readSaved(path: string): Saved {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1024 || (st.mode & 0o077) ||
        (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw unavailable();
    return savedSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally { closeSync(fd); }
}
function reserve(path: string, saved: Saved): Saved | undefined {
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readSaved(path); throw error; }
  try { writeFileSync(fd, JSON.stringify(saved)); fsyncSync(fd); } finally { closeSync(fd); }
  return undefined;
}

export interface SendBotOptions {
  config: GatewayConfig; manifest: RuntimeManifest; dataDir: string; env: NodeJS.ProcessEnv;
  verify: (host: string, input: BotMessage) => Promise<{ environmentId: string; threadId: string; projectId: string; archived?: boolean }>;
  fetch?: FetchProfile;
  post?: (route: WebhookRoute, payload: string) => Promise<AttemptResult>;
}

/** Explicit operator send, independent of lifecycle subscriptions; uncertain sends are never automatically retried. */
export async function sendBotMessage(raw: unknown, options: SendBotOptions): Promise<BotReceipt> {
  const parsed = botMessageSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const input = parsed.data;
  listBots(options.manifest);
  const matches = options.manifest.routes.filter(route => botId(route) === input.botId && route.expectedEnvironmentId === input.environmentId);
  if (matches.length !== 1) throw invalid();
  const route = matches[0]!;
  const host = options.config.hosts.find(host => host.id === route.hosts[0]);
  if (!host) throw unavailable();
  const fingerprint = digest(JSON.stringify(input));
  const directory = join(options.dataDir, 'bot-requests');
  const path = join(directory, digest(input.requestId) + '.json');
  const receipt = (saved: Saved, duplicate: boolean): BotReceipt => {
    if (saved.fingerprint !== fingerprint) throw new GatewayError('request_id_conflict', 'Request ID already used for a different bot message.');
    return { botId: input.botId, requestId: input.requestId, status: saved.status, duplicate, httpStatus: saved.httpStatus };
  };
  try {
    privateDirectory(options.dataDir);
    privateDirectory(directory);
    syncDirectory(options.dataDir);
    try { return receipt(readSaved(path), true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const actual = await options.verify(host.id, input);
    if (actual.environmentId !== input.environmentId || actual.threadId !== input.threadId || actual.archived ||
        (route.targets && !route.targets.some(target => target.host === host.id && target.projectId === actual.projectId))) throw invalid();
    if (route.jobs) throw new GatewayError('insufficient_scope', 'Job-filtered routes require a separate explicit mention route with project targets.');
    const prepared = await prepareRuntime(options.config, options.manifest, options.env,
      { checkIds: [route.id], ...(options.fetch ? { fetch: options.fetch } : {}) });
    const subscription = prepared.config.webhooks.subscriptions.find(subscription => subscription.id === route.id)!;
    const resolved = resolveRuntimeRoute(loadRoute(subscription, options.dataDir, prepared.env), prepared.env);
    // Explicit messages retain the receiver's five-field contract, without inferring a handoff or ownership change.
    const payload = JSON.stringify({ thread_id: input.threadId, environment_id: input.environmentId, status: 'needs_input',
      target_bot: route.targetBot, summary: `${input.message}\nMessage ${digest(input.requestId)}. This message does not transfer thread ownership.` });
    const pending: Saved = { fingerprint, status: 'unknown', httpStatus: null };
    const previous = reserve(path, pending);
    if (previous) return receipt(previous, true);
    syncDirectory(directory);
    let result: AttemptResult;
    try {
      const { routine: _routine, ...transport } = resolved;
      result = await (options.post ?? postWebhook)(transport, payload);
    } catch { return receipt(pending, false); }
    const saved: Saved = { fingerprint, status: result.outcome === 'delivered' ? 'accepted' : result.statusCode !== null ? 'failed' : 'unknown',
      httpStatus: result.statusCode };
    const temporary = path + '.result';
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(saved)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    syncDirectory(directory);
    return receipt(saved, false);
  } catch (error) {
    if (isGatewayError(error)) throw error;
    throw unavailable();
  }
}
