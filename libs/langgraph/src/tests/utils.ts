/* eslint-disable no-promise-executor-return */
/* eslint-disable import/no-extraneous-dependencies */
import { expect, it } from "vitest";
import { Graph as DrawableGraph } from "@langchain/core/runnables/graph";
import {
  AIMessage,
  HumanMessage,
  BaseMessageFields,
  AIMessageChunk,
  AIMessageFields,
  ToolMessage,
  FunctionMessage,
  ToolMessageFields,
  MessageStructure,
  FunctionMessageFields,
} from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { Tool } from "@langchain/core/tools";
import {
  MemorySaver,
  Checkpoint,
  CheckpointMetadata,
  PendingWrite,
  CacheFullKey,
  InMemoryCache,
} from "@langchain/langgraph-checkpoint";
import { z } from "zod";
import { BaseTracer, Run } from "@langchain/core/tracers/base";
import { Pregel, PregelInputType, PregelOutputType } from "../pregel/index.js";
import { StrRecord } from "../pregel/algo.js";
import { PregelNode } from "../pregel/read.js";
import { BaseChannel, LangGraphRunnableConfig } from "../web.js";

export class MemorySaverAssertImmutable extends MemorySaver {
  storageForCopies: Record<string, Record<string, Uint8Array>> = {};

  constructor() {
    super();
    this.storageForCopies = {};
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const thread_id = config.configurable?.thread_id;
    this.storageForCopies[thread_id] ??= {};

    // assert checkpoint hasn't been modified since last written
    const saved = await this.get(config);
    if (saved) {
      const savedId = saved.id;
      if (this.storageForCopies[thread_id][savedId]) {
        const loaded = await this.serde.loadsTyped(
          "json",
          this.storageForCopies[thread_id][savedId]
        );

        expect(
          saved,
          `Checkpoint [${savedId}] has been modified since last written`
        ).toEqual(loaded);
      }
    }
    const [, serializedCheckpoint] = await this.serde.dumpsTyped(checkpoint);
    // save a copy of the checkpoint
    this.storageForCopies[thread_id][checkpoint.id] = serializedCheckpoint;

    return super.put(config, checkpoint, metadata);
  }
}

export class SlowInMemoryCache extends InMemoryCache {
  async get(keys: CacheFullKey[]) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return super.get(keys);
  }

  async set(
    pairs: {
      key: CacheFullKey;
      value: unknown;
      ttl?: number;
    }[]
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return super.set(pairs);
  }
}

export class MemorySaverAssertImmutableSlow extends MemorySaverAssertImmutable {
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return super.put(config, checkpoint, metadata);
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return super.putWrites(config, writes, taskId);
  }
}

export class FakeSearchTool extends Tool {
  name = "search_api";

  description = "A simple API that returns the input string.";

  schema = z
    .object({
      input: z.string().optional(),
    })
    .transform((data) => data.input);

  constructor() {
    super();
  }

  async _call(query: string): Promise<string> {
    return `result for ${query}`;
  }
}

class AnyStringSame {
  $$typeof = Symbol.for("jest.asymmetricMatcher");

  private lastValue: string | undefined = undefined;

  private key: string;

  constructor(key: string) {
    this.key = key;
  }

  asymmetricMatch(other: unknown) {
    // eslint-disable-next-line no-instanceof/no-instanceof
    if (!(typeof other === "string" || other instanceof String)) {
      return false;
    }

    if (this.lastValue != null && this.lastValue !== other) {
      return false;
    }

    this.lastValue = other as string;
    return true;
  }

  toString() {
    return "AnyStringSame";
  }

  getExpectedType() {
    return "string";
  }

  toAsymmetricMatcher() {
    if (this.lastValue != null)
      return `AnyStringSame<${this.key}, ${this.lastValue}>`;
    return `AnyStringSame<${this.key}>`;
  }
}

export const createAnyStringSame = () => {
  const memory = new Map<string, AnyStringSame>();

  return (key: string) => {
    if (!memory.has(key)) memory.set(key, new AnyStringSame(key));
    return memory.get(key);
  };
};

export class FakeTracer extends BaseTracer {
  runs: Run[] = [];

  name = "fake_tracer";

  protected async persistRun(run: Run): Promise<void> {
    this.runs.push(run);
  }
}

export class _AnyIdHumanMessage extends HumanMessage {
  get lc_id() {
    return ["langchain_core", "messages", "HumanMessage"];
  }

  constructor(fields: BaseMessageFields | string) {
    let fieldsWithJestMatcher: Partial<BaseMessageFields> = {
      id: expect.any(String) as unknown as string,
    };
    if (typeof fields === "string") {
      fieldsWithJestMatcher = {
        content: fields,
        ...fieldsWithJestMatcher,
      };
    } else {
      fieldsWithJestMatcher = {
        ...fields,
        ...fieldsWithJestMatcher,
      };
    }
    super(fieldsWithJestMatcher as BaseMessageFields);
  }
}

export class _AnyIdAIMessage extends AIMessage {
  get lc_id() {
    return ["langchain_core", "messages", "AIMessage"];
  }

  constructor(fields: AIMessageFields | string) {
    let fieldsWithJestMatcher: Partial<AIMessageFields> = {
      id: expect.any(String) as unknown as string,
    };
    if (typeof fields === "string") {
      fieldsWithJestMatcher = {
        content: fields,
        ...fieldsWithJestMatcher,
      };
    } else {
      fieldsWithJestMatcher = {
        ...fields,
        ...fieldsWithJestMatcher,
      };
    }
    super(fieldsWithJestMatcher as AIMessageFields);
  }
}

export class _AnyIdToolMessage extends ToolMessage {
  get lc_id() {
    return ["langchain_core", "messages", "ToolMessage"];
  }

  constructor(fields: ToolMessageFields<MessageStructure>) {
    super({
      id: expect.any(String) as unknown as string,
      ...fields,
    });
  }
}

export class _AnyIdFunctionMessage extends FunctionMessage {
  get lc_id() {
    return ["langchain_core", "messages", "FunctionMessage"];
  }

  constructor(fields: FunctionMessageFields<MessageStructure>) {
    super({
      id: expect.any(String) as unknown as string,
      ...fields,
    });
  }
}

export class _AnyIdAIMessageChunk extends AIMessageChunk {
  get lc_id() {
    return ["langchain_core", "messages", "AIMessageChunk"];
  }

  constructor(fields: AIMessageFields | string) {
    let fieldsWithJestMatcher: Partial<AIMessageFields> = {
      id: expect.any(String) as unknown as string,
    };
    if (typeof fields === "string") {
      fieldsWithJestMatcher = {
        content: fields,
        ...fieldsWithJestMatcher,
      };
    } else {
      fieldsWithJestMatcher = {
        ...fields,
        ...fieldsWithJestMatcher,
      };
    }
    super(fieldsWithJestMatcher as AIMessageFields);
  }
}

export function skipIf(condition: () => boolean): typeof it | typeof it.skip {
  if (condition()) {
    return it.skip;
  } else {
    return it;
  }
}

export async function dumpDebugStream<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ContextType extends Record<string, any> = StrRecord<string, any>,
  InputType = PregelInputType,
  OutputType = PregelOutputType
>(
  graph: Pregel<Nn, Cc, ContextType, InputType, OutputType>,
  input: InputType,
  config: LangGraphRunnableConfig<ContextType>
) {
  console.log(`invoking ${graph.name} with arguments ${JSON.stringify(input)}`);
  const stream = await graph.stream(input, {
    ...config,
    subgraphs: true,
    streamMode: ["updates", "debug", "values"],
  });

  let lastStep = 0;
  let lastCheckpointRef: {
    checkpoint_id: string;
    checkpoint_ns: string;
    thread_id: string;
  } = { checkpoint_id: "", checkpoint_ns: "", thread_id: "" };

  let invokeReturnValue;

  for await (const value of stream) {
    if (value[1] === "updates") {
      invokeReturnValue = value[2].payload;
      continue;
    }

    if (value[1] === "values") {
      const vals = value[2];
      console.log(
        `step ${lastStep} finished with state ${JSON.stringify(vals, null, 2)}`
      );
      console.log();
    }

    if (value[1] === "debug") {
      const { type, step, /* timestamp, */ payload } = value[2];

      if (value[2].type === "checkpoint") {
        const { configurable } = value[2].payload.config;
        lastCheckpointRef = configurable;
        continue;
      }

      lastStep = step;

      if (type === "task") {
        const { /* id, */ name, input, triggers /* interrupts */ } = payload;
        console.log(
          `step ${step}: starting ${name} triggered by ${JSON.stringify(
            triggers
          )} with inputs ${JSON.stringify(input)}`
        );
      }
      if (type === "task_result") {
        const { /* id , */ name, result /* interrupts */ } = payload;
        console.log(
          `step ${step}: task ${name} returned ${JSON.stringify(result)}`
        );
      }
    }
  }

  console.log(
    `graph execution finished - returned: ${JSON.stringify(
      invokeReturnValue,
      null,
      2
    )}`
  );

  const graphState = await graph.getState({
    configurable: lastCheckpointRef,
  });

  console.log();
  console.log(`final state: ${JSON.stringify(graphState.values, null, 2)}`);
  return invokeReturnValue as ReturnType<typeof graph.invoke>;
}

export function getReadableMermaid(graph: DrawableGraph) {
  const mermaid = graph.drawMermaid({ withStyles: false });
  return mermaid
    .replace(/\s*&nbsp;(.*)&nbsp;\s*/g, "[$1]")
    .split("\n")
    .slice(1)
    .map((i) => {
      const res = i.trim();
      if (res.endsWith(";")) return res.slice(0, -1);
      return res;
    })
    .filter(Boolean);
}
