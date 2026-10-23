import { z } from "zod";

export const sel4NewsSourceSchema = z.object({ type: z.literal("sel4_news") }).strict();
export type Sel4NewsSource = z.infer<typeof sel4NewsSourceSchema>;
