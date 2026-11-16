import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectLobsters } from '../src/sources/lobsters.ts';

const source = { type: 'lobsters' as const, queries: ['formal verification'], lookbackDays: 7, maxPages: 10, maxThreads: 100, maxComments: 2000 };
const clock = () => new Date('2026-11-16T00:00:00Z');
function page(ids = ['abc123'], old = true) {
  return `<input name="what" value="comments" checked><input name="order" value="newest" checked><div class="searchresults"><summary><span class="heading">${ids.length + Number(old)} results for </span></summary></div>` + ids.map((id, i) => `<div class="comment" data-shortid="${id}"><div class="byline"><time data-at-unix="${1794787200-i}"></time><a href="/s/topic1/unrelated">Unrelated title</a></div></div>`).join('') + (old ? '<div class="comment" data-shortid="old123"><div class="byline"><time data-at-unix="1"></time><a href="/s/oldtop/old">Old</a></div></div>' : '');
}
function story(ids = ['abc123']) { return { short_id: 'topic1', title: 'Unrelated title', created_at: '2020-01-01T00:00:00Z', description: '<p>Other subject</p>', submitter_user: 'author', comment_count: ids.length, comments: ids.map(id => ({short_id:id, created_at:'2026-11-16T00:00:00Z', parent_comment:null, commenting_user:'reader',comment:'<p>Formal verification of this algorithm requires an invariant.</p>', is_deleted:false, is_moderated:false})) }; }
function deps(html = page(), data: unknown = story()) { return { now: clock, fetch: async (input: unknown) => new Response(String(input).includes('/search?') ? html : JSON.stringify(data)) }; }

test('Lobsters discovers comments on an old unrelated thread and preserves its full comments', async () => {
  const result = await collectLobsters(source, deps());
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.id, 'lobsters:topic1');
  assert.equal(result.items[0]!.title, 'Unrelated title');
  assert.match(JSON.stringify(result.items[0]!.data), /requires an invariant/);
});
test('Lobsters rejects partial bodies, missing matches, duplicate comments and invalid search shells', async () => {
  for (const data of [{...story(), comment_count:2}, story(['other1']), story(['abc123','abc123'])]) await assert.rejects(collectLobsters(source,deps(page(),data)));
  await assert.rejects(collectLobsters(source,deps('<h1>Sign in</h1>')));
  await assert.rejects(collectLobsters({...source,maxComments:1},deps(page(),story(['abc123','def456']))));
});
test('Lobsters exact observations ignore votes and comment order across generated thread sizes', async () => {
  for(let n=1;n<=32;n++) {
    const ids=Array.from({length:n},(_,i)=>`c${i.toString().padStart(5,'0')}`);
    const data=story(ids);
    const before=await collectLobsters(source,deps(page(ids),data));
    const after=await collectLobsters(source,deps(page(ids),{...data,score:999,comments:[...data.comments].reverse().map(c=>({...c,score:123}))}));
    assert.deepEqual(before,after);
  }
});
test('Lobsters accepts explicit zero results and degrades when bounded pagination cannot finish', async () => {
  assert.equal((await collectLobsters(source,deps(page([],false)))).items.length,0);
  await assert.rejects(collectLobsters({...source,maxPages:1},deps(page(['abc123'],false).replace('1 results','21 results'))));
});
test('Lobsters public comment_count excludes retained deleted comments', async () => {
  const data=story(['abc123','def456']); data.comments[1]!.is_deleted=true; data.comment_count=1;
  assert.equal((await collectLobsters(source,deps(page(),data))).items.length,1);
});
test('Lobsters rejects search counts smaller than returned identities',async()=>{
  await assert.rejects(collectLobsters(source,deps(page(['abc123'],false).replace('1 results','0 results'))));
});
test('Lobsters rejects an oversized aggregate rather than dropping threads',async()=>{
  const ids=Array.from({length:9},(_,i)=>`t0000${i}`);
  let html=page(ids,false);let index=0;html=html.replaceAll('/s/topic1/',()=>`/s/${ids[index++]}/`);
  await assert.rejects(collectLobsters(source,{now:clock,fetch:async input=>{
    const url=new URL(String(input));if(url.pathname==='/search')return new Response(html);
    const tid=url.pathname.split('/')[2]!.replace('.json','');const data=story([tid]);data.short_id=tid;data.comments[0]!.comment='x'.repeat(2*1024*1024);
    return new Response(JSON.stringify(data));
  }}),/byte limit/);
});
