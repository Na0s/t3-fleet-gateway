import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { test } from 'node:test';
import { webhooksSchema, loadRoute, resolveRuntimeRoute } from '../src/webhooks/config.ts';
import { routinePayload } from '../src/webhooks/routine.ts';
import { WebhookStore } from '../src/webhooks/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { tempDir } from './helpers/tmp.ts';
import { startJobHarness, startJob } from './helpers/jobs.ts';
import { FAKE_ENVIRONMENT_ID } from './helpers/fakeT3.ts';

const run = promisify(execFile);
const environmentId = '11111111-1111-4111-8111-111111111111';
const options = { expectedEnvironmentId: environmentId, targetBot: 'Synthetic Coordinator' };
const event = (type = 'idle') => ({ eventId: randomUUID(), type, threadId: 'mcp:synthetic:thread',
  link: `t3-thread://v2/${environmentId}/mcp:synthetic:thread`, waitingOnDelegatedWork: false });
const entry = (extra = {}) => ({ id: 'runtime', enabled: true, url: 'env:T3FG_TEST_ROUTE_URL',
  auth: { header: 'X-Sender-Key', secretFile: 'env:T3FG_TEST_ROUTE_KEY' }, ...extra });
const config = (extra = {}) => webhooksSchema.parse({ subscriptions: [entry(extra)] });
function runtime(t: Parameters<typeof tempDir>[0]) {
  const names = ['T3FG_TEST_ROUTE_URL', 'T3FG_TEST_ROUTE_KEY'];
  const original = names.map(n => process.env[n]);
  t.after(() => names.forEach((n, i) => { if (original[i] === undefined) delete process.env[n]; else process.env[n] = original[i]; }));
  process.env.T3FG_TEST_ROUTE_URL = 'https://receiver.example.com/synthetic-private-route';
  process.env.T3FG_TEST_ROUTE_KEY = 'synthetic-runtime-only-key';
}

test('runtime descriptors persist references only, survive reopen and rotate revision on tuple change', t => {
  runtime(t);
  const dir = tempDir(t); const path = join(dir, 'gateway.db');
  let db = openDatabase(path); let store = new WebhookStore(db, Date.now);
  store.reconcile(config(), dir);
  const row = db.prepare('SELECT * FROM webhook_subscriptions').get()!;
  const persisted = JSON.stringify(row);
  assert.ok(persisted.includes('env:T3FG_TEST_ROUTE_URL'));
  assert.ok(!persisted.includes(process.env.T3FG_TEST_ROUTE_URL!));
  assert.ok(!persisted.includes(process.env.T3FG_TEST_ROUTE_KEY!));
  const revision = row.revision;
  db.close(); db = openDatabase(path); t.after(() => db.close()); store = new WebhookStore(db, Date.now);
  store.reconcile(config(), dir);
  assert.equal(db.prepare('SELECT revision FROM webhook_subscriptions').get()!.revision, revision);
  const route = loadRoute(config().subscriptions[0]!, dir);
  assert.equal(resolveRuntimeRoute(route).value, process.env.T3FG_TEST_ROUTE_KEY);
  process.env.T3FG_TEST_ROUTE_KEY = 'synthetic-rotated-key';
  assert.throws(() => resolveRuntimeRoute(route), { code: 'config_invalid' });
  store.reconcile(config(), dir);
  assert.notEqual(db.prepare('SELECT revision FROM webhook_subscriptions').get()!.revision, revision);
  const bytes = readFileSync(path).toString();
  assert.ok(!bytes.includes('synthetic-runtime-only-key'));
  assert.ok(!bytes.includes('synthetic-rotated-key'));
});

test('runtime routes reject mixed credentials, missing variables, unsafe destinations, headers and changed URLs', t => {
  runtime(t);
  for (const extra of [{ url: 'https://receiver.example.com' }, { allowLoopbackHttp: true },
    { auth: { header: 'Authorization', secretFile: 'file.key' } }]) assert.equal(webhooksSchema.safeParse({subscriptions:[entry(extra)]}).success, false);
  const subscription = config().subscriptions[0]!;
  for (const url of ['', 'https://receiver.example.com/' + 'x'.repeat(4096), 'http://127.0.0.1:1', 'https://user:password@receiver.example.com', 'https://receiver.example.com/#secret']) {
    process.env.T3FG_TEST_ROUTE_URL = url;
    assert.throws(() => loadRoute(subscription, '/unused'), { code: 'config_invalid' });
  }
  process.env.T3FG_TEST_ROUTE_URL = 'https://receiver.example.com/safe';
  for (const value of ['', 'synthetic\r\nX-Other: bad', 'x'.repeat(8193)]) {
    process.env.T3FG_TEST_ROUTE_KEY = value;
    assert.throws(() => loadRoute(subscription, '/unused'), { code: 'config_invalid' });
  }
});

test('routine contract maps fixed statuses, requests review, retains stable deduplication identity and excludes content', () => {
  for (const [type, status] of [['idle', 'completed'], ['needs_input', 'needs_input'], ['failed', 'needs_input'],
    ['cancelled', 'needs_input'], ['delegated_work_ended', 'needs_input'], ['running', 'assign']]) {
    const input = {...event(type), excerpt:'synthetic-private-content', title:'synthetic-private-title'};
    const payload = routinePayload(input, options)!;
    assert.deepEqual(Object.keys(payload).sort(), ['environment_id','status','summary','target_bot','thread_id']);
    assert.equal(payload.status, status); assert.equal(payload.environment_id, environmentId);
    assert.ok(payload.summary!.includes(input.eventId));
    assert.ok(!JSON.stringify(payload).includes('synthetic-private'));
    assert.deepEqual(routinePayload(input, options), payload);
    if (status === 'completed') assert.match(payload.summary!, /review requested/);
  }
  assert.equal(routinePayload({...event(),waitingOnDelegatedWork:true}, options), null);
  assert.equal(routinePayload(event('credential_alert'), options), null);
});

test('routine identity refuses old/foreign environments, mismatched thread, legacy links and synthetic ping', () => {
  for (const input of [{...event(),link:`t3-thread://v2/22222222-2222-4222-8222-222222222222/mcp:synthetic:thread`},
    {...event(),threadId:'mcp:another'}, {...event(),link:'t3-thread://v1/mcp:synthetic:thread'},
    {type:'ping',eventId:randomUUID()}]) assert.throws(() => routinePayload(input, options), {code:'config_invalid'});
});

test('HTTPS T3 thread routes require a pinned origin and exact environment/thread identity', () => {
  const origin = 'https://synthetic-worker.example.com';
  const input = event();
  const link = `${origin}/${environmentId}/${encodeURIComponent(input.threadId)}`;
  const pinned = {...options,expectedT3Origin:origin};
  assert.deepEqual(routinePayload({...input,link},pinned),routinePayload(input,options));
  assert.throws(()=>routinePayload({...input,link},options),{code:'config_invalid'});
  for (const wrong of [link.replace(origin,'https://foreign.example.com'),
    link.replace(environmentId,'22222222-2222-4222-8222-222222222222'),
    `${origin}/${environmentId}/${encodeURIComponent('mcp:other')}`,link+'?credential=synthetic',link+'#fragment',
    link.replace('https://','https://user:password@'),link.replace('%3A','%253A'),
    link.replace(`/${environmentId}/`,`/extra/../${environmentId}/`),link+'/',link.replace('%3A',':')]) {
    assert.throws(()=>routinePayload({...input,link:wrong},pinned),{code:'config_invalid'});
  }
});

test('T3 app links retain exact environment/thread identity on the fixed official app origin', () => {
  for(const threadId of ['mcp:synthetic:thread','mcp:synthetic:%3A:thread','11111111-1111-4111-8111-111111111111']) {
  const input={...event(),threadId,link:`t3-thread://v2/${environmentId}/${threadId}`};
  const link=`https://app.t3.codes/threads/${environmentId}/${encodeURIComponent(input.threadId)}`;
  const pinned={...options,expectedT3Origin:'http://127.0.0.1:3773'};
  assert.deepEqual(routinePayload({...input,link},pinned),routinePayload(input,options));
  for(const wrong of [link.replace('app.t3.codes','app.t3.codes.example.com'),
    link.replace('/threads/','/'),link.replace(environmentId,'22222222-2222-4222-8222-222222222222'),
    link.replace(encodeURIComponent(input.threadId),encodeURIComponent('mcp:other')),link+'?synthetic=1',link+'#fragment']){
    assert.throws(()=>routinePayload({...input,link:wrong},pinned),{code:'config_invalid'});
  }
  }
});

test('native capture suppresses incomplete delegated turn and retains canonical outbox identity for real completion', async t => {
  runtime(t);
  const h = await startJobHarness(t, {webhooks:config({hosts:['main'],events:['idle'],routine:{...options,expectedEnvironmentId:FAKE_ENVIRONMENT_ID}}),webhookSender:{autoStart:false}});
  h.fake.threadLinkFormat = 'bare-v2';
  const job = await startJob(h.agent); await h.tick();
  const threadId = h.fake.threadForJob(job.jobId).threadId;
  const child = h.fake.delegate(threadId, 'Synthetic delegated task');
  h.fake.finishTurn(threadId, 'Synthetic parent waits'); await h.tick();
  assert.equal(h.gw.services.db.prepare('SELECT count(*) AS n FROM webhook_deliveries').get()!.n, 0);
  h.fake.settleDelegated(child.childThreadId, 'completed');
  h.fake.userTurn(threadId, 'Synthetic follow-up'); h.fake.finishTurn(threadId, 'Synthetic final reply');
  await h.tickAfter(60_000);
  const rows = h.gw.services.db.prepare('SELECT payload FROM webhook_deliveries').all();
  assert.ok(rows.length > 0);
  const payload = JSON.parse(String(rows.at(-1)!.payload));
  assert.equal(payload.jobId, job.jobId);
  assert.equal(routinePayload(payload, {...options,expectedEnvironmentId:FAKE_ENVIRONMENT_ID})!.status, 'completed');
});

test('real verified HTTPS delivers routine JSON from runtime-only tuple and never follows redirect', async t => {
  runtime(t); const dir = tempDir(t);
  await run('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'], {timeout:15000});
  const received: {url:string|undefined; key:unknown; payload:Record<string,string>}[] = [];
  const server = createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},async(req,res)=>{
    const chunks:Buffer[]=[]; for await(const c of req) chunks.push(Buffer.from(c));
    received.push({url:req.url,key:req.headers['x-sender-key'],payload:JSON.parse(Buffer.concat(chunks).toString())});
    if(req.url==='/redirect')res.writeHead(307,{location:'/unexpected'}).end(); else res.writeHead(204).end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const port=(server.address() as {port:number}).port;
  const script=`import {loadRoute,webhooksSchema} from './src/webhooks/config.ts'; import {postWebhook} from './src/webhooks/sender.ts';
    const c=webhooksSchema.parse(JSON.parse(process.env.TEST_CONFIG));const route=loadRoute(c.subscriptions[0],'/unused');
    console.log(JSON.stringify(await postWebhook(route,process.env.TEST_EVENT)));`;
  for(const format of ['native','https','app','foreign','query','wrong-environment','wrong-thread']) {
    const expectedT3Origin='https://synthetic-worker.example.com';
    const routine={...options,expectedEnvironmentId:FAKE_ENVIRONMENT_ID,expectedT3Origin};
    const subscriptions=config({hosts:['main'],events:['adopted','idle'],routine});
    const h=await startJobHarness(t,{webhooks:subscriptions,webhookSender:{autoStart:false}});
    h.fake.threadLinkFormat='bare-v2';
    const launched=h.fake.launchDirect({projectId:'project-1',title:'Synthetic direct-start thread',runtimeMode:'auto',message:'Synthetic task'});
    const thread=h.fake.threads.get(launched.threadId)!;
    if(format!=='native')thread.link=`${format==='app'?'https://app.t3.codes/threads':expectedT3Origin}/${FAKE_ENVIRONMENT_ID}/${encodeURIComponent(thread.threadId)}`;
    if(format==='foreign')thread.link=thread.link.replace(expectedT3Origin,'https://foreign.example.com');
    if(format==='query')thread.link+='?credential=synthetic-private-query';
    if(format==='wrong-environment')thread.link=thread.link.replace(FAKE_ENVIRONMENT_ID,'another-environment');
    if(format==='wrong-thread')thread.link=thread.link.replace(thread.threadId,'another-thread');
    await h.gw.services.jobs.adopt({project:'pilot',threadId:thread.threadId});
    h.fake.finishTurn(thread.threadId,'Synthetic final reply');await h.tickAfter(60_000);
    const row=h.gw.services.db.prepare('SELECT payload FROM webhook_deliveries ORDER BY feed_sequence DESC LIMIT 1').get()!;
    const input=JSON.parse(String(row.payload));
    const valid=['native','https','app'].includes(format);
    assert.equal(input.link,valid?`t3-thread://v2/${FAKE_ENVIRONMENT_ID}/${thread.threadId}`:`t3-thread://v1/${thread.threadId}`);
    for(const path of ['/accept','/redirect']) {
    const result=await run(process.execPath,['--input-type=module','-e',script],{cwd:join(import.meta.dirname,'..'),timeout:15000,
      env:{PATH:process.env.PATH,NODE_EXTRA_CA_CERTS:join(dir,'cert.pem'),T3FG_TEST_ROUTE_URL:`https://127.0.0.1:${port}${path}`,
        T3FG_TEST_ROUTE_KEY:'synthetic-runtime-https-key',TEST_CONFIG:JSON.stringify(subscriptions),TEST_EVENT:JSON.stringify(input)}});
    assert.equal(JSON.parse(result.stdout).outcome,valid?(path==='/accept'?'delivered':'redirect'):'network_error');
    assert.ok(!result.stdout.includes('synthetic-runtime-https-key'));
    }
  }
  assert.equal(received.length,6); assert.equal(received[0]!.key,'synthetic-runtime-https-key');
  assert.equal(received[0]!.payload.status,'completed'); assert.equal(received[0]!.payload.environment_id,FAKE_ENVIRONMENT_ID);
});

test('native adoption emits one opt-in handoff event and repeated adoption does not duplicate it', async t => {
  runtime(t);
  const h = await startJobHarness(t, {webhooks:config({hosts:['main'],events:['adopted'],routine:{...options,expectedEnvironmentId:FAKE_ENVIRONMENT_ID}}),webhookSender:{autoStart:false}});
  h.fake.threadLinkFormat='bare-v2';
  const direct=h.fake.launchDirect({projectId:'project-1',title:'Synthetic direct-start thread',runtimeMode:'auto',message:'Synthetic task'});
  const first=await h.gw.services.jobs.adopt({project:'pilot',threadId:direct.threadId});
  const again=await h.gw.services.jobs.adopt({project:'pilot',threadId:direct.threadId});
  assert.equal(first.job.id,again.job.id); assert.equal(again.created,false);
  const rows=h.gw.services.db.prepare('SELECT payload FROM webhook_deliveries').all();
  assert.equal(rows.length,1);
  const canonical=JSON.parse(String(rows[0]!.payload));
  assert.equal(canonical.type,'adopted');
  assert.equal(routinePayload(canonical,{...options,expectedEnvironmentId:FAKE_ENVIRONMENT_ID})!.status,'assign');
});
