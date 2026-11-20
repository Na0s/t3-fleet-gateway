import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { listBots, sendBotMessage, type SendBotOptions } from '../src/bots/service.ts';
import { runCli } from '../src/cli/main.ts';
import { readBotInput } from '../src/cli/bots.ts';
import { parseConfig } from '../src/config.ts';
import { runtimeManifestSchema } from '../src/webhooks/runtimeLoader.ts';
import { postWebhook } from '../src/webhooks/sender.ts';
import { tempDir } from './helpers/tmp.ts';

const environmentId = '11111111-1111-4111-8111-111111111111';
const message = { botId: 'synthetic-reviewer', environmentId, threadId: 'thread-1', requestId: 'message-1', message: 'Review the synthetic change.' };
function manifest() {
  return runtimeManifestSchema.parse({ version: 1, profiles: { pilot: { environmentId: 'a'.repeat(26), kind: 'enrolled', fleetPath: '/synthetic/fleet' } },
    routes: [{ id: 'reviewer', profile: 'pilot', targetBot: 'Synthetic Reviewer', presentation: { icon: '✦', color: '#A78BFA' },
      urlVariable: 'GROKBOT_REVIEWER_URL', keyVariable: 'GROKBOT_REVIEWER_KEY', authContract: 'grok-bot-bearer',
      hosts: ['main'], expectedEnvironmentId: environmentId, targets: [{ host: 'main', projectId: 'project-1' }], events: ['idle'] }] });
}
function options(t: TestContext): SendBotOptions {
  return { config: parseConfig({ publicUrl: 'http://127.0.0.1:3790', hosts: [{ id: 'main', t3Url: 'http://127.0.0.1:1' }] }),
    manifest: manifest(), dataDir: tempDir(t), env: {},
    verify: async (host, input) => { assert.equal(host, 'main'); return { ...input, projectId: 'project-1' }; },
    fetch: async (_profile, names) => {
      assert.deepEqual(names, ['GROKBOT_REVIEWER_URL', 'GROKBOT_REVIEWER_KEY']);
      return { GROKBOT_REVIEWER_URL: 'https://receiver.example.com/private-routine', GROKBOT_REVIEWER_KEY: 'synthetic-key' };
    },
    post: async () => ({ outcome: 'delivered', statusCode: 200 }),
  };
}

test('bot catalog is nonsecret, deterministic and merges the same recipient across hosts', () => {
  const m = manifest();
  m.routes.push({ ...m.routes[0]!, id: 'studio-reviewer', hosts: ['studio'], expectedEnvironmentId: 'environment-studio' });
  assert.deepEqual(listBots(m), { bots: [{ id: 'synthetic-reviewer', name: 'Synthetic Reviewer', icon: '✦', color: '#A78BFA' }] });
  delete m.routes[0]!.presentation; delete m.routes[1]!.presentation;
  assert.deepEqual(listBots(m), listBots(m));
  assert.match(listBots(m).bots[0]!.color, /^#[0-9A-F]{6}$/);
  assert.ok(!JSON.stringify(listBots(m)).includes('GROKBOT_'));
  m.routes[1]!.presentation = { id: 'synthetic-reviewer', icon: '◆' };
  assert.throws(() => listBots(m), { code: 'config_invalid' });
});

test('disabled lifecycle route sends only selected bot credentials and exactly the five routine fields', async t => {
  const o = options(t); let posts = 0;
  o.manifest.routes.push({ ...o.manifest.routes[0]!, id: 'other', targetBot: 'Synthetic Writer', urlVariable: 'GROKBOT_OTHER_URL' });
  o.post = async (route, payload) => {
    posts++; assert.equal(route.routine, undefined); assert.equal(route.value, 'Bearer synthetic-key');
    const wire = JSON.parse(payload);
    assert.deepEqual(Object.keys(wire).sort(), ['environment_id', 'status', 'summary', 'target_bot', 'thread_id']);
    assert.equal(wire.target_bot, 'Synthetic Reviewer'); assert.equal(wire.status, 'needs_input');
    assert.match(wire.summary, /does not transfer thread ownership/);
    return { outcome: 'delivered', statusCode: 202 };
  };
  const first = await sendBotMessage(message, o);
  assert.deepEqual(first, { botId: message.botId, requestId: message.requestId, status: 'accepted', duplicate: false, httpStatus: 202 });
  assert.deepEqual(await sendBotMessage(message, { ...o, fetch: async () => { throw Error('no second credential read'); } }), { ...first, duplicate: true });
  assert.equal(posts, 1); assert.equal(o.manifest.routes[0]!.enabled, false);
  const receipt = readFileSync(join(o.dataDir, 'bot-requests', readdirSync(join(o.dataDir, 'bot-requests'))[0]!), 'utf8');
  for (const privateText of [message.message, message.threadId, 'synthetic-key', 'private-routine']) assert.ok(!receipt.includes(privateText));
  await assert.rejects(sendBotMessage({ ...message, message: 'A different request.' }, o), { code: 'request_id_conflict' });
  assert.equal(posts, 1);
});

test('concurrent requests reserve before POST and a crash or uncertain outcome never causes another send', async t => {
  const o = options(t); let posts = 0;
  o.post = async () => { posts++; throw Error('synthetic-private-network-error'); };
  const results = await Promise.all([sendBotMessage(message, o), sendBotMessage(message, o)]);
  assert.equal(posts, 1); assert.ok(results.every(result => result.status === 'unknown'));
  assert.equal(results.filter(result => result.duplicate).length, 1);
  assert.equal((await sendBotMessage(message, o)).duplicate, true);
  assert.equal(posts, 1);
});

test('authenticated environment/thread/project mismatches reject before credentials or POST', async t => {
  for (const mismatch of [{ environmentId: 'other' }, { threadId: 'other' }, { projectId: 'other' }, { archived: true }]) {
    const o = options(t); let fetched = 0;
    o.verify = async () => ({ ...message, projectId: 'project-1', ...mismatch });
    o.fetch = async () => { fetched++; throw Error(); };
    await assert.rejects(sendBotMessage(message, o), { code: 'invalid_argument' });
    assert.equal(fetched, 0); assert.equal(readdirSync(join(o.dataDir, 'bot-requests')).length, 0);
  }
  const o = options(t);
  o.manifest.routes.push({ ...o.manifest.routes[0]!, id: 'ambiguous' });
  await assert.rejects(sendBotMessage(message, o), { code: 'invalid_argument' });
  await assert.rejects(sendBotMessage({ ...message, url: 'https://unapproved.example.com' }, options(t)), { code: 'invalid_argument' });
});

test('project and job route filters are preserved, and symlink/insecure receipt stores fail closed', async t => {
  const o = options(t);
  o.manifest.routes[0]!.jobs = ['existing-job'];
  await assert.rejects(sendBotMessage(message, o), { code: 'insufficient_scope' });
  delete o.manifest.routes[0]!.jobs;
  chmodSync(o.dataDir, 0o755);
  await assert.rejects(sendBotMessage(message, o), { code: 'config_invalid' });
  chmodSync(o.dataDir, 0o700);
  const other = tempDir(t); const linked = options(t); symlinkSync(other, join(linked.dataDir, 'bot-requests'));
  await assert.rejects(sendBotMessage(message, linked), { code: 'config_invalid' });
});

test('real transport delivers one explicit routine payload and HTTP errors are terminal for the same request', async t => {
  let posts = 0;
  const receiver = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    posts++; assert.equal(JSON.parse(body).target_bot, 'Synthetic Reviewer');
    assert.equal(req.headers.authorization, 'Bearer synthetic-key'); res.writeHead(503).end();
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => receiver.close(() => resolve())));
  const o = options(t);
  o.post = (route, payload) => postWebhook({ ...route, url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}` }, payload);
  const first = await sendBotMessage(message, o);
  assert.deepEqual([first.status, first.httpStatus], ['failed', 503]);
  assert.equal((await sendBotMessage(message, o)).duplicate, true); assert.equal(posts, 1);
});

test('CLI lists without opening config, data directory or credential provider and rejects bad input safely', async t => {
  const dir = tempDir(t); const manifestPath = join(dir, 'routes.json');
  writeFileSync(manifestPath, JSON.stringify(manifest()), { mode: 0o600 });
  const env = { T3FG_RUNTIME_ROUTES: manifestPath, T3FG_CONFIG: join(dir, 'missing-config'), T3FG_DATA_DIR: join(dir, 'missing-data') };
  const out: string[] = []; const err: string[] = [];
  assert.equal(await runCli(['bots', 'list', '--json'], { env, out: text => out.push(text), err: text => err.push(text) }), 0);
  assert.deepEqual(JSON.parse(out[0]!), listBots(manifest())); assert.equal(existsSync(env.T3FG_DATA_DIR), false);
  assert.equal(await runCli(['bots', 'send', '--json'], { env, input: Readable.from(['synthetic-private-not-json']), out: text => out.push(text), err: text => err.push(text) }), 1);
  assert.ok(!err.join('').includes('synthetic-private'));
  assert.equal(await runCli(['bots', 'list'], { env, out: () => {}, err: () => {} }), 2);
  await assert.rejects(readBotInput(Readable.from(['x'.repeat(65537)])), { code: 'invalid_argument' });
});
