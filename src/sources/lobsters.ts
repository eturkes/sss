import { load } from 'cheerio';
import { z } from 'zod';
import { fetchJson, fetchText } from './http.ts';
import { finish, type SourceDependencies, type Collected } from './types.ts';

export type LobstersSource = { type: 'lobsters'; queries: string[]; lookbackDays: number; maxPages: number; maxThreads: number; maxComments: number };
const id = z.string().regex(/^[a-z0-9]{6}$/);
const time = z.string().refine(s => Number.isFinite(Date.parse(s)), 'invalid timestamp');
const comment = z.object({ short_id:id, created_at:time, parent_comment:id.nullable(), commenting_user:z.string().min(1), comment:z.string(), is_deleted:z.boolean(), is_moderated:z.boolean() });
const thread = z.object({ short_id:id, title:z.string().min(1), created_at:time, description:z.string(), submitter_user:z.string().min(1), comment_count:z.number().int().nonnegative(), comments:z.array(comment) });

// Search is newest-first across comments, independently of parent topic/date. A
// complete recent prefix suffices; unread older pages cannot enter that window.
export async function collectLobsters(source: LobstersSource, dependencies: SourceDependencies): Promise<Collected> {
  const upper = (dependencies.now ?? (() => new Date()))().getTime() / 1000;
  const lower = upper - source.lookbackDays * 86400;
  const matches = new Map<string, Set<string>>();
  for (const query of source.queries) {
    let previous = Infinity;
    let total: number | undefined;
    const seen = new Set<string>();
    let complete = false;
    for (let page = 1; page <= source.maxPages; page++) {
      const url = new URL('https://lobste.rs/search');
      for (const [k,v] of Object.entries({q:query,what:'comments',order:'newest',page:String(page)})) url.searchParams.set(k,v);
      const {text} = await fetchText(url.href, dependencies, undefined, 'text/html');
      const $ = load(text);
      if ($('input[name="what"][value="comments"][checked]').length !== 1 || $('input[name="order"][value="newest"][checked]').length !== 1) throw new Error('Lobsters search mode missing');
      const count = /^\s*(\d+) results? for\s*$/.exec($('.searchresults summary .heading').text());
      if (!count) throw new Error('Lobsters search count missing');
      const currentTotal = Number(count[1]);
      if (total !== undefined && currentTotal !== total) throw new Error('Lobsters search count drift');
      total = currentTotal;
      const rows = $('.comment[data-shortid]').toArray();
      if (rows.length === 0 && total !== 0) throw new Error('Lobsters search page missing');
      for (const element of rows) {
        const row = $(element);
        const cid = id.parse(row.attr('data-shortid'));
        const stamp = row.find('.byline time').attr('data-at-unix');
        if (!stamp || !/^\d+$/.test(stamp)) throw new Error('Lobsters comment timestamp missing');
        const at = Number(stamp);
        if (at > previous || seen.has(cid)) throw new Error('Lobsters search order/identity drift');
        previous = at; seen.add(cid);
        const target = /^\/s\/([a-z0-9]{6})(?:\/|$)/.exec(row.find('.byline a[href^="/s/"]').attr('href') ?? '');
        if (!target) throw new Error('Lobsters comment parent missing');
        if (at < lower) { complete = true; continue; }
        if (at > upper) continue;
        const ids = matches.get(target[1]!) ?? new Set<string>();
        ids.add(cid); matches.set(target[1]!,ids);
        if (matches.size > source.maxThreads) throw new Error('Lobsters thread limit exceeded');
      }
      if (seen.size > total) throw new Error('Lobsters search count is inconsistent');
      if (seen.size === total) complete = true;
      if (complete) break;
    }
    if (!complete) throw new Error('Lobsters search pagination limit exceeded');
  }
  const items = [];
  let bytes = 0;
  for (const [tid, hits] of [...matches].sort(([a],[b])=>a.localeCompare(b))) {
    const data = thread.parse(await fetchJson(`https://lobste.rs/s/${tid}.json`, dependencies));
    if (data.short_id !== tid || data.comments.length > source.maxComments || data.comments.filter(c=>!c.is_deleted && !c.is_moderated).length !== data.comment_count) throw new Error(`Lobsters thread ${tid} identity/count incomplete (${data.comments.length}/${data.comment_count})`);
    const ids = new Set(data.comments.map(c=>c.short_id));
    if (ids.size !== data.comments.length || [...hits].some(cid=>!ids.has(cid)) || data.comments.some(c=>c.parent_comment !== null && !ids.has(c.parent_comment))) throw new Error('Lobsters thread comments incomplete');
    const comments = data.comments.sort((a,b)=>a.short_id.localeCompare(b.short_id)).map(c=>({ id:c.short_id, parentId:c.parent_comment, author:c.commenting_user, publishedAt:c.created_at, body:c.comment, deleted:c.is_deleted, moderated:c.is_moderated, url:`https://lobste.rs/c/${c.short_id}` }));
    const item = {id:`lobsters:${tid}`,title:data.title,url:`https://lobste.rs/s/${tid}`,publishedAt:data.created_at,data:{author:data.submitter_user,body:data.description,comments}};
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > 16*1024*1024) throw new Error("Lobsters collection exceeded its byte limit");
    items.push(item);
  }
  return finish(items, dependencies);
}
