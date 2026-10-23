import { z } from "zod";

const pagination = {
  perPage: z.number().int().min(1).max(1_000).optional(),
  maxPages: z.number().int().min(1).max(100).optional(),
};
const query = z.string().trim().min(1).max(2_000);
const filterValue = z.union([
  z.string().trim().min(1).max(1_000).regex(/^[^,\u0000-\u001f\u007f]+$/u),
  z.number().finite(), z.boolean(),
]);

export const crossrefSourceSchema = z.object({
  type: z.literal("crossref"), query,
  filter: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/).refine(name => name !== "until-index-date", "until-index-date is reserved for the frozen scan bound"), filterValue).optional(),
  ...pagination,
}).strict();

export const arxivSourceSchema = z.object({ type: z.literal("arxiv"), query, ...pagination }).strict();

export type CrossrefSource = z.infer<typeof crossrefSourceSchema>;
export type ArxivSource = z.infer<typeof arxivSourceSchema>;
