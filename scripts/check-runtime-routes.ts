import { loadConfig, resolvePaths } from '../src/config.ts';
import { nodeVersionProblem } from '../src/nodeVersion.ts';
import { readRuntimeManifest,prepareRuntime } from '../src/webhooks/runtimeLoader.ts';
try{
  if(nodeVersionProblem(process.versions.node))throw Error();
  const path=process.env.T3FG_RUNTIME_ROUTES;if(!path)throw Error();
  const manifest=readRuntimeManifest(path);
  const ids=process.argv.slice(2); const paths=resolvePaths(process.env);
  const result=await prepareRuntime(loadConfig(paths.configPath),manifest,process.env,{checkIds:ids.length?ids:manifest.routes.map(r=>r.id)});
  console.log(JSON.stringify({ready:true,checked:result.checked,enabled:manifest.routes.filter(r=>r.enabled).map(r=>r.id),databaseOpened:false,postCount:0}));
}catch{console.log(JSON.stringify({ready:false,code:'runtime_route_unavailable',databaseOpened:false,postCount:0}));process.exitCode=1;}
