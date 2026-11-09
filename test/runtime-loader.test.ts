import assert from 'node:assert/strict';
import { writeFileSync,chmodSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { runtimeManifestSchema,prepareRuntime,readRuntimeManifest,serviceEnvironment,fetchAccountProfile } from '../src/webhooks/runtimeLoader.ts';
import { tempDir } from './helpers/tmp.ts';

const eid='a'.repeat(26);
const envId='11111111-1111-4111-8111-111111111111';
const base=()=>parseConfig({publicUrl:'http://127.0.0.1:3790',hosts:[{id:'main',t3Url:'http://127.0.0.1:1'}]});
const manifest=()=>runtimeManifestSchema.parse({version:1,profiles:{pilot:{environmentId:eid,kind:'enrolled',fleetPath:'/synthetic/fleet'}},
 routes:[{id:'synthetic-bot',profile:'pilot',enabled:false,targetBot:'Synthetic Coordinator',urlVariable:'GROKBOT_SYNTHETIC_URL',keyVariable:'GROKBOT_SYNTHETIC_KEY',headerVariable:'GROKBOT_SYNTHETIC_HEADER',hosts:['main'],expectedEnvironmentId:envId,events:['idle','needs_input','adopted']}]});
const values=()=>({GROKBOT_SYNTHETIC_URL:'https://receiver.example.com/synthetic-private-url',GROKBOT_SYNTHETIC_KEY:'synthetic-private-key',GROKBOT_SYNTHETIC_HEADER:'X-Sender-Key: synthetic-private-key'});

test('check-only loader requests exact variables once and leaves only selected values in Gateway environment',async()=>{
 const calls:unknown[]=[];const result=await prepareRuntime(base(),manifest(),{PATH:'/usr/bin',HOME:'/synthetic',OP_SERVICE_ACCOUNT_TOKEN:'synthetic-master-token',UNRELATED_SECRET:'synthetic-other',NODE_TLS_REJECT_UNAUTHORIZED:'0'},
 {checkIds:['synthetic-bot'],fetch:async(p,n,env,name)=>{calls.push({p,n,env,name});assert.equal(env.OP_SERVICE_ACCOUNT_TOKEN,undefined);return values();}});
 assert.equal(calls.length,1);assert.equal(result.env.OP_SERVICE_ACCOUNT_TOKEN,undefined);assert.equal(result.env.UNRELATED_SECRET,undefined);
 assert.equal(result.env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);assert.equal(result.env.T3FG_WEBHOOK_SYNTHETIC_BOT_VALUE,'synthetic-private-key');
 assert.ok(!JSON.stringify(result.config).includes('synthetic-private'));
 assert.equal(result.config.webhooks.subscriptions[0]!.enabled,false);
 assert.equal(result.config.webhooks.subscriptions[0]!.routine!.expectedT3Origin,base().hosts[0]!.t3Url);
 assert.deepEqual(result.checked,['synthetic-bot']);
 assert.equal(serviceEnvironment(result.env).T3FG_WEBHOOK_SYNTHETIC_BOT_VALUE,undefined);
});

test('disabled service routes perform zero credential retrievals',async()=>{
 let calls=0;const result=await prepareRuntime(base(),manifest(),{}, {fetch:async()=>{calls++;throw Error('should not run');}});
 assert.equal(calls,0);assert.equal(result.config.webhooks.subscriptions.length,0);
});

test('missing, mismatched, malformed and unsafe saved tuples fail with fixed redacted diagnostics',async()=>{
 for(const bad of [{...values(),GROKBOT_SYNTHETIC_HEADER:'Authorization: Bearer synthetic-wrong-key'},
 {...values(),GROKBOT_SYNTHETIC_URL:'http://receiver.example.com'}, {...values(),GROKBOT_SYNTHETIC_HEADER:'Host: synthetic-private-key'},
 {...values(),GROKBOT_SYNTHETIC_HEADER:'X-Sender-Key: synthetic-private-key\r\nX-Leak: bad'},{}]){
 await assert.rejects(prepareRuntime(base(),manifest(),{}, {checkIds:['synthetic-bot'],fetch:async()=>bad}), e=>{
  assert.equal((e as {code:string}).code,'config_invalid');assert.ok(!String(e).includes('synthetic-private'));return true;
 });}
 await assert.rejects(prepareRuntime(base(),manifest(),{}, {checkIds:['unknown']}),{code:'config_invalid'});
});

test('a saved header name and raw key or a matching saved Bearer header are supported without guessing',async()=>{
 for(const header of ['X-Sender-Key','Authorization: Bearer synthetic-private-key']){
 const result=await prepareRuntime(base(),manifest(),{}, {checkIds:['synthetic-bot'],fetch:async()=>({...values(),GROKBOT_SYNTHETIC_HEADER:header})});
 assert.equal(result.env.T3FG_WEBHOOK_SYNTHETIC_BOT_VALUE,header.startsWith('Authorization')?'Bearer synthetic-private-key':'synthetic-private-key');
 }
});

test('manifest rejects secret literals, unfiltered activation, unsafe files and symlinks',t=>{
 const dir=tempDir(t);const path=join(dir,'routes.json');writeFileSync(path,JSON.stringify(manifest()),{mode:0o600});
 assert.equal(readRuntimeManifest(path).routes.length,1);chmodSync(path,0o644);assert.throws(()=>readRuntimeManifest(path),{code:'config_invalid'});
 chmodSync(path,0o600);symlinkSync(path,join(dir,'link'));assert.throws(()=>readRuntimeManifest(join(dir,'link')),{code:'config_invalid'});
 const inherited=manifest();inherited.profiles={};inherited.routes[0]!.profile='constructor';assert.equal(runtimeManifestSchema.safeParse(inherited).success,false);
 const m=manifest();m.routes[0]!.enabled=true;assert.equal(runtimeManifestSchema.safeParse(m).success,false);
 m.routes[0]!.jobs=['synthetic-job'];assert.equal(runtimeManifestSchema.safeParse(m).success,true);
 m.routes[0]!.urlVariable='https://secret.example.com';assert.equal(runtimeManifestSchema.safeParse(m).success,false);
});

test('enrolled provider captures selected JSON privately and strips parent credentials',async t=>{
 const dir=tempDir(t);const fleet=join(dir,'fleet');
 writeFileSync(fleet,`#!/usr/bin/python3\nimport os,sys,json\nassert sys.argv[1:5]==['account-run','pilot','${eid}','--']\nassert 'OP_SERVICE_ACCOUNT_TOKEN' not in os.environ\nprint(json.dumps({'GROKBOT_SYNTHETIC_KEY':'synthetic-child-result'}))\n`,{mode:0o700});
 const result=await fetchAccountProfile({kind:'enrolled',environmentId:eid,fleetPath:fleet},['GROKBOT_SYNTHETIC_KEY'],{HOME:dir,PATH:'/usr/bin:/bin',OP_SERVICE_ACCOUNT_TOKEN:'synthetic-parent'},'pilot');
 assert.equal(result.GROKBOT_SYNTHETIC_KEY,'synthetic-child-result');
});

test('provider malformed/private diagnostics and oversized output never escape the fixed error boundary',async t=>{
 const dir=tempDir(t);const fleet=join(dir,'fleet');
 for(const body of ["import sys; print('synthetic-secret-diagnostic',file=sys.stderr); sys.exit(1)","print('synthetic-secret-not-json')","print('s'*200000)"]){
 writeFileSync(fleet,'#!/usr/bin/python3\n'+body+'\n',{mode:0o700});
 await assert.rejects(fetchAccountProfile({kind:'enrolled',environmentId:eid,fleetPath:fleet},['GROKBOT_SYNTHETIC_KEY'],{PATH:'/usr/bin:/bin'},'pilot'),e=>{
  assert.equal((e as {code:string}).code,'config_invalid');assert.ok(!String(e).includes('synthetic-secret'));return true;
 });}
});

test('explicit documented bearer contract fetches only saved URL/key and keeps resolved values out of config',async()=>{
 const raw=JSON.parse(JSON.stringify(manifest()));delete raw.routes[0].headerVariable;raw.routes[0].authContract='grok-bot-bearer';
 const m=runtimeManifestSchema.parse(raw);let calls=0;
 const result=await prepareRuntime(base(),m,{}, {checkIds:['synthetic-bot'],fetch:async(p,n)=>{
  calls++;assert.deepEqual(n.sort(),['GROKBOT_SYNTHETIC_KEY','GROKBOT_SYNTHETIC_URL']);
  return {GROKBOT_SYNTHETIC_URL:values().GROKBOT_SYNTHETIC_URL,GROKBOT_SYNTHETIC_KEY:values().GROKBOT_SYNTHETIC_KEY};
 }});
 assert.equal(calls,1);assert.equal(result.env.T3FG_WEBHOOK_SYNTHETIC_BOT_VALUE,'Bearer synthetic-private-key');
 assert.equal(result.config.webhooks.subscriptions[0]!.auth.header,'Authorization');
 assert.ok(!JSON.stringify(result.config).includes('synthetic-private'));
 assert.equal(result.config.webhooks.subscriptions[0]!.enabled,false);
});

test('auth contract is explicit and mutually exclusive with a saved header; malformed bearer keys fail closed',async()=>{
 const raw=JSON.parse(JSON.stringify(manifest()));delete raw.routes[0].headerVariable;
 assert.equal(runtimeManifestSchema.safeParse(raw).success,false);
 raw.routes[0].authContract='unsupported';assert.equal(runtimeManifestSchema.safeParse(raw).success,false);
 raw.routes[0].authContract='grok-bot-bearer';raw.routes[0].headerVariable='GROKBOT_SYNTHETIC_HEADER';assert.equal(runtimeManifestSchema.safeParse(raw).success,false);
 delete raw.routes[0].headerVariable;const m=runtimeManifestSchema.parse(raw);
 for(const key of ['','Bearer synthetic-key','synthetic key','synthetic\nkey','synthetic:key']){
 await assert.rejects(prepareRuntime(base(),m,{}, {checkIds:['synthetic-bot'],fetch:async()=>({GROKBOT_SYNTHETIC_URL:values().GROKBOT_SYNTHETIC_URL,GROKBOT_SYNTHETIC_KEY:key})}),{code:'config_invalid'});
 }
});

test('five disabled project routes group ten selected variables into one account call and perform no startup fetch',async()=>{
 const raw=JSON.parse(JSON.stringify(manifest()));raw.routes=[];
 for(let i=0;i<5;i++)raw.routes.push({id:`project-bot-${i}`,profile:'pilot',enabled:false,targetBot:`Synthetic role ${i}`,
  urlVariable:`GROKBOT_ROLE_${i}_URL`,keyVariable:`GROKBOT_ROLE_${i}_KEY`,authContract:'grok-bot-bearer',hosts:['main'],expectedEnvironmentId:envId,events:['adopted','idle','needs_input']});
 const m=runtimeManifestSchema.parse(raw);let calls=0;
 const fetch=async(p:unknown,n:string[])=>{calls++;assert.equal(n.length,10);return Object.fromEntries(n.map(k=>[k,k.endsWith('_URL')?'https://receiver.example.com/'+k:'synthetic-'+k]));};
 const startup=await prepareRuntime(base(),m,{}, {fetch});assert.equal(calls,0);assert.equal(startup.checked.length,0);
 const check=await prepareRuntime(base(),m,{}, {checkIds:m.routes.map(r=>r.id),fetch});assert.equal(calls,1);assert.equal(check.checked.length,5);
 assert.ok(check.config.webhooks.subscriptions.every(s=>!s.enabled));
});
