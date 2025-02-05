# @langchain/langgraph-checkpoint-supabase

Implementation of a [LangGraph.js](https://github.com/langchain-ai/langgraphjs) CheckpointSaver that uses the Supabase JS SDK.

## Setup

Create the following tables in your Supabase database, you can change the table names if required when also setting the `checkPointTable` and `writeTable` options of the `SupabaseSaver` class.

> [!CAUTION]
> Make sure to enable RLS policies on the tables!

```sql
create table
  public.langgraph_checkpoints (
    thread_id text not null,
    created_at timestamp with time zone not null default now(),
    checkpoint_ns text not null default '',
    checkpoint_id text not null,
    parent_checkpoint_id text null,
    type text null,
    checkpoint jsonb null,
    metadata jsonb null,
    constraint langgraph_checkpoints_pkey primary key (thread_id, checkpoint_ns, checkpoint_id)
  ) tablespace pg_default;

create table
  public.langgraph_writes (
    thread_id text not null,
    created_at timestamp with time zone not null default now(),
    checkpoint_ns text not null default '',
    checkpoint_id text not null,
    task_id text not null,
    idx bigint not null,
    channel text not null,
    type text null,
    value jsonb null,
    constraint langgraph_writes_pkey primary key (
      thread_id,
      checkpoint_ns,
      checkpoint_id,
      task_id,
      idx
    )
  ) tablespace pg_default;

--- Important to disable public access to the tables!
alter table "langgraph_checkpoints" enable row level security;
alter table "langgraph_writes" enable row level security;
```

## Usage

```ts
import { SqliteSaver } from "@langchain/langgraph-checkpoint-supabase";

const writeConfig = {
  configurable: {
    thread_id: "1",
    checkpoint_ns: ""
  }
};
const readConfig = {
  configurable: {
    thread_id: "1"
  }
};

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);
const checkpointer = new SupabaseSaver(supabaseClient, {
    checkPointTable: "langgraph_checkpoints",
    writeTable: "langgraph_writes",
});

const checkpoint = {
  v: 1,
  ts: "2024-07-31T20:14:19.804150+00:00",
  id: "1ef4f797-8335-6428-8001-8a1503f9b875",
  channel_values: {
    my_key: "meow",
    node: "node"
  },
  channel_versions: {
    __start__: 2,
    my_key: 3,
    start:node: 3,
    node: 3
  },
  versions_seen: {
    __input__: {},
    __start__: {
      __start__: 1
    },
    node: {
      start:node: 2
    }
  },
  pending_sends: [],
}

// store checkpoint
await checkpointer.put(writeConfig, checkpoint, {}, {})

// load checkpoint
await checkpointer.get(readConfig)

// list checkpoints
for await (const checkpoint of checkpointer.list(readConfig)) {
  console.log(checkpoint);
}
```
