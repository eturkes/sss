import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assessItem} from '../src/codex/assess.ts';
import {loadMonitorFile} from '../src/config/load.ts';
import type {ScanItem} from '../src/core/types.ts';
const monitor=await loadMonitorFile('monitors/discussion-lobsters.yaml');
const rule=monitor.rules.find(rule=>rule.type==='llm_assessment');
if(!rule || rule.type!=='llm_assessment') throw new Error('discussion assessment rule missing');
const cases=JSON.parse(await readFile(new URL('../test/fixtures/discussion-assessments.json',import.meta.url),'utf8')) as {id:string;expected:boolean;item:ScanItem}[];
for(const candidate of cases){
 const result=await assessItem(candidate.item,rule);
 console.log(JSON.stringify({id:candidate.id,expected:candidate.expected,...result}));
 assert.equal(result.suggestive,candidate.expected,candidate.id);
}
console.log(`${cases.length} live rubric cases passed; no state or delivery`);
