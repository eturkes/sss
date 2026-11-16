import {Runtime} from '../src/app/runtime.ts';
import {loadMonitorFiles} from '../src/config/load.ts';
// Live acquisition only; no inference, state changes or delivery. Explicit IDs also probe disabled recipes.
const runtime=new Runtime({ephemeral:true});
let failures=0;
try {
 const args=process.argv.slice(2), parallel=args.includes('--parallel'), ids=args.filter(arg=>arg!=='--parallel');
 const recipes=(await loadMonitorFiles(runtime.monitorsDir)).filter(({config})=>config.id.startsWith('discussion-') && (ids.length?ids.includes(config.id):config.enabled));
 if(!recipes.length)throw new Error('no discussion recipes selected');
 async function drain(queue:typeof recipes,workers:number){
  let index=0;
  await Promise.all(Array.from({length:Math.min(workers,queue.length)},async()=>{
   while(index<queue.length){
    const {config,filePath}=queue[index++]!;
    const start=Date.now(), result=await runtime.run(filePath,true), ok=result.status==='ok_unchanged' && result.dryRun;
    if(!ok)failures++;
    console.log(JSON.stringify({id:config.id,ok,items:result.items.length,seconds:(Date.now()-start)/1000,maxItemBytes:Math.max(0,...result.items.map(item=>Buffer.byteLength(JSON.stringify({observation:item})))),...(result.error?{error:result.error}:{})}));
   }
  }));
 }
 if(parallel)await Promise.all([drain(recipes.filter(r=>r.config.source.type!=='reddit_discussions'),3),drain(recipes.filter(r=>r.config.source.type==='reddit_discussions'),1)]);
 else await drain(recipes,1);
 console.log(`${recipes.length-failures}/${recipes.length} complete configured acquisitions; no inference, state or delivery`);
}finally{runtime.close();}
if(failures)process.exitCode=1;
