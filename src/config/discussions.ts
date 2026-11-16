import { z } from 'zod';
const queries = z.array(z.string().trim().min(1).max(200)).min(1).max(50);
const lookbackDays = z.number().int().min(1).max(30).default(7);
const maxPages = z.number().int().min(1).max(100).default(20);
const maxThreads = z.number().int().min(1).max(100).default(100);
const maxComments = z.number().int().min(1).max(10000).default(2000);
export const hnDiscussionsSourceSchema = z.object({type:z.literal('hn_discussions'),queries,lookbackDays,perPage:z.number().int().min(1).max(100).default(100),maxPages,maxThreads,maxComments}).strict();
export const lobstersSourceSchema = z.object({type:z.literal('lobsters'),queries,lookbackDays,maxPages,maxThreads,maxComments}).strict();
export const discourseSourceSchema = z.object({
  type:z.literal('discourse'),
  unavailablePosts:z.enum(['reject','mark']).default('reject'),
  url:z.url().refine(value => { const u=new URL(value); return u.protocol==='https:' && !u.username && !u.password && u.pathname==='/' && !u.search && !u.hash; },'use a public HTTPS origin'),
  queries:queries.refine(values => values.every(q=>! /\b(?:after|before|order|in):/i.test(q)), 'date/order/scope filters belong to the adapter'),
  lookbackDays,maxPages,maxTopics:maxThreads,maxPosts:maxComments,
}).strict();
export const xDiscussionsSourceSchema = z.object({type:z.literal('x_discussions'),query:z.string().trim().min(1).max(1000),maxPages:z.number().int().min(1).max(100).default(30)}).strict();

export const redditDiscussionsSourceSchema = z.object({type:z.literal('reddit_discussions'),subreddit:z.string().regex(/^[A-Za-z0-9_]{2,21}$/),context:z.enum(['feed','thread']).default('thread'),keywords:queries,lookbackDays,limit:z.number().int().min(1).max(100).default(100),maxThreads}).strict();
