import { z } from "zod";

import type { htmlSourceSchema } from "./schema.ts";

export const PLAYWRIGHT_DEFAULTS = {
  timeoutMs: 15_000,
  maxRequests: 100,
  maxResponseBytes: 4_194_304,
  maxTotalBytes: 16_777_216,
} as const;

export function createPlaywrightSourceSchema(html: typeof htmlSourceSchema) {
  return z.object({
    type: z.literal("playwright"),
    url: html.shape.url,
    itemSelector: html.shape.itemSelector,
    fields: html.shape.fields,
    waitForSelector: z.string().trim().min(1).max(1_000),
    timeoutMs: z.number().int().min(1).max(60_000).default(PLAYWRIGHT_DEFAULTS.timeoutMs),
    maxRequests: z.number().int().min(1).max(500).default(PLAYWRIGHT_DEFAULTS.maxRequests),
    maxResponseBytes: z.number().int().min(1).max(16_777_216).default(PLAYWRIGHT_DEFAULTS.maxResponseBytes),
    maxTotalBytes: z.number().int().min(1).max(67_108_864).default(PLAYWRIGHT_DEFAULTS.maxTotalBytes),
  }).strict().superRefine((value, context) => {
    const result = html.safeParse({ type: "html", url: value.url, itemSelector: value.itemSelector, fields: value.fields });
    if (!result.success) for (const issue of result.error.issues) context.addIssue({ code: "custom", message: issue.message, path: issue.path });
  });
}

export type PlaywrightSource = z.infer<ReturnType<typeof createPlaywrightSourceSchema>>;
