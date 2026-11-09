import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { validateHeaderValue } from 'node:http';
import * as z from 'zod';
import { parseConfig, type GatewayConfig } from '../config.ts';
import { GatewayError } from '../errors.ts';
import { authHeaderAllowed, loadRoute } from './config.ts';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const variable = z.string().regex(/^GROKBOT_[A-Z0-9_]{1,110}$/);
const profileSchema = z.strictObject({
  environmentId: z.string().regex(/^[a-z0-9]{26}$/),
  kind: z.enum(['legacy-fleet', 'enrolled']),
  fleetPath: z.string().refine(isAbsolute),
});
export const runtimeManifestSchema = z.strictObject({
  version: z.literal(1),
  profiles: z.record(slug, profileSchema),
  routes: z.array(z.strictObject({
    id: slug, profile: slug, enabled: z.boolean().default(false),
    targetBot: z.string().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/),
    urlVariable: variable, keyVariable: variable, headerVariable: variable.optional(),
    authContract: z.literal('grok-bot-bearer').optional(),
    hosts: z.array(slug).length(1), expectedEnvironmentId: z.string().min(1).max(2048),
    events: z.array(z.enum(['adopted','needs_input','idle','failed','cancelled','delegated_work_ended','running'])).min(1),
    jobs: z.array(z.string().min(1).max(64)).min(1).max(100).optional(),
    targets: z.array(z.strictObject({host:slug,projectId:z.string().min(1).max(300)})).min(1).max(100).optional(),
  }).refine(r => (r.headerVariable !== undefined) !== (r.authContract !== undefined))).max(32),
}).refine(m => new Set(m.routes.map(r => r.id)).size === m.routes.length && m.routes.every(r => Object.hasOwn(m.profiles,r.profile) && (!r.enabled || r.jobs || r.targets)));
export type RuntimeManifest = z.output<typeof runtimeManifestSchema>;
type Profile = z.output<typeof profileSchema>;
const failure = () => new GatewayError('config_invalid', 'Runtime route loading failed; check manifest, account enrollment, Environment grant and saved tuple. No credentials are logged.');

/** Never trust repo-local environment files as a service manifest, and never print parsing details. */
export function readRuntimeManifest(path: string): RuntimeManifest {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 64*1024 || (st.mode & 0o077) ||
        (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw failure();
    return runtimeManifestSchema.parse(JSON.parse(readFileSync(path,'utf8')));
  } catch { throw failure(); }
}

export function serviceEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names=['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS',
    'LD_LIBRARY_PATH','NODE_EXTRA_CA_CERTS','T3FG_CONFIG','T3FG_DATA_DIR','T3FG_LOG_LEVEL','T3FG_RUNTIME_ROUTES'];
  return Object.fromEntries(names.filter(n=>input[n]!==undefined).map(n=>[n,input[n]]));
}

/** One provider process group, one deadline, bounded private stdout; stderr is never retained. */
function privateJson(file:string,args:string[],env:NodeJS.ProcessEnv,names:string[]):Promise<Record<string,string>> {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{env:serviceEnvironment(env),stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    let done=false;let bytes=0;const chunks:Buffer[]=[];
    const stop=()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{/* already exited */}};
    const timer=setTimeout(()=>fail(),45_000);
    const fail=()=>{if(done)return;done=true;clearTimeout(timer);stop();chunks.length=0;reject(failure());};
    child.on('error',fail);
    child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>128*1024)fail();else if(!done)chunks.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>128*1024)fail();});
    child.on('close',code=>{
      if(done)return;
      if(code!==0){fail();return;}
      try{
        const values=z.record(z.string(),z.string()).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if(Object.keys(values).some(n=>!names.includes(n))||names.some(n=>!values[n]))throw failure();
        done=true;clearTimeout(timer);chunks.length=0;resolve(values);
      }catch{fail();}
    });
  });
}

export type FetchProfile = (profile:Profile,names:string[],env:NodeJS.ProcessEnv,name:string)=>Promise<Record<string,string>>;
export const fetchAccountProfile:FetchProfile=async(profile,names,env,name)=>{
  // Only the preexisting Fleet profile's own Environment is allowed through legacy storage.
  if(profile.kind==='legacy-fleet'){
    const code="import runpy,sys,json; m=runpy.run_path(sys.argv[1]); p=m['load_profile'](); assert p.get('onepassword_environment_id')==sys.argv[2]; print(json.dumps(m['read_environment_secrets'](sys.argv[2],*json.loads(sys.argv[3]))))";
    return privateJson('python3',['-I','-c',code,profile.fleetPath,profile.environmentId,JSON.stringify(names)],env,names);
  }
  const selection="import os,sys,json; print(json.dumps({n:os.environ[n] for n in json.loads(sys.argv[1]) if n in os.environ}))";
  return privateJson(profile.fleetPath,['account-run',name,profile.environmentId,'--','python3','-I','-c',selection,JSON.stringify(names)],env,names);
};

/** Check mode validates selected tuples without starting Gateway, opening its DB or making an HTTP request. */
export async function prepareRuntime(base:GatewayConfig,manifest:RuntimeManifest,inputEnv:NodeJS.ProcessEnv,
  options:{checkIds?:string[];fetch?:FetchProfile}={}):Promise<{config:GatewayConfig;env:NodeJS.ProcessEnv;checked:string[]}> {
  try {
    const checked=options.checkIds;
    if(checked?.some(id=>!manifest.routes.some(r=>r.id===id)))throw failure();
    const selected=manifest.routes.filter(r=>checked?checked.includes(r.id):r.enabled);
    const env=serviceEnvironment(inputEnv); const rows=[...base.webhooks.subscriptions];
    const values=new Map<string,Record<string,string>>();
    for(const name of new Set(selected.map(r=>r.profile))){
      const names=[...new Set(selected.filter(r=>r.profile===name).flatMap(r=>[r.urlVariable,r.keyVariable,...(r.headerVariable?[r.headerVariable]:[])]))];
      values.set(name,await(options.fetch??fetchAccountProfile)(manifest.profiles[name]!,names,env,name));
    }
    for(const r of selected){
      if(rows.some(s=>s.id===r.id))throw failure();
      const v=values.get(r.profile)!; const key=v[r.keyVariable]!;
      if(!key||key.length>8192||/[\r\n]/.test(key))throw failure();
      let header:string,value:string;
      if(r.authContract==='grok-bot-bearer'){
        // Explicit documented Grok Bot routine contract; never inferred from a key or URL.
        if(!/^[A-Za-z0-9._~+/-]+=*$/.test(key))throw failure();
        header='Authorization';value='Bearer '+key;
      }else{
        const raw=r.headerVariable?v[r.headerVariable]:undefined;
        if(!raw||raw.length>8192||/[\r\n]/.test(raw))throw failure();
        const colon=raw.indexOf(':');
        if(colon<0){header=raw.trim();value=key;}
        else{header=raw.slice(0,colon).trim();value=raw.slice(colon+1).trim();
          if(value!==key&&value!=='Bearer '+key)throw failure();}
      }
      if(!authHeaderAllowed(header))throw failure();validateHeaderValue(header,value);
      const prefix='T3FG_WEBHOOK_'+r.id.replaceAll('-','_').toUpperCase();
      env[prefix+'_URL']=v[r.urlVariable];env[prefix+'_VALUE']=value;
      const parsed=parseConfig({...base,webhooks:{subscriptions:[{id:r.id,enabled:r.enabled,url:'env:'+prefix+'_URL',
        auth:{header,secretFile:'env:'+prefix+'_VALUE'},hosts:r.hosts,events:r.events,excerptChars:0,
        ...(r.jobs?{jobs:r.jobs}:{}),...(r.targets?{targets:r.targets}:{}),
        routine:{expectedEnvironmentId:r.expectedEnvironmentId,targetBot:r.targetBot,
          expectedT3Origin:base.hosts.find(h=>h.id===r.hosts[0])?.t3Url}}]}}).webhooks.subscriptions[0]!;
      loadRoute(parsed,'',env);
      rows.push(parsed);
    }
    return{config:parseConfig({...base,webhooks:{subscriptions:rows}}),env,checked:selected.map(r=>r.id)};
  }catch{throw failure();}
}
