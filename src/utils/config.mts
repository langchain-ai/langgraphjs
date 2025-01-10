import { z } from "zod";

const IndexConfigSchema = z.object({
  dims: z.number().optional(),
  embed: z.string().optional(),
  fields: z.array(z.string()).optional(),
});

const StoreConfigSchema = z.object({
  index: IndexConfigSchema.optional(),
});

export const ConfigSchema = z.object({
  graphs: z.record(z.string()).default({}),
  env: z
    .union([z.array(z.string()), z.record(z.string()), z.string()])
    .default({}),
  store: StoreConfigSchema.optional(),
});
