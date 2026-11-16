import {Runtime} from '../src/app/runtime.ts';
import {semanticMonitorHash, type Source} from '../src/config/schema.ts';
import {collectSource} from '../src/sources/collect.ts';
import {safeFetch} from '../src/security/network.ts';
import type {Collection} from '../src/core/types.ts';
// Run while the scheduler is stopped. Prime only new namespaces; no historical alerts.
const snapshots=new Map<string,Collection>();
const runtime=new Runtime({collector:async(source,context)=>{
 const key=JSON.stringify(source), cached=snapshots.get(key);
 if(cached)return structuredClone(cached);
 const observed=await collectSource(source as Source,{fetch:safeFetch},context);
 snapshots.set(key,observed);
 return observed;
}});
let failed=0;
try {
 const configs=(await runtime.sync()).filter(c=>c.enabled && c.id.startsWith('discussion-'));
 async function drain(queue:typeof configs,workers:number){
  let index=0;
  await Promise.all(Array.from({length:workers},async()=>{
   while(index<queue.length){
    const config=queue[index++]!;
    if(runtime.store.initialized(config.id,semanticMonitorHash(config))){console.log(`SKIP ${config.id}: already primed`);continue;}
    if(config.rules.some(r=>r.bootstrap!=='suppress_existing'))throw new Error(`unsafe bootstrap: ${config.id}`);
    // Validate acquisition in the dry-run pipeline, then persist that exact frozen
    // collection. Reacquiring would double rate-limited requests and change the evidence.
    const probe=await runtime.run(config.id,true);
    if(probe.status!=='ok_unchanged'){
     failed++;snapshots.delete(JSON.stringify(config.source));
     console.log(JSON.stringify({id:config.id,status:probe.status,error:probe.error,dryRun:true}));continue;
    }
    const result=await runtime.run(config.id);
    snapshots.delete(JSON.stringify(config.source));
    if(!['ok_unchanged','ok_changed'].includes(result.status)||result.events.some(e=>e.kind==='llm_assessment'))failed++;
    console.log(JSON.stringify({id:config.id,status:result.status,items:result.items.length,events:result.events.length,...(result.error?{error:result.error}:{})}));
   }
  }));
 }
 await Promise.all([drain(configs.filter(c=>c.source.type!=='reddit_discussions'),3),drain(configs.filter(c=>c.source.type==='reddit_discussions'),1)]);
}finally{runtime.close();}
if(failed)process.exitCode=1;
