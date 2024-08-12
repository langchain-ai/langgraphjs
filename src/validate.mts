import { z } from "zod";

export const AssistantConfigurable = z
  .object({
    thread_id: z.string().optional(),
    thread_ts: z.string().optional(),
  })
  .catchall(z.unknown());

export const AssistantConfig = z
  .object({
    tags: z.array(z.string()).optional(),
    recursion_limit: z.number().int().optional(),
    configurable: AssistantConfigurable.optional(),
  })
  .describe("The configuration of an assistant.");

export const Assistant = z.object({
  assistant_id: z.string().uuid(),
  graph_id: z.string(),
  config: AssistantConfig,
  created_at: z.string(),
  updated_at: z.string(),
  metadata: z.object({}).catchall(z.any()),
});

export const AssistantCreate = z
  .object({
    assistant_id: z
      .string()
      .uuid()
      .describe("The ID of the assistant. If not provided, an ID is generated.")
      .optional(),
    graph_id: z.string().describe("The graph to use."),
    config: AssistantConfig.optional(),
    metadata: z
      .object({})
      .catchall(z.any())
      .describe("Metadata for the assistant.")
      .optional(),
    if_exists: z
      .union([z.literal("raise"), z.literal("do_nothing")])
      .optional(),
  })
  .describe("Payload for creating an assistant.");

export const AssistantPatch = z
  .object({
    graph_id: z.string().describe("The graph to use.").optional(),
    config: AssistantConfig.optional(),
    metadata: z
      .object({})
      .catchall(z.any())
      .describe("Metadata to merge with existing assistant metadata.")
      .optional(),
  })
  .describe("Payload for updating an assistant.");

export const Config = z.object({
  tags: z.array(z.string()).optional(),
  recursion_limit: z.number().int().optional(),
  configurable: z.object({}).catchall(z.any()).optional(),
});

export const Cron = z.object({
  cron_id: z.string().uuid(),
  thread_id: z.string().uuid(),
  end_time: z.string(),
  schedule: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  payload: z.object({}).catchall(z.any()),
});

export const CronCreate = z
  .object({
    assistant_id: z.string().uuid(),
    checkpoint_id: z.string().optional(),
    input: z
      .union([
        z.array(z.object({}).catchall(z.any())),
        z.object({}).catchall(z.any()),
      ])
      .optional(),
    metadata: z
      .object({})
      .catchall(z.any())
      .describe("Metadata for the run.")
      .optional(),
    config: AssistantConfig.optional(),
    webhook: z.string().url().min(1).max(65536).optional(),
    interrupt_before: z.union([z.enum(["*"]), z.array(z.string())]).optional(),
    interrupt_after: z.union([z.enum(["*"]), z.array(z.string())]).optional(),
    multitask_strategy: z
      .enum(["reject", "rollback", "interrupt", "enqueue"])
      .optional(),
  })
  .describe("Payload for creating a cron.");

export const CronSearch = z
  .object({
    assistant_id: z.string().uuid().optional(),
    thread_id: z.string().uuid().optional(),
    limit: z
      .number()
      .int()
      .gte(1)
      .lte(1000)
      .describe("Maximum number to return.")
      .optional(),
    offset: z
      .number()
      .int()
      .gte(0)
      .describe("Offset to start from.")
      .optional(),
  })
  .describe("Payload for listing crons");

export const GraphSchema = z.object({
  graph_id: z.string(),
  input_schema: z.object({}).catchall(z.any()).optional(),
  output_schema: z.object({}).catchall(z.any()).optional(),
  state_schema: z.object({}).catchall(z.any()),
  config_schema: z.object({}).catchall(z.any()),
});

export const Run = z.object({
  run_id: z.string().uuid(),
  thread_id: z.string().uuid(),
  assistant_id: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  status: z.enum([
    "pending",
    "running",
    "error",
    "success",
    "timeout",
    "interrupted",
  ]),
  metadata: z.object({}).catchall(z.any()),
  kwargs: z.object({}).catchall(z.any()),
  multitask_strategy: z.enum(["reject", "rollback", "interrupt", "enqueue"]),
});

export const RunCreate = z
  .object({
    assistant_id: z.union([z.string().uuid(), z.string()]),
    checkpoint_id: z.string().optional(),
    input: z
      .union([
        z.array(z.object({}).catchall(z.any())),
        z.object({}).catchall(z.any()),
        z.null(),
      ])
      .optional(),
    metadata: z
      .object({})
      .catchall(z.any())
      .describe("Metadata for the run.")
      .optional(),
    config: AssistantConfig.optional(),
    webhook: z.string().url().min(1).max(65536).optional(),
    interrupt_before: z.union([z.enum(["*"]), z.array(z.string())]).optional(),
    interrupt_after: z.union([z.enum(["*"]), z.array(z.string())]).optional(),
    multitask_strategy: z
      .enum(["reject", "rollback", "interrupt", "enqueue"])
      .optional(),
  })
  .describe("Payload for creating a run.");

export const RunBatchCreate = z
  .array(RunCreate)
  .min(1)
  .describe("Payload for creating a batch of runs.");

export const RunStream = z
  .object({
    assistant_id: z.union([z.string().uuid(), z.string()]),
    checkpoint_id: z.string().optional(),
    input: z
      .union([
        z.array(z.object({}).catchall(z.any())),
        z.object({}).catchall(z.any()),
        z.null(),
      ])
      .optional(),
    metadata: z
      .object({})
      .catchall(z.any())
      .describe("Metadata for the run.")
      .optional(),
    config: AssistantConfig.optional(),
    webhook: z.string().url().min(1).max(65536).optional(),
    interrupt_before: z.union([z.enum(["*"]), z.array(z.string())]).optional(),
    interrupt_after: z.union([z.enum(["*"]), z.array(z.string())]).optional(),
    multitask_strategy: z
      .enum(["reject", "rollback", "interrupt", "enqueue"])
      .optional(),
    stream_mode: z
      .union([
        z.array(z.enum(["values", "messages", "updates", "events", "debug"])),
        z.enum(["values", "messages", "updates", "events", "debug"]),
      ])
      .optional(),
    feedback_keys: z.array(z.string()).optional(),
  })
  .describe("Payload for creating a streaming run.");

export const SearchResult = z
  .object({
    metadata: z
      .object({})
      .catchall(z.any())
      .describe("Metadata to search for.")
      .optional(),
    limit: z
      .number()
      .int()
      .gte(1)
      .lte(1000)
      .describe("Maximum number to return.")
      .optional(),
    offset: z
      .number()
      .int()
      .gte(0)
      .describe("Offset to start from.")
      .optional(),
  })
  .describe("Payload for listing runs.");

export const AssistantSearchRequest = z
  .object({
    metadata: z
      .object({})
      .catchall(z.any())
      .describe("Metadata to search for.")
      .optional(),
    graph_id: z.string().describe("Filter by graph ID.").optional(),
    limit: z
      .number()
      .int()
      .gte(1)
      .lte(1000)
      .describe("Maximum number to return.")
      .optional(),
    offset: z
      .number()
      .int()
      .gte(0)
      .describe("Offset to start from.")
      .optional(),
  })
  .describe("Payload for listing assistants.");

export const ThreadSearchRequest = z
  .object({
    metadata: z
      .record(z.unknown())
      .describe("Metadata to search for.")
      .optional(),
    status: z
      .enum(["idle", "busy", "interrupted"])
      .describe("Filter by thread status.")
      .optional(),
    limit: z
      .number()
      .int()
      .gte(1)
      .lte(1000)
      .describe("Maximum number to return.")
      .optional(),
    offset: z
      .number()
      .int()
      .gte(0)
      .describe("Offset to start from.")
      .optional(),
  })
  .describe("Payload for listing threads.");

export const Thread = z.object({
  thread_id: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  metadata: z.record(z.unknown()).optional(),
  status: z.enum(["idle", "busy", "interrupted"]).optional(),
});

export const ThreadCreate = z
  .object({
    thread_id: z
      .string()
      .uuid()
      .describe("The ID of the thread. If not provided, an ID is generated.")
      .optional(),
    metadata: z
      .object({})
      .catchall(z.any())
      .describe("Metadata for the thread.")
      .optional(),
    if_exists: z
      .union([z.literal("raise"), z.literal("do_nothing")])
      .optional(),
  })
  .describe("Payload for creating a thread.");

export const ThreadPatch = z
  .object({
    metadata: z
      .object({})
      .catchall(z.any())
      .describe("Metadata to merge with existing thread metadata.")
      .optional(),
  })
  .describe("Payload for patching a thread.");

export const ThreadState = z.object({
  values: z.union([
    z.array(z.object({}).catchall(z.any())),
    z.object({}).catchall(z.any()),
  ]),
  next: z.array(z.string()),
  checkpoint_id: z.string(),
  metadata: z.object({}).catchall(z.any()),
  created_at: z.string(),
  parent_checkpoint_id: z.string(),
});

export const ThreadStatePatch = z
  .object({ metadata: z.object({}).catchall(z.any()) })
  .describe("Payload for patching state of a thread.");

export const ThreadStateSearch = z.object({
  limit: z
    .number()
    .int()
    .gte(1)
    .lte(1000)
    .describe("The maximum number of states to return.")
    .optional(),
  before: z
    .string()
    .describe("Return states before this checkpoint ID.")
    .optional(),
  metadata: z
    .object({})
    .catchall(z.any())
    .describe("Filter states by metadata key-value pairs.")
    .optional(),
});

export const ThreadStateUpdate = z
  .object({
    values: z
      .union([
        z.array(z.object({}).catchall(z.any())),
        z.object({}).catchall(z.any()),
        z.null(),
      ])
      .optional(),
    checkpoint_id: z.string().optional(),
    as_node: z.string().optional(),
  })
  .describe("Payload for adding state to a thread.");
