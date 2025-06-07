/* eslint-disable no-process-env */
/* eslint-disable no-promise-executor-return */
/* eslint-disable no-instanceof/no-instanceof */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable import/no-extraneous-dependencies */
/* eslint-disable prefer-template */
/* eslint-disable no-param-reassign */
import {
  it,
  expect,
  vi,
  describe,
  beforeAll,
  beforeEach,
  test,
  afterAll,
} from "vitest";
import {
  RunnableConfig,
  RunnableLambda,
  RunnablePassthrough,
} from "@langchain/core/runnables";
import { AgentAction, AgentFinish } from "@langchain/core/agents";
import { PromptTemplate } from "@langchain/core/prompts";
import { FakeStreamingLLM } from "@langchain/core/utils/testing";
import { tool, Tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  AIMessage,
  BaseMessage,
  FunctionMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ToolCall } from "@langchain/core/messages/tool";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import {
  BaseCheckpointSaver,
  BaseStore,
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  InMemoryCache,
  InMemoryStore,
  PendingWrite,
  uuid5,
  uuid6,
} from "@langchain/langgraph-checkpoint";

import {
  _AnyIdAIMessage,
  _AnyIdAIMessageChunk,
  _AnyIdFunctionMessage,
  _AnyIdHumanMessage,
  _AnyIdToolMessage,
  createAnyStringSame,
  FakeChatModel,
  FakeTracer,
  MemorySaverAssertImmutable,
  SlowInMemoryCache,
} from "./utils.js";
import { gatherIterator } from "../utils.js";
import { LastValue } from "../channels/last_value.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import {
  Annotation,
  Graph,
  StateGraph,
  StateGraphArgs,
  StateType,
} from "../graph/index.js";
import { Topic } from "../channels/topic.js";
import { PregelNode } from "../pregel/read.js";
import { BaseChannel } from "../channels/base.js";
import { BinaryOperatorAggregate } from "../channels/binop.js";
import { Channel, Pregel, PregelOptions } from "../pregel/index.js";
import {
  _applyWrites,
  _localRead,
  _prepareNextTasks,
  increment,
  shouldInterrupt,
} from "../pregel/algo.js";
import { ToolExecutor, createAgentExecutor } from "../prebuilt/index.js";
import { MessageGraph, messagesStateReducer } from "../graph/message.js";
import { PASSTHROUGH } from "../pregel/write.js";
import { StateSnapshot } from "../pregel/types.js";
import {
  GraphRecursionError,
  InvalidUpdateError,
  NodeInterrupt,
} from "../errors.js";
import {
  isCommand,
  Command,
  END,
  INTERRUPT,
  PULL,
  PUSH,
  Send,
  START,
  TAG_NOSTREAM,
  isInterrupted,
} from "../constants.js";
import { ManagedValueMapping } from "../managed/base.js";
import { SharedValue } from "../managed/shared_value.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";
import { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";
import { interrupt } from "../interrupt.js";
import {
  getConfigTypeSchema,
  getInputTypeSchema,
  getOutputTypeSchema,
  getStateTypeSchema,
  getUpdateTypeSchema,
} from "../graph/zod/schema.js";
import "../graph/zod/plugin.js";

expect.extend({
  toHaveKeyStartingWith(received: object, prefix: string) {
    const pass = Object.keys(received).some((key) => key.startsWith(prefix));
    if (pass) {
      return {
        message: () =>
          `expected object to not have key starting with ${prefix}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected object to have key starting with ${prefix}`,
        pass: false,
      };
    }
  },
});

export function runPregelTests(
  createCheckpointer: () => BaseCheckpointSaver | Promise<BaseCheckpointSaver>,
  teardown?: () => any
) {
  if (teardown !== undefined) {
    afterAll(teardown);
  }

  beforeAll(() => {
    // Will occur naturally if user imports from main `@langchain/langgraph` endpoint.
    initializeAsyncLocalStorageSingleton();
  });

  describe("Channel", () => {
    it("obtain correct channel values from checkpointer", async () => {
      const checkpointer = await createCheckpointer();
      const chain = Channel.subscribeTo("input").pipe(
        Channel.writeTo(["output"])
      );
      const app = new Pregel({
        nodes: { one: chain },
        channels: {
          ephemeral: new EphemeralValue(),
          input: new LastValue<number>(),
          output: new LastValue<number>(),
        },
        inputChannels: ["input", "ephemeral"],
        outputChannels: "output",
        checkpointer,
      });

      const input = { input: 1, ephemeral: "meow" };
      const config = { configurable: { thread_id: "1" } };
      await app.invoke(input, config);
      const state = await app.getState(config);

      expect(state.values.output).toBe(1);

      const checkpoint = await checkpointer.get(config);
      expect(checkpoint?.channel_values).toEqual({
        input: 1,
        output: 1,
      });
    });

    describe("writeTo", () => {
      it("should return a ChannelWrite instance with the expected writes", () => {
        // call method / assertions
        const channelWrite = Channel.writeTo(["foo", "bar"], {
          fixed: 6,
          func: () => 42,
          runnable: new RunnablePassthrough(),
        });

        expect(channelWrite.writes.length).toBe(5);
        expect(channelWrite.writes[0]).toEqual({
          channel: "foo",
          value: PASSTHROUGH,
          skipNone: false,
        });
        expect(channelWrite.writes[1]).toEqual({
          channel: "bar",
          value: PASSTHROUGH,
          skipNone: false,
        });
        expect(channelWrite.writes[2]).toEqual({
          channel: "fixed",
          value: 6,
          skipNone: false,
        });
        // TODO: Figure out how to assert the mapper value
        // expect(channelWrite.writes[3]).toEqual({
        //   channel: "func",
        //   value: PASSTHROUGH,
        //   skipNone: true,
        //   mapper: new RunnableLambda({ func: () => 42}),
        // });
        expect(channelWrite.writes[4]).toEqual({
          channel: "runnable",
          value: PASSTHROUGH,
          skipNone: true,
          mapper: new RunnablePassthrough(),
        });
      });
    });
  });

  describe("Pregel", () => {
    describe("checkpoint error handling", () => {
      it("should catch checkpoint errors", async () => {
        class FaultyGetCheckpointer extends MemorySaverAssertImmutable {
          async getTuple(): Promise<CheckpointTuple> {
            throw new Error("Faulty get_tuple");
          }
        }

        class FaultyPutCheckpointer extends MemorySaverAssertImmutable {
          async put(): Promise<RunnableConfig> {
            throw new Error("Faulty put");
          }
        }

        class FaultyPutWritesCheckpointer extends MemorySaverAssertImmutable {
          async putWrites(): Promise<void> {
            throw new Error("Faulty put_writes");
          }
        }

        class FaultyVersionCheckpointer extends MemorySaverAssertImmutable {
          getNextVersion(): number {
            throw new Error("Faulty get_next_version");
          }
        }

        const logic = () => ({ foo: "" });

        const State = Annotation.Root({
          foo: Annotation<string>({
            reducer: (_, b) => b,
          }),
        });
        const builder = new StateGraph(State)
          .addNode("agent", logic)
          .addEdge("__start__", "agent")
          .addEdge("agent", "__end__");
        let graph = builder.compile({
          checkpointer: new FaultyGetCheckpointer(),
        });
        await expect(async () => {
          await graph.invoke({}, { configurable: { thread_id: "1" } });
        }).rejects.toThrowError("Faulty get_tuple");
        graph = builder.compile({
          checkpointer: new FaultyPutCheckpointer(),
        });
        await expect(async () => {
          await graph.invoke({}, { configurable: { thread_id: "1" } });
        }).rejects.toThrowError("Faulty put");
        graph = builder.compile({
          checkpointer: new FaultyVersionCheckpointer(),
        });
        await expect(async () => {
          await graph.invoke({}, { configurable: { thread_id: "1" } });
        }).rejects.toThrowError("Faulty get_next_version");
        const graph2 = new StateGraph(State)
          .addNode("agent", logic)
          .addEdge("__start__", "agent")
          .addEdge("agent", "__end__")
          .addNode("parallel", logic)
          .addEdge("__start__", "parallel")
          .addEdge("parallel", "__end__")
          .compile({
            checkpointer: new FaultyPutWritesCheckpointer(),
          });
        await expect(async () => {
          await graph2.invoke({}, { configurable: { thread_id: "1" } });
        }).rejects.toThrowError("Faulty put_writes");
      });

      it("should wait for slow checkpointer errors", async () => {
        class SlowGetCheckpointer extends MemorySaverAssertImmutable {
          async getTuple(config: RunnableConfig) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (config.configurable?.shouldThrow) {
              throw new Error("Faulty get_tuple");
            }
            return super.getTuple(config);
          }
        }

        class SlowPutCheckpointer extends MemorySaverAssertImmutable {
          async put(
            config: RunnableConfig,
            checkpoint: Checkpoint,
            metadata: CheckpointMetadata
          ) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (config.configurable?.shouldThrow) {
              throw new Error("Faulty put");
            }
            return super.put(config, checkpoint, metadata);
          }
        }

        class SlowPutWritesCheckpointer extends MemorySaverAssertImmutable {
          async putWrites(
            config: RunnableConfig,
            writes: PendingWrite[],
            taskId: string
          ) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (config.configurable?.shouldThrow) {
              throw new Error("Faulty put_writes");
            }
            return super.putWrites(config, writes, taskId);
          }
        }

        const logic = () => ({ foo: "" });

        const State = Annotation.Root({
          foo: Annotation<string>({
            reducer: (_, b) => b,
          }),
        });
        const builder = new StateGraph(State)
          .addNode("agent", logic)
          .addEdge("__start__", "agent")
          .addEdge("agent", "__end__");
        let graph = builder.compile({
          checkpointer: new SlowGetCheckpointer(),
        });
        await expect(async () => {
          await graph.invoke(
            {},
            { configurable: { thread_id: "1", shouldThrow: true } }
          );
        }).rejects.toThrowError("Faulty get_tuple");
        expect(
          await graph.invoke({}, { configurable: { thread_id: "1" } })
        ).toEqual({ foo: "" });
        graph = builder.compile({
          checkpointer: new SlowPutCheckpointer(),
        });
        await expect(async () => {
          await graph.invoke(
            {},
            { configurable: { thread_id: "1", shouldThrow: true } }
          );
        }).rejects.toThrowError("Faulty put");
        expect(
          await graph.invoke({}, { configurable: { thread_id: "1" } })
        ).toEqual({ foo: "" });
        const graph2 = new StateGraph(State)
          .addNode("agent", logic)
          .addEdge("__start__", "agent")
          .addEdge("agent", "__end__")
          .addNode("parallel", logic)
          .addEdge("__start__", "parallel")
          .addEdge("parallel", "__end__")
          .compile({
            checkpointer: new SlowPutWritesCheckpointer(),
          });
        await expect(async () => {
          await graph2.invoke(
            {},
            { configurable: { thread_id: "1", shouldThrow: true } }
          );
        }).rejects.toThrowError("Faulty put_writes");
        expect(
          await graph.invoke({}, { configurable: { thread_id: "1" } })
        ).toEqual({ foo: "" });
      });
    });
    describe("streamChannelsList", () => {
      it("should return the expected list of stream channels", () => {
        // set up test
        const chain = Channel.subscribeTo("input").pipe(
          Channel.writeTo(["output"])
        );

        const pregel1 = new Pregel({
          nodes: { one: chain },
          channels: {
            input: new LastValue<number>(),
            output: new LastValue<number>(),
          },
          inputChannels: "input",
          outputChannels: "output",
          streamChannels: "output",
        });
        const pregel2 = new Pregel({
          nodes: { one: chain },
          channels: {
            input: new LastValue<number>(),
            output: new LastValue<number>(),
          },
          inputChannels: "input",
          outputChannels: "output",
          streamChannels: ["input", "output"],
        });
        const pregel3 = new Pregel({
          nodes: { one: chain },
          channels: {
            input: new LastValue<number>(),
            output: new LastValue<number>(),
          },
          inputChannels: "input",
          outputChannels: "output",
        });

        // call method / assertions
        expect(pregel1.streamChannelsList).toEqual(["output"]);
        expect(pregel2.streamChannelsList).toEqual(["input", "output"]);
        expect(pregel3.streamChannelsList).toEqual(["input", "output"]);
        expect(pregel1.streamChannelsAsIs).toEqual("output");
        expect(pregel2.streamChannelsAsIs).toEqual(["input", "output"]);
        expect(pregel3.streamChannelsAsIs).toEqual(["input", "output"]);
      });
    });

    describe("_defaults", () => {
      it("should return the expected tuple of defaults", async () => {
        // Because the implementation of _defaults() contains independent
        // if-else statements that determine that returned values in the tuple,
        // this unit test can be separated into 2 parts. The first part of the
        // test executes the "true" evaluation path of the if-else statements.
        // The second part evaluates the "false" evaluation path.

        // set up test
        const channels = {
          inputKey: new LastValue(),
          outputKey: new LastValue(),
          channel3: new LastValue(),
        };
        const nodes = {
          one: new PregelNode({
            channels: ["channel3"],
            triggers: ["outputKey"],
          }),
        };

        const config1: PregelOptions<typeof nodes, typeof channels> = {};
        const config2: PregelOptions<typeof nodes, typeof channels> = {
          streamMode: "updates",
          inputKeys: "inputKey",
          outputKeys: "outputKey",
          interruptBefore: "*",
          interruptAfter: ["one"],
          debug: true,
          tags: ["hello"],
        };

        const checkpointer = await createCheckpointer();
        // create Pregel class
        const pregel = new Pregel({
          nodes,
          debug: false,
          inputChannels: "outputKey",
          outputChannels: "outputKey",
          interruptBefore: ["one"],
          interruptAfter: ["one"],
          streamMode: "values",
          channels,
          checkpointer,
        });

        // call method / assertions
        const expectedDefaults1 = [
          false, // debug
          ["values"], // stream mode
          "outputKey", // input keys
          ["inputKey", "outputKey", "channel3"], // output keys,
          {},
          ["one"], // interrupt before
          ["one"], // interrupt after
          checkpointer,
          undefined,
          true,
          undefined,
        ];

        const expectedDefaults2 = [
          true, // debug
          ["updates"], // stream mode
          "inputKey", // input keys
          "outputKey", // output keys
          { tags: ["hello"] },
          "*", // interrupt before
          ["one"], // interrupt after
          checkpointer,
          undefined,
          true,
          undefined,
        ];

        expect(pregel._defaults(config1)).toEqual(expectedDefaults1);
        expect(pregel._defaults(config2)).toEqual(expectedDefaults2);
      });
    });

    describe("stream", () => {
      describe("streamMode: updates", () => {
        it("should return multiple update entries when a task has multiple writes to the same channel", async () => {
          const StateAnnotation = Annotation.Root({
            val: Annotation<string>({
              reducer: (current, added) => `${current ?? ""}${added}`,
              default: () => "",
            }),
          });

          const nodeA = (_state: typeof StateAnnotation.State) => [
            new Command({
              update: { val: "a1" },
            }),
            new Command({
              update: { val: "a2" },
            }),
          ];

          const nodeB = (_state: typeof StateAnnotation.State) => ({
            val: "b",
          });

          const graph = new StateGraph(StateAnnotation)
            .addNode("nodeA", nodeA)
            .addNode("nodeB", nodeB)
            .addEdge(START, "nodeA")
            .addEdge("nodeA", "nodeB")
            .compile();

          expect(await graph.invoke({ val: "" })).toEqual({ val: "a1a2b" });

          const updates = await gatherIterator(
            graph.stream({ val: "" }, { streamMode: "updates" })
          );

          expect(updates).toEqual([
            { nodeA: [{ val: "a1" }, { val: "a2" }] },
            { nodeB: { val: "b" } },
          ]);
        });
      });
    });
  });

  describe("shouldInterrupt", () => {
    it("should return true if any snapshot channel has been updated since last interrupt and any channel written to is in interrupt nodes list", () => {
      // set up test
      const checkpoint: Checkpoint = {
        v: 1,
        id: uuid6(-1),
        ts: "2024-04-19T17:19:07.952Z",
        channel_values: {
          channel1: "channel1value",
        },
        channel_versions: {
          channel1: 2, // current channel version is greater than last version seen
        },
        versions_seen: {
          [INTERRUPT]: {
            channel1: 1,
          },
        },
        pending_sends: [],
      };

      const interruptNodes = ["node1"];

      // call method / assertions
      expect(
        shouldInterrupt(checkpoint, interruptNodes, [
          {
            name: "node1",
            input: undefined,
            proc: new RunnablePassthrough(),
            writes: [],
            triggers: [],
            config: undefined,
            id: uuid5(JSON.stringify(["", {}]), checkpoint.id),
            writers: [],
          },
        ])
      ).toBe(true);
    });

    it("should return true if any snapshot channel has been updated since last interrupt and any channel written to is in interrupt nodes list", () => {
      // set up test
      const checkpoint: Checkpoint = {
        v: 1,
        id: uuid6(-1),
        ts: "2024-04-19T17:19:07.952Z",
        channel_values: {
          channel1: "channel1value",
        },
        channel_versions: {
          channel1: 2, // current channel version is greater than last version seen
        },
        versions_seen: {},
        pending_sends: [],
      };

      const interruptNodes = ["node1"];

      // call method / assertions
      expect(
        shouldInterrupt(checkpoint, interruptNodes, [
          {
            name: "node1",
            input: undefined,
            proc: new RunnablePassthrough(),
            writes: [],
            triggers: [],
            config: undefined,
            id: uuid5(JSON.stringify(["", {}]), checkpoint.id),
            writers: [],
          },
        ])
      ).toBe(true);
    });

    it("should return false if all snapshot channels have not been updated", () => {
      // set up test
      const checkpoint: Checkpoint = {
        v: 1,
        id: uuid6(-1),
        ts: "2024-04-19T17:19:07.952Z",
        channel_values: {
          channel1: "channel1value",
        },
        channel_versions: {
          channel1: 2, // current channel version is equal to last version seen
        },
        versions_seen: {
          __interrupt__: {
            channel1: 2,
          },
        },
        pending_sends: [],
      };

      const interruptNodes = ["node1"];

      // call method / assertions
      expect(
        shouldInterrupt(checkpoint, interruptNodes, [
          {
            name: "node1",
            input: undefined,
            proc: new RunnablePassthrough(),
            writes: [],
            triggers: [],
            config: undefined,
            id: uuid5(JSON.stringify(["", {}]), checkpoint.id),
            writers: [],
          },
        ])
      ).toBe(false);
    });

    it("should return false if all task nodes are not in interrupt nodes", () => {
      // set up test
      const checkpoint: Checkpoint = {
        v: 1,
        id: uuid6(-1),
        ts: "2024-04-19T17:19:07.952Z",
        channel_values: {
          channel1: "channel1value",
        },
        channel_versions: {
          channel1: 2,
        },
        versions_seen: {
          __interrupt__: {
            channel1: 1,
          },
        },
        pending_sends: [],
      };

      const interruptNodes = ["node1"];

      // call method / assertions
      expect(
        shouldInterrupt(checkpoint, interruptNodes, [
          {
            name: "node2", // node2 is not in interrupt nodes
            input: undefined,
            proc: new RunnablePassthrough(),
            writes: [],
            triggers: [],
            config: undefined,
            id: uuid5(JSON.stringify(["", {}]), checkpoint.id),
            writers: [],
          },
        ])
      ).toBe(false);
    });
  });

  describe("_localRead", () => {
    it("should return the channel value when fresh is false", () => {
      // set up test
      const checkpoint: Checkpoint = {
        v: 0,
        id: uuid6(-1),
        ts: "",
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
        pending_sends: [],
      };

      const channel1 = new LastValue<number>();
      const channel2 = new LastValue<number>();
      channel1.update([1]);
      channel2.update([2]);

      const channels: Record<string, BaseChannel> = {
        channel1,
        channel2,
      };
      const managed = new ManagedValueMapping();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const writes: Array<[string, any]> = [];

      // call method / assertions
      expect(
        _localRead(
          0,
          checkpoint,
          channels,
          managed,
          { name: "test", writes, triggers: [] },
          "channel1",
          false
        )
      ).toBe(1);
      expect(
        _localRead(
          0,
          checkpoint,
          channels,
          managed,
          { name: "test", writes, triggers: [] },
          ["channel1", "channel2"],
          false
        )
      ).toEqual({ channel1: 1, channel2: 2 });
    });

    it("should return the channel value after applying writes when fresh is true", () => {
      // set up test
      const checkpoint: Checkpoint = {
        v: 0,
        id: uuid6(-1),
        ts: "",
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
        pending_sends: [],
      };

      const channel1 = new LastValue<number>();
      const channel2 = new LastValue<number>();
      channel1.update([1]);
      channel2.update([2]);

      const channels: Record<string, BaseChannel> = {
        channel1,
        channel2,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const writes: Array<[string, any]> = [
        ["channel1", 100],
        ["channel2", 200],
      ];
      const managed = new ManagedValueMapping();

      // call method / assertions
      expect(
        _localRead(
          0,
          checkpoint,
          channels,
          managed,
          { name: "test", writes, triggers: [] },
          "channel1",
          true
        )
      ).toBe(100);
      expect(
        _localRead(
          0,
          checkpoint,
          channels,
          managed,
          { name: "test", writes, triggers: [] },
          ["channel1", "channel2"],
          true
        )
      ).toEqual({ channel1: 100, channel2: 200 });
    });
  });

  describe("_applyWrites", () => {
    it("should update channels and checkpoints correctly (side effect)", () => {
      // set up test
      const checkpoint: Checkpoint = {
        v: 1,
        id: uuid6(-1),
        ts: "2024-04-19T17:19:07.952Z",
        channel_values: {
          channel1: "channel1value",
        },
        channel_versions: {
          channel1: 2,
          channel2: 5,
        },
        versions_seen: {
          __interrupt__: {
            channel1: 1,
          },
        },
        pending_sends: [],
      };

      const lastValueChannel1 = new LastValue<string>();
      lastValueChannel1.update(["channel1value"]);
      const lastValueChannel2 = new LastValue<string>();
      lastValueChannel2.update(["channel2value"]);
      const channels = {
        channel1: lastValueChannel1,
        channel2: lastValueChannel2,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pendingWrites: Array<[keyof typeof channels, any]> = [
        ["channel1", "channel1valueUpdated!"],
      ];

      // call method / assertions
      expect(channels.channel1.get()).toBe("channel1value");
      expect(channels.channel2.get()).toBe("channel2value");
      expect(checkpoint.channel_versions.channel1).toBe(2);

      _applyWrites(
        checkpoint,
        channels,
        [{ name: "foo", writes: pendingWrites, triggers: [] }],
        increment,
        undefined
      ); // contains side effects

      expect(channels.channel1.get()).toBe("channel1valueUpdated!");
      expect(channels.channel2.get()).toBe("channel2value");
      expect(checkpoint.channel_versions.channel1).toBe(6);
    });

    it("should throw an InvalidUpdateError if there are multiple updates to the same channel", () => {
      // set up test
      const checkpoint: Checkpoint = {
        v: 1,
        id: uuid6(-1),
        ts: "2024-04-19T17:19:07.952Z",
        channel_values: {
          channel1: "channel1value",
        },
        channel_versions: {
          channel1: 2,
        },
        versions_seen: {
          __interrupt__: {
            channel1: 1,
          },
        },
        pending_sends: [],
      };

      const lastValueChannel1 = new LastValue<string>();
      lastValueChannel1.update(["channel1value"]);
      const channels = {
        channel1: lastValueChannel1,
      };

      // LastValue channel can only be updated with one value at a time
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pendingWrites: Array<[keyof typeof channels, any]> = [
        ["channel1", "channel1valueUpdated!"],
        ["channel1", "channel1valueUpdatedAgain!"],
      ];

      // call method / assertions
      expect(() => {
        _applyWrites(
          checkpoint,
          channels,
          [{ name: "foo", writes: pendingWrites, triggers: [] }],
          undefined,
          undefined
        ); // contains side effects
      }).toThrow(InvalidUpdateError);
    });
  });

  describe("_prepareNextTasks", () => {
    it("should return an object with PregelTaskDescriptions", () => {
      // set up test
      const checkpoint: Checkpoint = {
        v: 1,
        id: "1ee95cd6-c0f1-5f94-8a67-5c223c8bb55a",
        ts: "2024-04-19T17:19:07.952Z",
        channel_values: {
          channel1: 1,
          channel2: 2,
        },
        channel_versions: {
          channel1: 2,
          channel2: 5,
        },
        versions_seen: {
          node1: {
            channel1: 1,
          },
          node2: {
            channel2: 5,
          },
        },
        pending_sends: [],
      };

      const processes: Record<string, PregelNode> = {
        node1: new PregelNode({
          channels: ["channel1"],
          triggers: ["channel1"],
        }),
        node2: new PregelNode({
          channels: ["channel2"],
          triggers: ["channel1", "channel2"],
          mapper: () => 100, // return 100 no matter what
        }),
      };

      const channel1 = new LastValue<number>();
      channel1.update([1]);
      const channel2 = new LastValue<number>();
      channel2.update([2]);

      const channels = {
        channel1,
        channel2,
      };
      const managed = new ManagedValueMapping();

      // call method / assertions
      const taskDescriptions = Object.values(
        _prepareNextTasks(
          checkpoint,
          [],
          processes,
          channels,
          managed,
          { configurable: { thread_id: "foo" } },
          false,
          { step: -1 }
        )
      );

      expect(taskDescriptions.length).toBe(2);
      const node1Desc = taskDescriptions.find(({ name }) => name === "node1");
      expect(node1Desc).toEqual({
        id: expect.any(String),
        name: "node1",
        interrupts: [],
        path: [PULL, "node1"],
      });
      const node2Desc = taskDescriptions.find(({ name }) => name === "node2");
      expect(node2Desc).toEqual({
        id: expect.any(String),
        name: "node2",
        interrupts: [],
        path: [PULL, "node2"],
      });

      // the returned checkpoint is a copy of the passed checkpoint without versionsSeen updated
      expect(checkpoint.versions_seen.node1.channel1).toBe(1);
      expect(checkpoint.versions_seen.node2.channel2).toBe(5);
    });

    it("should return an object containing PregelExecutableTasks", () => {
      const checkpoint: Checkpoint = {
        v: 1,
        id: uuid6(-1),
        ts: "2024-04-19T17:19:07.952Z",
        channel_values: {
          channel1: 1,
          channel2: 2,
        },
        channel_versions: {
          channel1: 2,
          channel2: 5,
          channel3: 4,
          channel4: 4,
          channel6: 4,
        },
        versions_seen: {
          node1: {
            channel1: 1,
          },
          node2: {
            channel2: 5,
          },
          node3: {
            channel3: 4,
          },
          node4: {
            channel4: 3,
          },
          node6: {
            channel6: 3,
          },
        },
        pending_sends: [
          {
            node: "node1",
            args: { test: true },
          },
          // Will not appear because node3 has no writers
          { node: "node3", args: { test3: "value3" } },
        ],
      };

      const processes: Record<string, PregelNode> = {
        node1: new PregelNode({
          channels: ["channel1"],
          triggers: ["channel1"],
          writers: [new RunnablePassthrough()],
        }),
        node2: new PregelNode({
          channels: ["channel2"],
          triggers: ["channel1", "channel2"],
          writers: [new RunnablePassthrough()],
          mapper: () => 100, // return 100 no matter what
        }),
        node3: new PregelNode({
          // this task is filtered out because current version of channel3 matches version seen
          channels: ["channel3"],
          triggers: ["channel3"],
        }),
        node4: new PregelNode({
          // this task is filtered out because channel5 is empty
          channels: ["channel5"],
          triggers: ["channel4"],
        }),
        node6: new PregelNode({
          // this task is filtered out because channel5 is empty
          channels: { channel5: "channel5" },
          triggers: ["channel5", "channel6"],
        }),
      };

      const channel1 = new LastValue<number>();
      channel1.update([1]);
      const channel2 = new LastValue<number>();
      channel2.update([2]);
      const channel3 = new LastValue<number>();
      channel3.update([3]);
      const channel4 = new LastValue<number>();
      channel4.update([4]);
      const channel5 = new LastValue<number>();
      const channel6 = new LastValue<number>();
      channel6.update([6]);

      const channels = {
        channel1,
        channel2,
        channel3,
        channel4,
        channel5,
        channel6,
      };
      const managed = new ManagedValueMapping();

      // call method / assertions
      const tasks = Object.values(
        _prepareNextTasks(
          checkpoint,
          [],
          processes,
          channels,
          managed,
          { configurable: { thread_id: "foo" } },
          true,
          { step: -1 }
        )
      );

      expect(tasks.length).toBe(3);

      const task1 = tasks.find(
        ({ name, input }) => name === "node1" && input !== 1
      );
      const task2 = tasks.find(
        ({ name, input }) => name === "node1" && input === 1
      );
      const task3 = tasks.find(({ name }) => name === "node2");

      expect(task1).toEqual({
        name: "node1",
        input: { test: true },
        proc: new RunnablePassthrough(),
        writes: [],
        triggers: [PUSH],
        config: {
          tags: [],
          configurable: expect.any(Object),
          metadata: expect.objectContaining({
            langgraph_node: "node1",
            langgraph_step: -1,
            langgraph_triggers: [PUSH],
          }),
          recursionLimit: 25,
          runId: undefined,
          runName: "node1",
        },
        id: expect.any(String),
        path: [PUSH, 0],
        writers: expect.any(Array),
      });
      expect(task2).toEqual({
        name: "node1",
        input: 1,
        proc: new RunnablePassthrough(),
        writes: [],
        triggers: ["channel1"],
        config: {
          tags: [],
          configurable: expect.any(Object),
          metadata: expect.objectContaining({
            langgraph_node: "node1",
            langgraph_step: -1,
            langgraph_triggers: ["channel1"],
          }),
          recursionLimit: 25,
          runId: undefined,
          runName: "node1",
        },
        id: expect.any(String),
        path: [PULL, "node1"],
        writers: expect.any(Array),
      });
      expect(task3).toEqual({
        name: "node2",
        input: 100,
        proc: new RunnablePassthrough(),
        writes: [],
        triggers: ["channel1"],
        config: {
          tags: [],
          configurable: expect.any(Object),
          metadata: expect.objectContaining({
            langgraph_node: "node2",
            langgraph_step: -1,
            langgraph_triggers: ["channel1"],
          }),
          recursionLimit: 25,
          runId: undefined,
          runName: "node2",
        },
        id: expect.any(String),
        path: [PULL, "node2"],
        writers: expect.any(Array),
      });

      // Should not update versions seen, that occurs when applying writes
      expect(checkpoint.versions_seen.node1.channel1).toBe(1);
      expect(checkpoint.versions_seen.node2.channel1).not.toBeDefined();
      expect(checkpoint.versions_seen.node2.channel2).toBe(5);
    });
  });

  it("can invoke pregel with a single process", async () => {
    const addOne = vi.fn((x: number): number => x + 1);
    const chain = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: {
        one: chain,
      },
      channels: {
        input: new LastValue<number>(),
        output: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    expect(await app.invoke(2)).toBe(3);
    expect(await app.invoke(2, { outputKeys: ["output"] })).toEqual({
      output: 3,
    });
    expect(() => app.toString()).not.toThrow();
    // Verify the mock was called correctly
    expect(addOne).toHaveBeenCalled();
  });

  it("can invoke graph with a single process", async () => {
    const addOne = vi.fn((x: number): number => x + 1);

    const graph = new Graph()
      .addNode("add_one", addOne)
      .addEdge(START, "add_one")
      .addEdge("add_one", END)
      .compile();

    expect(await graph.invoke(2)).toBe(3);
  });

  it("should process input and produce output with implicit channels", async () => {
    const addOne = vi.fn((x: number): number => x + 1);
    const chain = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: { one: chain },
      channels: {
        input: new LastValue<number>(),
        output: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    expect(await app.invoke(2)).toBe(3);

    // Verify the mock was called correctly
    expect(addOne).toHaveBeenCalled();
  });

  it("should process input and write kwargs correctly", async () => {
    const addOne = vi.fn((x: number): number => x + 1);
    const chain = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(
        Channel.writeTo(["output"], {
          fixed: 5,
          outputPlusOne: (x: number) => x + 1,
        })
      );

    const app = new Pregel({
      nodes: { one: chain },
      channels: {
        input: new LastValue<number>(),
        output: new LastValue<number>(),
        fixed: new LastValue<number>(),
        outputPlusOne: new LastValue<number>(),
      },
      outputChannels: ["output", "fixed", "outputPlusOne"],
      inputChannels: "input",
    });

    expect(await app.invoke(2)).toEqual({
      output: 3,
      fixed: 5,
      outputPlusOne: 4,
    });
  });

  // TODO: Check undefined too
  const FALSEY_VALUES = [null, 0, "", [], {}, new Set()];
  it.each(FALSEY_VALUES)(
    "should process falsey value: %p",
    async (falsyValue) => {
      const graph = new Graph()
        .addNode("return_falsy_const", () => falsyValue)
        .addEdge(START, "return_falsy_const")
        .addEdge("return_falsy_const", END)
        .compile();

      expect(await graph.invoke(1)).toBe(falsyValue);
    }
  );

  it("should invoke single process in out objects", async () => {
    const addOne = vi.fn((x: number): number => x + 1);
    const chain = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: {
        one: chain,
      },
      channels: {
        input: new LastValue<number>(),
        output: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: ["output"],
    });

    expect(await app.invoke(2)).toEqual({ output: 3 });
  });

  it("should process input and output as objects", async () => {
    const addOne = vi.fn((x: number): number => x + 1);
    const chain = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: { one: chain },
      channels: {
        input: new LastValue<number>(),
        output: new LastValue<number>(),
      },
      inputChannels: ["input"],
      outputChannels: ["output"],
    });

    expect(await app.invoke({ input: 2 })).toEqual({ output: 3 });
  });
  it("should invoke two processes and get correct output", async () => {
    const addOne = vi.fn((x: number): number => x + 1);

    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["inbox"]));
    const two = Channel.subscribeTo("inbox")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: { one, two },
      channels: {
        inbox: new LastValue<number>(),
        output: new LastValue<number>(),
        input: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
      streamChannels: ["inbox", "output"],
    });

    await expect(app.invoke(2, { recursionLimit: 1 })).rejects.toThrow(
      GraphRecursionError
    );

    expect(await app.invoke(2)).toEqual(4);

    const stream = await app.stream(2, { streamMode: "updates" });
    let step = 0;
    for await (const value of stream) {
      if (step === 0) {
        expect(value).toEqual({ one: { inbox: 3 } });
      } else if (step === 1) {
        expect(value).toEqual({ two: { output: 4 } });
      }
      step += 1;
    }
    expect(step).toBe(2);
  });

  it("should process two processes with object input and output", async () => {
    const addOne = vi.fn((x: number): number => x + 1);
    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["inbox"]));
    const two = Channel.subscribeTo("inbox")
      .pipe(new RunnableLambda({ func: addOne }).map())
      .pipe(Channel.writeTo(["output"]).map());

    const app = new Pregel({
      nodes: { one, two },
      channels: {
        inbox: new Topic<number>(),
        input: new LastValue<number>(),
        output: new LastValue<number>(),
      },
      inputChannels: ["input", "inbox"],
      streamChannels: ["output", "inbox"],
      outputChannels: "output",
    });

    expect(
      await gatherIterator(
        app.stream({ input: 2, inbox: 12 }, { outputKeys: "output" })
      )
    ).toEqual([13, 4]); // [12 + 1, 2 + 1 + 1]

    expect(
      await gatherIterator(
        app.stream({ input: 2, inbox: 12 }, { streamMode: "updates" })
      )
    ).toEqual([
      { one: { inbox: 3 } },
      { two: { output: 13 } },
      { two: { output: 4 } },
    ]);

    expect(await gatherIterator(app.stream({ input: 2, inbox: 12 }))).toEqual([
      { inbox: [3], output: 13 },
      { output: 4 },
    ]);

    const debug = await gatherIterator(
      app.stream({ input: 2, inbox: 12 }, { streamMode: "debug" })
    );

    const anyStringSame = createAnyStringSame();

    expect(debug).toEqual([
      {
        type: "task",
        timestamp: expect.any(String),
        step: 0,
        payload: {
          id: anyStringSame("task1"),
          name: "one",
          input: 2,
          triggers: ["input"],
          interrupts: [],
        },
      },
      {
        type: "task",
        timestamp: expect.any(String),
        step: 0,
        payload: {
          id: anyStringSame("task2"),
          name: "two",
          input: [12],
          triggers: ["inbox"],
          interrupts: [],
        },
      },
      {
        type: "task_result",
        timestamp: expect.any(String),
        step: 0,
        payload: {
          id: anyStringSame("task1"),
          name: "one",
          result: [["inbox", 3]],
          interrupts: [],
        },
      },
      {
        type: "task_result",
        timestamp: expect.any(String),
        step: 0,
        payload: {
          id: anyStringSame("task2"),
          name: "two",
          result: [["output", 13]],
          interrupts: [],
        },
      },
      {
        type: "task",
        timestamp: expect.any(String),
        step: 1,
        payload: {
          id: anyStringSame("task3"),
          name: "two",
          input: [3],
          triggers: ["inbox"],
          interrupts: [],
        },
      },
      {
        type: "task_result",
        timestamp: expect.any(String),
        step: 1,
        payload: {
          id: anyStringSame("task3"),
          name: "two",
          result: [["output", 4]],
          interrupts: [],
        },
      },
    ]);
  });

  it("should process batch with two processes and delays", async () => {
    const addOneWithDelay = vi.fn(
      (inp: number): Promise<number> =>
        new Promise((resolve) => {
          setTimeout(() => resolve(inp + 1), inp * 100);
        })
    );

    const one = Channel.subscribeTo("input")
      .pipe(addOneWithDelay)
      .pipe(Channel.writeTo(["one"]));
    const two = Channel.subscribeTo("one")
      .pipe(addOneWithDelay)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: { one, two },
      channels: {
        one: new LastValue<number>(),
        output: new LastValue<number>(),
        input: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    expect(await app.batch([3, 2, 1, 3, 5])).toEqual([5, 4, 3, 5, 7]);
    expect(
      await app.batch([3, 2, 1, 3, 5], { outputKeys: ["output"] })
    ).toEqual([
      { output: 5 },
      { output: 4 },
      { output: 3 },
      { output: 5 },
      { output: 7 },
    ]);
  });

  it("should process batch with two processes and delays with graph", async () => {
    const addOneWithDelay = vi.fn(
      (inp: number): Promise<number> =>
        new Promise((resolve) => {
          setTimeout(() => resolve(inp + 1), inp * 100);
        })
    );

    const graph = new Graph()
      .addNode("add_one", addOneWithDelay)
      .addNode("add_one_more", addOneWithDelay)
      .addEdge(START, "add_one")
      .addEdge("add_one", "add_one_more")
      .addEdge("add_one_more", END)
      .compile();

    expect(await graph.batch([3, 2, 1, 3, 5])).toEqual([5, 4, 3, 5, 7]);
  });

  it("should invoke two processes with input/output and interrupt", async () => {
    const checkpointer = await createCheckpointer();
    const addOne = vi.fn((x: number) => {
      return x + 1;
    });
    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["inbox"]));
    const two = Channel.subscribeTo("inbox")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: { one, two },
      channels: {
        inbox: new LastValue<number>(),
        output: new LastValue<number>(),
        input: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
      checkpointer,
      interruptAfter: ["one"],
    });

    const thread1 = { configurable: { thread_id: "1" } };
    const thread2 = { configurable: { thread_id: "2" } };

    // start execution, stop at inbox
    expect(await app.invoke(2, thread1)).toEqual({ __interrupt__: [] });

    // inbox == 3
    let checkpoint = await checkpointer.get(thread1);
    expect(checkpoint?.channel_values.inbox).toBe(3);

    // resume execution, finish
    expect(await app.invoke(null, thread1)).toBe(4);

    // start execution again, stop at inbox
    expect(await app.invoke(20, thread1)).toEqual({ __interrupt__: [] });

    // inbox == 21
    checkpoint = await checkpointer.get(thread1);
    expect(checkpoint).not.toBeUndefined();
    expect(checkpoint?.channel_values.inbox).toBe(21);

    // send a new value in, interrupting the previous execution
    expect(await app.invoke(3, thread1)).toEqual({ __interrupt__: [] });
    expect(await app.invoke(null, thread1)).toBe(5);

    // start execution again, stopping at inbox
    expect(await app.invoke(20, thread2)).toEqual({ __interrupt__: [] });

    // inbox == 21
    let snapshot = await app.getState(thread2);
    expect(snapshot.values.inbox).toBe(21);
    expect(snapshot.next).toEqual(["two"]);

    // update the state, resume
    await app.updateState(thread2, 25, "one");
    expect(await app.invoke(null, thread2)).toBe(26);

    // no pending tasks
    snapshot = await app.getState(thread2);
    expect(snapshot.next).toEqual([]);

    // list history
    const history = await gatherIterator(app.getStateHistory(thread1));
    expect(history).toEqual([
      expect.objectContaining({
        values: { inbox: 4, output: 5, input: 3 },
        tasks: [],
        next: [],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          source: "loop",
          step: 6,
          writes: { two: 5 },
          parents: {},
          thread_id: "1",
        },
        createdAt: expect.any(String),
        parentConfig: history[1].config,
      }),
      expect.objectContaining({
        values: { inbox: 4, output: 4, input: 3 },
        tasks: [
          {
            id: expect.any(String),
            name: "two",
            interrupts: [],
            path: [PULL, "two"],
          },
        ],
        next: ["two"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          source: "loop",
          step: 5,
          writes: {},
          parents: {},
          thread_id: "1",
        },
        createdAt: expect.any(String),
        parentConfig: history[2].config,
      }),
      expect.objectContaining({
        values: { inbox: 21, output: 4, input: 3 },
        tasks: [
          {
            id: expect.any(String),
            name: "one",
            interrupts: [],
            path: [PULL, "one"],
          },
        ],
        next: ["one"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          source: "input",
          step: 4,
          writes: { input: 3 },
          parents: {},
          thread_id: "1",
        },
        createdAt: expect.any(String),
        parentConfig: history[3].config,
      }),
      expect.objectContaining({
        values: { inbox: 21, output: 4, input: 20 },
        tasks: [
          {
            id: expect.any(String),
            name: "two",
            interrupts: [],
            path: [PULL, "two"],
          },
        ],
        next: ["two"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          source: "loop",
          step: 3,
          writes: {},
          parents: {},
          thread_id: "1",
        },
        createdAt: expect.any(String),
        parentConfig: history[4].config,
      }),
      expect.objectContaining({
        values: { inbox: 3, output: 4, input: 20 },
        tasks: [
          {
            id: expect.any(String),
            name: "one",
            interrupts: [],
            path: [PULL, "one"],
          },
        ],
        next: ["one"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          source: "input",
          step: 2,
          writes: { input: 20 },
          parents: {},
          thread_id: "1",
        },
        createdAt: expect.any(String),
        parentConfig: history[5].config,
      }),
      expect.objectContaining({
        values: { inbox: 3, output: 4, input: 2 },
        tasks: [],
        next: [],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          source: "loop",
          step: 1,
          writes: { two: 4 },
          parents: {},
          thread_id: "1",
        },
        createdAt: expect.any(String),
        parentConfig: history[6].config,
      }),
      expect.objectContaining({
        values: { inbox: 3, input: 2 },
        tasks: [
          {
            id: expect.any(String),
            name: "two",
            interrupts: [],
            path: [PULL, "two"],
          },
        ],
        next: ["two"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          source: "loop",
          step: 0,
          writes: {},
          parents: {},
          thread_id: "1",
        },
        createdAt: expect.any(String),
        parentConfig: history[7].config,
      }),
      expect.objectContaining({
        values: { input: 2 },
        tasks: [
          {
            id: expect.any(String),
            name: "one",
            interrupts: [],
            path: [PULL, "one"],
          },
        ],
        next: ["one"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          source: "input",
          step: -1,
          writes: { input: 2 },
          parents: {},
          thread_id: "1",
        },
        createdAt: expect.any(String),
      }),
    ]);

    // forking from any previous checkpoint w/out forking should re-run nodes
    expect(
      await gatherIterator(
        app.stream(null, { ...history[0].config, streamMode: "updates" })
      )
    ).toEqual([]);
    expect(
      await gatherIterator(
        app.stream(null, { ...history[1].config, streamMode: "updates" })
      )
    ).toEqual([{ two: { output: 5 } }]);
    expect(
      await gatherIterator(
        app.stream(null, { ...history[2].config, streamMode: "updates" })
      )
    ).toEqual([{ one: { inbox: 4 } }, { [INTERRUPT]: [] }]);
  });

  it("should batch many processes with input and output", async () => {
    const testSize = 100;
    const addOne = vi.fn((x: number) => x + 1);

    const channels: Record<string, LastValue<number>> = {
      input: new LastValue<number>(),
      output: new LastValue<number>(),
      "-1": new LastValue<number>(),
    };
    const nodes: Record<string, PregelNode> = {
      "-1": Channel.subscribeTo("input")
        .pipe(addOne)
        .pipe(Channel.writeTo(["-1"])),
    };

    for (let i = 0; i < testSize - 2; i += 1) {
      channels[String(i)] = new LastValue<number>();
      nodes[String(i)] = Channel.subscribeTo(String(i - 1))
        .pipe(addOne)
        .pipe(Channel.writeTo([String(i)]));
    }
    nodes.last = Channel.subscribeTo(String(testSize - 3))
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes,
      channels,
      inputChannels: "input",
      outputChannels: "output",
    });

    for (let i = 0; i < 3; i += 1) {
      await expect(
        app.batch([2, 1, 3, 4, 5], { recursionLimit: testSize })
      ).resolves.toEqual([
        2 + testSize,
        1 + testSize,
        3 + testSize,
        4 + testSize,
        5 + testSize,
      ]);
    }
  });

  it("should raise InvalidUpdateError when the same LastValue channel is updated twice in one iteration", async () => {
    const addOne = vi.fn((x: number): number => x + 1);

    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));
    const two = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: { one, two },
      channels: {
        output: new LastValue<number>(),
        input: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    await expect(app.invoke(2)).rejects.toThrow(InvalidUpdateError);
  });

  it("should fail to process two processes in an invalid way", async () => {
    const addOne = vi.fn((x: number): number => x + 1);

    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));
    const two = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: { one, two },
      channels: {
        output: new LastValue<number>(),
        input: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    // LastValue channels can only be updated once per iteration
    await expect(app.invoke(2)).rejects.toThrow(InvalidUpdateError);
  });

  it("should process two inputs to two outputs validly", async () => {
    const addOne = vi.fn((x: number): number => x + 1);

    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));
    const two = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: { one, two },
      channels: {
        output: new Topic<number>(),
        input: new LastValue<number>(),
        output2: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    // An Inbox channel accumulates updates into a sequence
    expect(await app.invoke(2)).toEqual([3, 3]);
  });

  it("should allow a conditional edge after a send", async () => {
    const State = {
      items: Annotation<string[]>({
        reducer: (a, b) => a.concat(b),
      }),
    };
    const sendForFun = (state: StateType<typeof State>) => {
      return [new Send("2", state), new Send("2", state)];
    };
    const routeToThree = () => "3";
    const graph = new StateGraph(State)
      .addNode("1", () => ({ items: ["1"] }))
      .addNode("2", () => ({ items: ["2"] }))
      .addNode("3", () => ({ items: ["3"] }))
      .addEdge("__start__", "1")
      .addConditionalEdges("1", sendForFun)
      .addConditionalEdges("2", routeToThree)
      .addEdge("3", "__end__")
      .compile();
    const res = await graph.invoke({ items: ["0"] });
    expect(res).toEqual({ items: ["0", "1", "2", "2", "3"] });
  });

  it("should support a simple edgeless graph", async () => {
    const StateAnnotation = Annotation.Root({
      foo: Annotation<string>,
    });

    const nodeA = async (state: typeof StateAnnotation.State) => {
      const goto = state.foo === "foo" ? "nodeB" : "nodeC";
      return new Command({
        update: {
          foo: "a",
        },
        goto,
      });
    };

    const nodeB = async (state: typeof StateAnnotation.State) => {
      return {
        foo: state.foo + "|b",
      };
    };

    const nodeC = async (state: typeof StateAnnotation.State) => {
      return {
        foo: state.foo + "|c",
      };
    };

    const graph = new StateGraph(StateAnnotation)
      .addNode("nodeA", nodeA, {
        ends: ["nodeB", "nodeC"],
      })
      .addNode("nodeB", nodeB)
      .addNode("nodeC", nodeC)
      .addEdge("__start__", "nodeA")
      .compile();

    const drawableGraph = await graph.getGraphAsync();
    const mermaid = drawableGraph.drawMermaid();
    // console.log(mermaid);
    expect(mermaid).toEqual(`%%{init: {'flowchart': {'curve': 'linear'}}}%%
graph TD;
	__start__([<p>__start__</p>]):::first
	nodeA(nodeA)
	nodeB(nodeB)
	nodeC(nodeC)
	__start__ --> nodeA;
	nodeA -.-> nodeB;
	nodeA -.-> nodeC;
	classDef default fill:#f2f0ff,line-height:1.2;
	classDef first fill-opacity:0;
	classDef last fill:#bfb6fc;
`);
    expect(await graph.invoke({ foo: "foo" })).toEqual({ foo: "a|b" });
    expect(await graph.invoke({ foo: "" })).toEqual({ foo: "a|c" });
  });

  it("should support a simple edgeless graph", async () => {
    const StateAnnotation = Annotation.Root({
      foo: Annotation<string>,
      bar: Annotation<string>,
    });

    const nodeA = async (state: typeof StateAnnotation.State) => {
      const goto = state.foo === "foo" ? "nodeB" : "nodeC";
      return [
        new Command({
          update: {
            foo: "a",
          },
          goto,
        }),
      ];
    };

    const nodeB = async (state: typeof StateAnnotation.State) => {
      return [
        {
          foo: state.foo + "|b",
        },
        new Command({
          update: {
            bar: "test",
          },
        }),
      ];
    };

    const nodeC = async (state: typeof StateAnnotation.State) => {
      return {
        foo: state.foo + "|c",
      };
    };

    const graph = new StateGraph(StateAnnotation)
      .addNode("nodeA", nodeA, {
        ends: ["nodeB", "nodeC"],
      })
      .addNode("nodeB", nodeB)
      .addNode("nodeC", nodeC)
      .addEdge("__start__", "nodeA")
      .compile();

    expect(await graph.invoke({ foo: "foo" })).toEqual({
      foo: "a|b",
      bar: "test",
    });
    expect(await graph.invoke({ foo: "" })).toEqual({ foo: "a|c" });
  });

  it("should handle send sequences correctly", async () => {
    const StateAnnotation = Annotation.Root({
      items: Annotation<any[]>({
        reducer: (a, b) => a.concat(b),
      }),
    });

    const getNode = (
      name: string
    ): ((
      state: typeof StateAnnotation.State
    ) => Promise<typeof StateAnnotation.State>) => {
      return async (state: typeof StateAnnotation.State) => {
        const update = Array.isArray(state.items)
          ? { items: [name] }
          : { items: [`${name}|${JSON.stringify(state)}`] };

        if (isCommand(state)) {
          state.update = update;
          return state;
        } else {
          return update;
        }
      };
    };

    const sendForFun = () => {
      return [
        new Send("2", new Command({ goto: new Send("2", 3) })),
        new Send("2", new Command({ goto: new Send("2", 4) })),
        "3.1",
      ];
    };

    const routeToThree = () => "3";

    const builder = new StateGraph(StateAnnotation)
      .addNode("1", getNode("1"))
      .addNode("2", getNode("2"))
      .addNode("3", getNode("3"))
      .addNode("3.1", getNode("3.1"))
      .addEdge(START, "1")
      .addConditionalEdges("1", sendForFun)
      .addConditionalEdges("2", routeToThree);

    const graph = builder.compile();

    const result = await graph.invoke({
      items: ["0"],
    });

    expect(result).toEqual({
      items: [
        "0",
        "1",
        "3.1",
        `2|${JSON.stringify(new Command({ goto: new Send("2", 3) }))}`,
        `2|${JSON.stringify(new Command({ goto: new Send("2", 4) }))}`,
        "3",
        "2|3",
        "2|4",
        "3",
      ],
    });
  });

  it("should handle checkpoints correctly", async () => {
    const inputPlusTotal = vi.fn(
      (x: { total: number; input: number }): number => (x.total ?? 0) + x.input
    );
    const raiseIfAbove10 = (input: number): number => {
      if (input > 10) {
        throw new Error("Input is too large");
      }
      return input;
    };

    const one = Channel.subscribeTo(["input"])
      .join(["total"])
      .pipe(inputPlusTotal)
      .pipe(Channel.writeTo(["output", "total"]))
      .pipe(raiseIfAbove10);

    const memory = await createCheckpointer();

    const app = new Pregel({
      nodes: { one },
      channels: {
        total: new BinaryOperatorAggregate<number>((a, b) => a + b),
        input: new LastValue<number>(),
        output: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
      checkpointer: memory,
    });

    // total starts out as 0, so output is 0+2=2
    await expect(
      app.invoke(2, { configurable: { thread_id: "1" } })
    ).resolves.toBe(2);
    let checkpoint = await memory.get({ configurable: { thread_id: "1" } });
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.channel_values.total).toBe(2);

    // total is now 2, so output is 2+3=5
    await expect(
      app.invoke(3, { configurable: { thread_id: "1" } })
    ).resolves.toBe(5);
    checkpoint = await memory.get({ configurable: { thread_id: "1" } });
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.channel_values.total).toBe(7);

    // total is now 2+5=7, so output would be 7+4=11, but raises Error
    await expect(
      app.invoke(4, { configurable: { thread_id: "1" } })
    ).rejects.toThrow("Input is too large");
    // checkpoint is not updated
    checkpoint = await memory.get({ configurable: { thread_id: "1" } });
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.channel_values.total).toBe(7);

    // on a new thread, total starts out as 0, so output is 0+5=5
    await expect(
      app.invoke(5, { configurable: { thread_id: "2" } })
    ).resolves.toBe(5);
    checkpoint = await memory.get({ configurable: { thread_id: "1" } });
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.channel_values.total).toBe(7);
    checkpoint = await memory.get({ configurable: { thread_id: "2" } });
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.channel_values.total).toBe(5);
  });

  it("should process two inputs joined into one topic and produce two outputs", async () => {
    const addOne = vi.fn((x: number): number => x + 1);
    const add10Each = vi.fn((x: number[]): number[] =>
      x.map((y) => y + 10).sort()
    );

    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["inbox"]));
    const chainThree = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["inbox"]));
    const chainFour = Channel.subscribeTo("inbox")
      .pipe(add10Each)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: {
        one,
        chainThree,
        chainFour,
      },
      channels: {
        inbox: new Topic<number>(),
        output: new LastValue<number>(),
        input: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    // Invoke app and check results
    // We get a single array result as chain_four waits for all publishers to finish
    // before operating on all elements published to topic_two as an array
    for (let i = 0; i < 100; i += 1) {
      expect(await app.invoke(2)).toEqual([13, 13]);
    }

    // Use Promise.all to simulate concurrent execution
    const results = await Promise.all(
      Array(100)
        .fill(null)
        .map(async () => app.invoke(2))
    );
    results.forEach((result) => {
      expect(result).toEqual([13, 13]);
    });
  });

  it("should invoke join then call other app", async () => {
    const addOne = vi.fn((x: number): number => x + 1);
    const add10Each = vi.fn((x: number[]): number[] => x.map((y) => y + 10));

    const innerApp = new Pregel({
      nodes: {
        one: Channel.subscribeTo("input")
          .pipe(addOne)
          .pipe(Channel.writeTo(["output"])),
      },
      channels: {
        output: new LastValue<number>(),
        input: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    const one = Channel.subscribeTo("input")
      .pipe(add10Each)
      .pipe(Channel.writeTo(["inbox_one"]).map());

    const two = Channel.subscribeTo("inbox_one")
      .pipe(() => innerApp.map())
      .pipe((x: number[]) => x.sort())
      .pipe(Channel.writeTo(["outbox_one"]));

    const chainThree = Channel.subscribeTo("outbox_one")
      .pipe((x: number[]) => x.reduce((a, b) => a + b, 0))
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: {
        one,
        two,
        chain_three: chainThree,
      },
      channels: {
        inbox_one: new Topic<number>(),
        outbox_one: new Topic<number>(),
        output: new LastValue<number>(),
        input: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    // Run the test 10 times sequentially
    for (let i = 0; i < 10; i += 1) {
      expect(await app.invoke([2, 3])).toEqual(27);
    }

    // Run the test 10 times in parallel
    const results = await Promise.all(
      Array(10)
        .fill(null)
        .map(() => app.invoke([2, 3]))
    );
    expect(results).toEqual(Array(10).fill(27));
  });

  it("should handle two processes with one input and two outputs", async () => {
    const addOne = vi.fn((x: number) => x + 1);

    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(
        Channel.writeTo([], {
          output: new RunnablePassthrough(),
          between: new RunnablePassthrough(),
        })
      );

    const two = Channel.subscribeTo("between")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));

    const app = new Pregel({
      nodes: { one, two },
      channels: {
        input: new LastValue<number>(),
        output: new LastValue<number>(),
        between: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
      streamChannels: ["output", "between"],
    });

    const results = await app.stream(2);
    const streamResults = await gatherIterator(results);

    expect(streamResults).toEqual([
      { between: 3, output: 3 },
      { between: 3, output: 4 },
    ]);
  });

  it("should finish executing without output", async () => {
    const addOne = vi.fn((x: number): number => x + 1);
    const one = Channel.subscribeTo("input")
      .pipe(addOne)
      .pipe(Channel.writeTo(["between"]));
    const two = Channel.subscribeTo("between").pipe(addOne);

    const app = new Pregel({
      nodes: { one, two },
      channels: {
        input: new LastValue<number>(),
        between: new LastValue<number>(),
        output: new LastValue<number>(),
      },
      inputChannels: "input",
      outputChannels: "output",
    });

    // It finishes executing (once no more messages being published)
    // but returns nothing, as nothing was published to OUT topic
    expect(await app.invoke(2)).toBeUndefined();
  });

  it("should throw an error when no input channel is provided", () => {
    const addOne = vi.fn((x: number): number => x + 1);

    const one = Channel.subscribeTo("between")
      .pipe(addOne)
      .pipe(Channel.writeTo(["output"]));
    const two = Channel.subscribeTo("between").pipe(addOne);

    // @ts-expect-error - this should throw an error
    expect(() => new Pregel({ nodes: { one, two } })).toThrowError();
  });

  it("should type-error when Channel.subscribeTo would throw at runtime", () => {
    expect(() => {
      // @ts-expect-error - this would throw at runtime and thus we want it to become a type-error
      Channel.subscribeTo(["input"], { key: "key" });
    }).toThrow();
  });

  describe("StateGraph", () => {
    class SearchAPI extends Tool {
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
    const tools = [new SearchAPI()];

    type Step = [AgentAction | AgentFinish, string];

    const AgentAnnotation = Annotation.Root({
      input: Annotation<string>,
      agentOutcome: Annotation<AgentAction | AgentFinish | undefined>,
      steps: Annotation<Step[]>({
        reducer: (x: Step[], y: Step[]) => x.concat(y),
      }),
    });

    const executeTools = async (data: typeof AgentAnnotation.State) => {
      const newData = data;
      const { agentOutcome } = newData;
      delete newData.agentOutcome;
      if (!agentOutcome || "returnValues" in agentOutcome) {
        throw new Error("Agent has already finished.");
      }
      const observation: string =
        (await tools
          .find((t) => t.name === agentOutcome.tool)
          ?.invoke(agentOutcome.toolInput)) ?? "failed";

      return {
        steps: [[agentOutcome, observation]] as Step[],
      };
    };

    const shouldContinue = async (
      data: typeof AgentAnnotation.State
    ): Promise<string> => {
      if (data.agentOutcome && "returnValues" in data.agentOutcome) {
        return "__end__";
      }
      return "tools";
    };

    it("can invoke", async () => {
      const prompt = PromptTemplate.fromTemplate("Hello!");

      const llm = new FakeStreamingLLM({
        responses: [
          "tool:search_api:query",
          "tool:search_api:another",
          "finish:answer",
        ],
      });

      const agentParser = (input: string) => {
        if (input.startsWith("finish")) {
          const answer = input.split(":")[1];
          return {
            agentOutcome: {
              returnValues: { answer },
              log: input,
            },
          };
        }
        const [, toolName, toolInput] = input.split(":");
        return {
          agentOutcome: {
            tool: toolName,
            toolInput,
            log: input,
          },
        };
      };

      const agent = async (state: typeof AgentAnnotation.State) => {
        const chain = prompt.pipe(llm).pipe(agentParser);
        const result = await chain.invoke({ input: state.input });
        return {
          ...result,
        };
      };

      const graph = new StateGraph(AgentAnnotation)
        .addNode("agent", agent)
        .addNode("passthrough", () => {
          return {};
        })
        .addNode("tools", executeTools)
        .addEdge(START, "agent")
        .addEdge("agent", "passthrough")
        .addConditionalEdges("passthrough", shouldContinue, [
          "tools",
          "__end__",
        ])
        .addEdge("tools", "agent")
        .compile();

      let callbackOutputs;
      const result = await graph.invoke(
        { input: "what is the weather in sf?" },
        {
          callbacks: [
            {
              handleChainEnd(outputs) {
                // The final time this is called should be the final output from graph
                callbackOutputs = outputs;
              },
            },
          ],
        }
      );
      await awaitAllCallbacks();
      expect(result).toEqual({
        input: "what is the weather in sf?",
        agentOutcome: {
          returnValues: {
            answer: "answer",
          },
          log: "finish:answer",
        },
        steps: [
          [
            {
              log: "tool:search_api:query",
              tool: "search_api",
              toolInput: "query",
            },
            "result for query",
          ],
          [
            {
              log: "tool:search_api:another",
              tool: "search_api",
              toolInput: "another",
            },
            "result for another",
          ],
        ],
      });
      expect(result).toEqual(callbackOutputs);
    });

    it("can stream", async () => {
      const prompt = PromptTemplate.fromTemplate("Hello!");

      const llm = new FakeStreamingLLM({
        responses: [
          "tool:search_api:query",
          "tool:search_api:another",
          "finish:answer",
        ],
      });

      const agentParser = (input: string) => {
        if (input.startsWith("finish")) {
          const answer = input.split(":")[1];
          return {
            agentOutcome: {
              returnValues: { answer },
              log: input,
            },
          };
        }
        const [, toolName, toolInput] = input.split(":");
        return {
          agentOutcome: {
            tool: toolName,
            toolInput,
            log: input,
          },
        };
      };

      const agent = async (state: typeof AgentAnnotation.State) => {
        const chain = prompt.pipe(llm).pipe(agentParser);
        const result = await chain.invoke({ input: state.input });
        return {
          ...result,
        };
      };

      const app = new StateGraph(AgentAnnotation)
        .addNode("agent", agent)
        .addNode("tools", executeTools)
        .addEdge(START, "agent")
        .addConditionalEdges("agent", shouldContinue, ["tools", "__end__"])
        .addEdge("tools", "agent")
        .compile();

      const stream = await app.stream({
        input: "what is the weather in sf?",
      });
      const streamItems = await gatherIterator(stream);
      expect(streamItems.length).toBe(5);
      expect(streamItems[0]).toEqual({
        agent: {
          agentOutcome: {
            tool: "search_api",
            toolInput: "query",
            log: "tool:search_api:query",
          },
        },
      });

      // TODO: Need to rewrite this test.
    });

    it("can invoke a nested graph", async () => {
      // set up inner graph
      type InnerState = {
        myKey: string;
        myOtherKey: string;
      };

      const innerGraph = new StateGraph<InnerState>({
        channels: {
          myKey: null,
          myOtherKey: null,
        },
      })
        .addNode("up", (state: InnerState) => ({
          myKey: `${state.myKey} there`,
          myOtherKey: state.myOtherKey,
        }))
        .addEdge(START, "up")
        .addEdge("up", END);

      // set up top level graph
      type State = {
        myKey: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        neverCalled: any;
      };

      const graph = new StateGraph<State>({
        channels: {
          myKey: null,
          neverCalled: null,
        },
      })
        .addNode("inner", innerGraph.compile())
        .addNode("side", (state: State) => ({
          myKey: `${state.myKey} and back again`,
        }))
        .addEdge("inner", "side")
        .addEdge(START, "inner")
        .addEdge("side", END)
        .compile();

      // call method / assertions
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const neverCalled = vi.fn((_: any) => {
        throw new Error("This should never be called");
      });

      const result = await graph.invoke({
        myKey: "my value",
        neverCalled: new RunnableLambda({ func: neverCalled }),
      });

      expect(result).toEqual({
        myKey: "my value there and back again",
        neverCalled: new RunnableLambda({ func: neverCalled }),
      });
    });

    it("can invoke a nested graph", async () => {
      // set up inner graph
      type InnerState = {
        myKey: string;
        myOtherKey: string;
      };

      const innerGraph = new StateGraph<InnerState>({
        channels: {
          myKey: null,
          myOtherKey: null,
        },
      })
        .addNode("up", (state: InnerState) => ({
          myKey: `${state.myKey} there`,
          myOtherKey: state.myOtherKey,
        }))
        .addEdge(START, "up")
        .addEdge("up", END);

      // set up top level graph
      type State = {
        myKey: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        neverCalled: any;
      };

      const graph = new StateGraph<State>({
        channels: {
          myKey: null,
          neverCalled: null,
        },
      })
        .addNode("inner", innerGraph.compile())
        .addNode("side", (state: State) => ({
          myKey: `${state.myKey} and back again`,
        }))
        .addEdge("inner", "side")
        .addEdge(START, "inner")
        .addEdge("side", END)
        .compile();

      // call method / assertions
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const neverCalled = vi.fn((_: any) => {
        throw new Error("This should never be called");
      });

      const result = await graph.invoke({
        myKey: "my value",
        neverCalled: new RunnableLambda({ func: neverCalled }),
      });

      expect(result).toEqual({
        myKey: "my value there and back again",
        neverCalled: new RunnableLambda({ func: neverCalled }),
      });
    });

    it("Conditional edges is optional", async () => {
      type GraphState = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        keys: Record<string, any>;
      };
      const nodeOne = (state: GraphState) => {
        const { keys } = state;
        keys.value = 1;
        return {
          keys,
        };
      };
      const nodeTwo = (state: GraphState) => {
        const { keys } = state;
        keys.value = 2;
        return {
          keys,
        };
      };
      const nodeThree = (state: GraphState) => {
        const { keys } = state;
        keys.value = 3;
        return {
          keys,
        };
      };
      const decideNext = (_: GraphState) => "two";

      const graph = new StateGraph<GraphState>({
        channels: {
          keys: null,
        },
      })
        .addNode("one", nodeOne)
        .addNode("two", nodeTwo)
        .addNode("three", nodeThree)
        .addEdge(START, "one")
        .addConditionalEdges("one", decideNext)
        .addEdge("two", "three")
        .addEdge("three", END)
        .compile();

      // This will always return two, and two will always go to three
      // meaning keys.value will always be 3
      const result = await graph.invoke({ keys: { value: 0 } });
      expect(result).toEqual({ keys: { value: 3 } });
    });

    it("In one fan out state graph waiting edge", async () => {
      const sortedAdd = vi.fn((x: string[], y: string[]): string[] =>
        [...x, ...y].sort()
      );

      type State = {
        query: string;
        answer: string;
        docs: string[];
      };

      function rewriteQuery(data: State): Partial<State> {
        return { query: `query: ${data.query}` };
      }

      function analyzerOne(data: State): Partial<State> {
        return { query: `analyzed: ${data.query}` };
      }

      function retrieverOne(_data: State): Partial<State> {
        return { docs: ["doc1", "doc2"] };
      }

      function retrieverTwo(_data: State): Partial<State> {
        return { docs: ["doc3", "doc4"] };
      }

      function qa(data: State): Partial<State> {
        return { answer: data.docs?.join(",") };
      }

      const workflow = new StateGraph<State>({
        channels: {
          query: null,
          answer: null,
          docs: { reducer: sortedAdd },
        },
      })
        .addNode("rewrite_query", rewriteQuery)
        .addNode("analyzer_one", analyzerOne)
        .addNode("retriever_one", retrieverOne)
        .addNode("retriever_two", retrieverTwo)
        .addNode("qa", qa)
        .addEdge(START, "rewrite_query")
        .addEdge("rewrite_query", "analyzer_one")
        .addEdge("analyzer_one", "retriever_one")
        .addEdge("rewrite_query", "retriever_two")
        .addEdge(["retriever_one", "retriever_two"], "qa")
        .addEdge("qa", END);

      const app = workflow.compile();

      expect(await app.invoke({ query: "what is weather in sf" })).toEqual({
        query: "analyzed: query: what is weather in sf",
        docs: ["doc1", "doc2", "doc3", "doc4"],
        answer: "doc1,doc2,doc3,doc4",
      });
    });

    it.each([
      [true], // waiting edge: true
      [false], // waiting edge: false
    ])(
      "in_one_fan_out_state_graph_defer_node (waiting edge: %s)",
      async (waitingEdge) => {
        const sortedAdd = vi.fn((x: string[], y: string[]): string[] =>
          [...x, ...y].sort()
        );

        const StateAnnotation = Annotation.Root({
          query: Annotation<string>,
          answer: Annotation<string>,
          docs: Annotation<string[]>({ reducer: sortedAdd }),
        });

        const builder = new StateGraph(StateAnnotation)
          .addNode("rewrite_query", (state) => ({
            query: `query: ${state.query}`,
          }))
          .addNode("analyzer_one", (state) => ({
            query: `analyzed: ${state.query}`,
          }))
          .addNode("retriever_one", () => ({ docs: ["doc1", "doc2"] }))
          .addNode("retriever_two", async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { docs: ["doc3", "doc4"] };
          })
          .addNode("qa", (state) => ({ answer: state.docs?.join(",") }), {
            defer: true,
          })
          .addEdge(START, "rewrite_query")
          .addEdge("rewrite_query", "retriever_one")
          .addEdge("retriever_one", "analyzer_one")
          .addEdge("rewrite_query", "retriever_two");

        if (waitingEdge) {
          builder.addEdge(["retriever_one", "retriever_two"], "qa");
        } else {
          builder.addEdge("retriever_one", "qa").addEdge("retriever_two", "qa");
        }
        builder.addEdge("qa", END);

        const app = builder.compile();
        expect(await app.invoke({ query: "what is weather in sf" })).toEqual({
          query: "analyzed: query: what is weather in sf",
          docs: ["doc1", "doc2", "doc3", "doc4"],
          answer: "doc1,doc2,doc3,doc4",
        });

        expect(
          await gatherIterator(app.stream({ query: "what is weather in sf" }))
        ).toEqual([
          { rewrite_query: { query: "query: what is weather in sf" } },
          { retriever_one: { docs: ["doc1", "doc2"] } },
          { retriever_two: { docs: ["doc3", "doc4"] } },
          {
            analyzer_one: { query: "analyzed: query: what is weather in sf" },
          },
          { qa: { answer: "doc1,doc2,doc3,doc4" } },
        ]);

        expect(
          await gatherIterator(
            app.stream(
              { query: "what is weather in sf" },
              { streamMode: "debug" }
            )
          )
        ).toMatchObject([
          {
            type: "task",
            timestamp: expect.any(String),
            step: 1,
            payload: {
              id: expect.any(String),
              name: "rewrite_query",
              input: { query: "what is weather in sf" },
              triggers: ["branch:to:rewrite_query"],
            },
          },
          {
            type: "task_result",
            timestamp: expect.any(String),
            step: 1,
            payload: {
              id: expect.any(String),
              name: "rewrite_query",
              result: [["query", "query: what is weather in sf"]],
              interrupts: [],
            },
          },
          {
            type: "task",
            timestamp: expect.any(String),
            step: 2,
            payload: {
              id: expect.any(String),
              name: "retriever_one",
              input: { query: "query: what is weather in sf" },
              triggers: ["branch:to:retriever_one"],
            },
          },
          {
            type: "task",
            timestamp: expect.any(String),
            step: 2,
            payload: {
              id: expect.any(String),
              name: "retriever_two",
              input: { query: "query: what is weather in sf" },
              triggers: ["branch:to:retriever_two"],
            },
          },
          {
            type: "task_result",
            timestamp: expect.any(String),
            step: 2,
            payload: {
              id: expect.any(String),
              name: "retriever_one",
              result: [["docs", ["doc1", "doc2"]]],
              interrupts: [],
            },
          },
          {
            type: "task_result",
            timestamp: expect.any(String),
            step: 2,
            payload: {
              id: expect.any(String),
              name: "retriever_two",
              result: [["docs", ["doc3", "doc4"]]],
              interrupts: [],
            },
          },
          {
            type: "task",
            timestamp: expect.any(String),
            step: 3,
            payload: {
              id: expect.any(String),
              name: "analyzer_one",
              input: {
                query: "query: what is weather in sf",
                docs: ["doc1", "doc2", "doc3", "doc4"],
              },
              triggers: ["branch:to:analyzer_one"],
            },
          },
          {
            type: "task_result",
            timestamp: expect.any(String),
            step: 3,
            payload: {
              id: expect.any(String),
              name: "analyzer_one",
              result: [["query", "analyzed: query: what is weather in sf"]],
              interrupts: [],
            },
          },
          {
            type: "task",
            timestamp: expect.any(String),
            step: 4,
            payload: {
              id: expect.any(String),
              name: "qa",
              input: {
                query: "analyzed: query: what is weather in sf",
                docs: ["doc1", "doc2", "doc3", "doc4"],
              },
              triggers: waitingEdge
                ? ["join:retriever_one+retriever_two:qa"]
                : ["branch:to:qa"],
            },
          },
          {
            type: "task_result",
            timestamp: expect.any(String),
            step: 4,
            payload: {
              id: expect.any(String),
              name: "qa",
              result: [["answer", "doc1,doc2,doc3,doc4"]],
              interrupts: [],
            },
          },
        ]);

        const checkpointer = new MemorySaverAssertImmutable();
        const config = { configurable: { thread_id: "2" } };
        const appWithInterrupt = builder.compile({
          interruptBefore: ["qa"],
          checkpointer,
        });

        expect(
          await gatherIterator(
            appWithInterrupt.stream({ query: "what is weather in sf" }, config)
          )
        ).toEqual([
          { rewrite_query: { query: "query: what is weather in sf" } },
          { retriever_one: { docs: ["doc1", "doc2"] } },
          { retriever_two: { docs: ["doc3", "doc4"] } },
          { analyzer_one: { query: "analyzed: query: what is weather in sf" } },
          { __interrupt__: [] },
        ]);

        await appWithInterrupt.updateState(config, { docs: ["doc5"] });

        expect(await appWithInterrupt.getState(config)).toMatchObject({
          values: {
            query: "analyzed: query: what is weather in sf",
            docs: ["doc1", "doc2", "doc3", "doc4", "doc5"],
          },
          next: ["qa"],
          config: { configurable: { thread_id: "2" } },
          createdAt: expect.any(String),
          metadata: {
            source: "update",
            step: 4,
            writes: { analyzer_one: { docs: ["doc5"] } },
            thread_id: "2",
          },
        });
      }
    );

    it.each([
      [{ cachePolicy: true, slowCache: false }],
      [{ cachePolicy: true, slowCache: true }],
      [{ cachePolicy: false, slowCache: false }],
    ])(
      "in one fan out state graph waiting edge multiple (%s)",
      async ({ cachePolicy, slowCache }) => {
        const sortedAdd = vi.fn((x: string[], y: string[]): string[] =>
          [...x, ...y].sort()
        );

        const cache = slowCache ? new SlowInMemoryCache() : new InMemoryCache();
        const State = Annotation.Root({
          query: Annotation<string>,
          answer: Annotation<string>,
          docs: Annotation<string[]>({ reducer: sortedAdd }),
        });

        let rewriteQueryCount = 0;
        const graph = new StateGraph(State)
          .addNode(
            "rewrite_query",
            (state) => {
              rewriteQueryCount += 1;
              return { query: `query: ${state.query}` };
            },
            { cachePolicy }
          )
          .addNode("analyzer_one", (state) => ({
            query: `analyzed: ${state.query}`,
          }))
          .addNode("retriever_one", () => ({ docs: ["doc1", "doc2"] }))
          .addNode("retriever_two", async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { docs: ["doc3", "doc4"] };
          })
          .addNode("qa", (state) => ({ answer: state.docs.join(",") }))
          .addNode("decider", () => ({}))

          .addEdge(START, "rewrite_query")
          .addEdge("rewrite_query", "analyzer_one")
          .addEdge("analyzer_one", "retriever_one")
          .addEdge("rewrite_query", "retriever_two")
          .addEdge(["retriever_one", "retriever_two"], "decider")

          .addConditionalEdges(
            "decider",
            (state) => {
              if (state.query.split("analyzed").length - 1 > 1) return "qa";
              return "rewrite_query";
            },
            ["qa", "rewrite_query"]
          )
          .compile({ cache });

        expect(await graph.invoke({ query: "what is weather in sf" })).toEqual({
          query: "analyzed: query: analyzed: query: what is weather in sf",
          answer: "doc1,doc1,doc2,doc2,doc3,doc3,doc4,doc4",
          docs: [
            "doc1",
            "doc1",
            "doc2",
            "doc2",
            "doc3",
            "doc3",
            "doc4",
            "doc4",
          ],
        });

        expect(
          await gatherIterator(graph.stream({ query: "what is weather in sf" }))
        ).toEqual([
          cachePolicy
            ? {
                rewrite_query: { query: "query: what is weather in sf" },
                __metadata__: { cached: true },
              }
            : { rewrite_query: { query: "query: what is weather in sf" } },
          {
            analyzer_one: { query: "analyzed: query: what is weather in sf" },
          },
          { retriever_two: { docs: ["doc3", "doc4"] } },
          { retriever_one: { docs: ["doc1", "doc2"] } },
          { decider: {} },
          cachePolicy
            ? {
                rewrite_query: {
                  query: "query: analyzed: query: what is weather in sf",
                },
                __metadata__: { cached: true },
              }
            : {
                rewrite_query: {
                  query: "query: analyzed: query: what is weather in sf",
                },
              },
          {
            analyzer_one: {
              query: "analyzed: query: analyzed: query: what is weather in sf",
            },
          },
          { retriever_two: { docs: ["doc3", "doc4"] } },
          { retriever_one: { docs: ["doc1", "doc2"] } },
          { decider: {} },
          { qa: { answer: "doc1,doc1,doc2,doc2,doc3,doc3,doc4,doc4" } },
        ]);

        expect(rewriteQueryCount).toBe(cachePolicy ? 2 : 4);

        if (cachePolicy) {
          await graph.clearCache();

          expect(
            await graph.invoke({ query: "what is weather in sf" })
          ).toEqual({
            query: "analyzed: query: analyzed: query: what is weather in sf",
            answer: "doc1,doc1,doc2,doc2,doc3,doc3,doc4,doc4",
            docs: [
              "doc1",
              "doc1",
              "doc2",
              "doc2",
              "doc3",
              "doc3",
              "doc4",
              "doc4",
            ],
          });

          expect(rewriteQueryCount).toBe(4);
        }
      }
    );

    it("should handle dynamic interrupt", async () => {
      const checkpointer = await createCheckpointer();

      let toolTwoNodeCount = 0;

      const StateAnnotation = Annotation.Root({
        my_key: Annotation<string>({ reducer: (a, b) => a + b }),
        market: Annotation<string>(),
      });

      const toolTwoNode = (
        s: typeof StateAnnotation.State
      ): Partial<typeof StateAnnotation.State> => {
        toolTwoNodeCount += 1;
        const answer: string =
          s.market === "DE" ? interrupt("Just because...") : " all good";
        return { my_key: answer };
      };

      const toolTwoGraph = new StateGraph(StateAnnotation)
        .addNode("tool_two", toolTwoNode, {
          retryPolicy: { logWarning: false },
        })
        .addEdge(START, "tool_two");
      let toolTwo = toolTwoGraph.compile();

      const tracer = new FakeTracer();
      const result = await toolTwo.invoke(
        { my_key: "value", market: "DE" },
        { callbacks: [tracer] }
      );
      expect(result).toEqual({
        my_key: "value",
        market: "DE",
        __interrupt__: [
          {
            value: "Just because...",
            resumable: true,
            when: "during",
            ns: [expect.stringMatching(/^tool_two:/)],
          },
        ],
      });
      expect(toolTwoNodeCount).toBe(1); // interrupts aren't retried
      expect(tracer.runs.length).toBe(1);
      const run = tracer.runs[0];
      expect(run.end_time).toBeDefined();
      expect(run.error).toBeUndefined();
      expect(run.outputs).toEqual({ market: "DE", my_key: "value" });

      expect(await toolTwo.invoke({ my_key: "value", market: "US" })).toEqual({
        my_key: "value all good",
        market: "US",
      });

      toolTwo = toolTwoGraph.compile({ checkpointer });

      // missing thread_id
      await expect(
        toolTwo.invoke({ my_key: "value", market: "DE" })
      ).rejects.toThrow(/thread_id/);

      const thread1 = { configurable: { thread_id: "1" } };
      // stop when about to enter node
      expect(
        await toolTwo.invoke({ my_key: "value ⛰️", market: "DE" }, thread1)
      ).toEqual({
        my_key: "value ⛰️",
        market: "DE",
        __interrupt__: [
          {
            value: "Just because...",
            resumable: true,
            when: "during",
            ns: [expect.stringMatching(/^tool_two:/)],
          },
        ],
      });

      const toolTwoCheckpointer = toolTwo.checkpointer as BaseCheckpointSaver;
      const checkpoints = await gatherIterator(
        toolTwoCheckpointer.list(thread1)
      );
      expect(checkpoints.map((c) => c.metadata)).toEqual([
        {
          source: "loop",
          step: 0,
          writes: null,
          parents: {},
        },
        {
          source: "input",
          step: -1,
          writes: { __start__: { my_key: "value ⛰️", market: "DE" } },
          parents: {},
        },
      ]);

      const state = await toolTwo.getState(thread1);
      expect(state).toEqual({
        values: { my_key: "value ⛰️", market: "DE" },
        next: ["tool_two"],
        tasks: [
          {
            id: expect.any(String),
            name: "tool_two",
            path: [PULL, "tool_two"],
            interrupts: [
              {
                ns: [expect.stringMatching(/^tool_two:/)],
                resumable: true,
                value: "Just because...",
                when: "during",
              },
            ],
          },
        ],
        config: (await toolTwoCheckpointer.getTuple(thread1))!.config,
        createdAt: (await toolTwoCheckpointer.getTuple(thread1))!.checkpoint.ts,
        metadata: {
          source: "loop",
          step: 0,
          writes: null,
          parents: {},
          thread_id: "1",
        },
        parentConfig: (
          await gatherIterator(toolTwoCheckpointer.list(thread1, { limit: 2 }))
        ).slice(-1)[0].config,
      });

      // resume execution
      expect(
        await gatherIterator(
          toolTwo.stream(new Command({ resume: " this is great" }), {
            configurable: { thread_id: "1" },
          })
        )
      ).toEqual([
        {
          tool_two: {
            my_key: " this is great",
          },
        },
      ]);
    });

    it("should not cancel node on other node interrupted", async () => {
      const checkpointer = await createCheckpointer();

      const StateAnnotation = Annotation.Root({
        hello: Annotation<string>,
      });

      let awhiles = 0;
      let awhileReturns = 0;

      const awhile = async (
        _: typeof StateAnnotation.State
      ): Promise<Partial<typeof StateAnnotation.State>> => {
        awhiles += 1;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        awhileReturns += 1;
        return { hello: "again" };
      };

      const iambad = async (input: typeof StateAnnotation.State) => {
        if (input.hello !== "bye") {
          throw new NodeInterrupt("I am bad");
        }
        return {};
      };

      const builder = new StateGraph(StateAnnotation)
        .addNode("agent", awhile)
        .addNode("bad", iambad)
        .addConditionalEdges(START, () => ["agent", "bad"]);

      const graph = builder.compile({ checkpointer });
      const thread = { configurable: { thread_id: "1" } };

      // Return state at interrupt time
      expect(await graph.invoke({ hello: "world" }, thread)).toEqual({
        hello: "again",
        __interrupt__: [
          {
            value: "I am bad",
            when: "during",
          },
        ],
      });

      expect(awhileReturns).toBe(1);
      expect(awhiles).toBe(1);

      // Invoking a graph with no more tasks should return the final value
      expect(await graph.invoke(null, thread)).toEqual({
        hello: "again",
        __interrupt__: [
          {
            value: "I am bad",
            when: "during",
          },
        ],
      });

      expect(awhileReturns).toBe(1);
      expect(awhiles).toBe(1);

      expect(await graph.invoke({ hello: "bye" }, thread)).toEqual({
        hello: "again",
      });

      expect(awhileReturns).toBe(2);
      expect(awhiles).toBe(2);
    });

    it("Should log a warning if a NodeInterrupt is thrown in a conditional edge", async () => {
      // Mock console.warn
      const originalWarn = console.warn;
      console.warn = vi.fn();

      const GraphAnnotation = Annotation.Root({
        count: Annotation<number>({ reducer: (a, b) => a + b }),
      });

      const nodeOne = (_: typeof GraphAnnotation.State) => {
        return {
          count: 1,
        };
      };

      const nodeTwo = (_: typeof GraphAnnotation.State) => {
        return {
          count: 1,
        };
      };

      const shouldContinue = (
        _: typeof GraphAnnotation.State
      ): typeof END | "nodeTwo" => {
        throw new NodeInterrupt("Interrupted");
      };

      const workflow = new StateGraph(GraphAnnotation)
        .addNode("nodeOne", nodeOne)
        .addNode("nodeTwo", nodeTwo)
        .addEdge(START, "nodeOne")
        .addEdge("nodeTwo", "nodeOne")
        .addConditionalEdges("nodeOne", shouldContinue, [END, "nodeTwo"]);
      const app = workflow.compile();
      await app.invoke({
        count: 0,
      });
      // expect console.warn to have been called
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.warn).toHaveBeenCalledWith(
        "[WARN]: 'NodeInterrupt' thrown in conditional edge. This is likely a bug in your graph implementation.\n" +
          "NodeInterrupt should only be thrown inside a node, not in edge conditions."
      );
      // Restore console.warn
      console.warn = originalWarn;
    });

    it("Allow map reduce flows", async () => {
      const OverallState = Annotation.Root({
        subjects: Annotation<string[]>,
        jokes: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
        }),
      });
      const continueToJokes = async (state: typeof OverallState.State) => {
        return state.subjects.map((subject) => {
          return new Send("generate_joke", { subjects: [subject] });
        });
      };
      const graph = new StateGraph(OverallState)
        .addNode("generate_joke", (state) => ({
          jokes: [`Joke about ${state.subjects}`],
        }))
        .addConditionalEdges("__start__", continueToJokes)
        .addEdge("generate_joke", "__end__")
        .compile();
      const res = await graph.invoke({ subjects: ["cats", "dogs"] });
      // Invoking with two subjects results in a generated joke for each
      expect(res).toEqual({
        subjects: ["cats", "dogs"],
        jokes: [`Joke about cats`, `Joke about dogs`],
      });
    });

    it("Supports automatic streaming with streamMode messages", async () => {
      const llm = new FakeChatModel({
        responses: [
          new AIMessage({
            id: "ai1",
            content: "foobar",
          }),
        ],
      });

      const StateAnnotation = Annotation.Root({
        question: Annotation<string>,
        answer: Annotation<string>,
      });

      const generate = async (state: typeof StateAnnotation.State) => {
        const response = await llm.invoke(state.question);
        return { answer: response.content as string };
      };

      // Compile application and test
      const graph = new StateGraph(StateAnnotation)
        .addNode("generate", generate)
        .addNode(
          "nostream_generate",
          RunnableLambda.from(generate).withConfig({
            tags: [TAG_NOSTREAM],
          })
        )
        .addEdge("__start__", "generate")
        .addEdge("generate", "nostream_generate")
        .compile();

      const inputs = { question: "How are you?" };

      const stream = await graph.stream(inputs, { streamMode: "messages" });

      const aiMessageChunks = [];
      for await (const [message] of stream) {
        aiMessageChunks.push(message);
      }
      expect(aiMessageChunks.length).toBeGreaterThan(1);
      expect(aiMessageChunks.map((chunk) => chunk.content).join("")).toEqual(
        "foobar"
      );
    });

    it("State graph packets", async () => {
      const AgentState = Annotation.Root({
        messages: Annotation({
          reducer: messagesStateReducer,
        }),
      });
      const searchApi = tool(
        async ({ query }) => {
          return `result for ${query}`;
        },
        {
          name: "search_api",
          schema: z.object({
            query: z.string(),
          }),
          description: "Searches the API for the query",
        }
      );

      const toolsByName = { [searchApi.name]: searchApi };
      const model = new FakeChatModel({
        responses: [
          new AIMessage({
            id: "ai1",
            content: "",
            tool_calls: [
              {
                id: "tool_call123",
                name: "search_api",
                args: { query: "query" },
                type: "tool_call",
              },
            ],
          }),
          new AIMessage({
            id: "ai2",
            content: "",
            tool_calls: [
              {
                id: "tool_call234",
                name: "search_api",
                args: { query: "another", idx: 0 },
                type: "tool_call",
              },
              {
                id: "tool_call567",
                name: "search_api",
                args: { query: "a third one", idx: 1 },
                type: "tool_call",
              },
            ],
          }),
          new AIMessage({
            id: "ai3",
            content: "answer",
          }),
        ],
      });

      const agent = async (state: typeof AgentState.State) => {
        return {
          messages: await model.invoke(state.messages),
        };
      };

      const shouldContinue = async (state: typeof AgentState.State) => {
        // TODO: Support this?
        // expect(state.something_extra).toEqual("hi there");
        const toolCalls = (
          state.messages[state.messages.length - 1] as AIMessage
        ).tool_calls;
        if (toolCalls?.length) {
          return toolCalls.map((toolCall) => {
            return new Send("tools", toolCall);
          });
        } else {
          return "__end__";
        }
      };

      const toolsNode = async (toolCall: ToolCall) => {
        await new Promise((resolve) =>
          setTimeout(resolve, (toolCall.args.idx ?? 0 + 1) * 100)
        );
        const toolMessage = await toolsByName[toolCall.name].invoke(toolCall);
        return {
          messages: new ToolMessage({
            content: toolMessage.content,
            id:
              toolCall.args.idx !== undefined ? `${toolCall.args.idx}` : "abc",
            tool_call_id: toolMessage.tool_call_id,
            name: toolMessage.name,
          }),
        };
      };

      const builder = new StateGraph(AgentState)
        .addNode("agent", agent)
        .addNode("tools", toolsNode)
        .addEdge("__start__", "agent")
        .addConditionalEdges("agent", shouldContinue)
        .addEdge("tools", "agent");
      const inputMessage = new HumanMessage({
        id: "foo",
        content: "what is weather in sf",
      });
      const expectedOutputMessages = [
        inputMessage,
        new AIMessage({
          id: "ai1",
          content: "",
          tool_calls: [
            {
              id: "tool_call123",
              name: "search_api",
              args: { query: "query" },
              type: "tool_call",
            },
          ],
        }),
        new ToolMessage({
          id: "abc",
          content: "result for query",
          name: "search_api",
          tool_call_id: "tool_call123",
        }),
        new AIMessage({
          id: "ai2",
          content: "",
          tool_calls: [
            {
              id: "tool_call234",
              name: "search_api",
              args: { query: "another", idx: 0 },
              type: "tool_call",
            },
            {
              id: "tool_call567",
              name: "search_api",
              args: { query: "a third one", idx: 1 },
              type: "tool_call",
            },
          ],
        }),
        new ToolMessage({
          id: "0",
          content: "result for another",
          name: "search_api",
          tool_call_id: "tool_call234",
        }),
        new ToolMessage({
          id: "1",
          content: "result for a third one",
          name: "search_api",
          tool_call_id: "tool_call567",
        }),
        new AIMessage({
          id: "ai3",
          content: "answer",
        }),
      ];
      const res = await builder.compile().invoke({
        messages: [inputMessage],
      });
      expect(res).toEqual({
        messages: expectedOutputMessages,
      });

      const stream = await builder.compile().stream({
        messages: [inputMessage],
      });
      let chunks = await gatherIterator(stream);
      const nodeOrder = ["agent", "tools", "agent", "tools", "tools", "agent"];
      expect(nodeOrder.length).toEqual(chunks.length);
      expect(chunks).toEqual(
        // The input message is not streamed back
        expectedOutputMessages.slice(1).map((message, i) => {
          return {
            [nodeOrder[i]]: { messages: message },
          };
        })
      );

      const appWithInterrupt = builder.compile({
        checkpointer: await createCheckpointer(),
        interruptAfter: ["agent"],
      });
      const config = { configurable: { thread_id: "1" } };
      chunks = await gatherIterator(
        appWithInterrupt.stream(
          {
            messages: [inputMessage],
          },
          config
        )
      );
      expect(chunks).toEqual([
        {
          agent: {
            messages: expectedOutputMessages[1],
          },
        },
        { [INTERRUPT]: [] },
      ]);
      const appWithInterruptState = await appWithInterrupt.getState(config);
      const appWithInterruptCheckpointer =
        appWithInterrupt.checkpointer as BaseCheckpointSaver;
      expect(appWithInterruptState).toEqual({
        values: {
          messages: expectedOutputMessages.slice(0, 2),
        },
        tasks: [
          {
            id: expect.any(String),
            name: "tools",
            path: [PUSH, 0],
            interrupts: [],
          },
        ],
        next: ["tools"],
        metadata: {
          source: "loop",
          step: 1,
          writes: {
            agent: {
              messages: expectedOutputMessages[1],
            },
          },
          parents: {},
          thread_id: "1",
        },
        config: (await appWithInterruptCheckpointer.getTuple(config))?.config,
        createdAt: (await appWithInterruptCheckpointer.getTuple(config))
          ?.checkpoint.ts,
        parentConfig: (
          await gatherIterator(
            appWithInterruptCheckpointer.list(config, { limit: 2 })
          )
        ).slice(-1)[0].config,
      });

      // modify ai message
      const lastMessage =
        appWithInterruptState!.values.messages[
          appWithInterruptState!.values.messages.length - 1
        ];
      lastMessage.tool_calls[0].args.query = "a different query";
      await appWithInterrupt.updateState(config, {
        messages: lastMessage,
        something_extra: "hi there",
      });
      expect(await appWithInterrupt.getState(config)).toEqual({
        values: {
          messages: [
            expectedOutputMessages[0],
            new AIMessage({
              id: "ai1",
              content: "",
              tool_calls: [
                {
                  id: "tool_call123",
                  name: "search_api",
                  args: { query: "a different query" },
                  type: "tool_call",
                },
              ],
            }),
          ],
        },
        next: ["tools"],
        tasks: [
          {
            id: expect.any(String),
            name: "tools",
            path: [PUSH, 0],
            interrupts: [],
          },
        ],
        metadata: {
          parents: {},
          thread_id: "1",
          source: "update",
          step: 2,
          writes: {
            agent: {
              messages: new AIMessage({
                id: "ai1",
                content: "",
                tool_calls: [
                  {
                    id: "tool_call123",
                    name: "search_api",
                    args: { query: "a different query" },
                    type: "tool_call",
                  },
                ],
              }),
              something_extra: "hi there",
            },
          },
        },
        config: (await appWithInterruptCheckpointer.getTuple(config))?.config,
        createdAt: (await appWithInterruptCheckpointer.getTuple(config))
          ?.checkpoint.ts,
        parentConfig: (
          await gatherIterator(
            appWithInterruptCheckpointer.list(config, { limit: 2 })
          )
        ).slice(-1)[0].config,
      });

      chunks = await gatherIterator(appWithInterrupt.stream(null, config));
      expect(chunks).toEqual([
        {
          tools: {
            messages: new ToolMessage({
              id: "abc",
              content: "result for a different query",
              name: "search_api",
              tool_call_id: "tool_call123",
            }),
          },
        },
        {
          agent: {
            messages: expectedOutputMessages[3],
          },
        },
        { [INTERRUPT]: [] },
      ]);

      expect(await appWithInterrupt.getState(config)).toEqual({
        values: {
          messages: [
            expectedOutputMessages[0],
            new AIMessage({
              id: "ai1",
              content: "",
              tool_calls: [
                {
                  id: "tool_call123",
                  name: "search_api",
                  args: { query: "a different query" },
                  type: "tool_call",
                },
              ],
            }),
            new ToolMessage({
              id: "abc",
              content: "result for a different query",
              name: "search_api",
              tool_call_id: "tool_call123",
            }),
            expectedOutputMessages[3],
          ],
        },
        next: ["tools", "tools"],
        tasks: [
          {
            id: expect.any(String),
            name: "tools",
            path: [PUSH, 0],
            interrupts: [],
          },
          {
            id: expect.any(String),
            name: "tools",
            path: [PUSH, 1],
            interrupts: [],
          },
        ],
        metadata: {
          parents: {},
          thread_id: "1",
          source: "loop",
          step: 4,
          writes: {
            agent: {
              messages: expectedOutputMessages[3],
            },
          },
        },
        createdAt: (await appWithInterruptCheckpointer.getTuple(config))
          ?.checkpoint.ts,
        config: (await appWithInterruptCheckpointer.getTuple(config))?.config,
        parentConfig: (
          await gatherIterator(
            appWithInterruptCheckpointer.list(config, { limit: 2 })
          )
        ).slice(-1)[0].config,
      });

      // replaces message even if object identity is different, as long as id is the same
      await appWithInterrupt.updateState(config, {
        messages: new AIMessage({
          id: "ai2",
          content: "answer",
        }),
        something_extra: "hi there",
      });

      expect(await appWithInterrupt.getState(config)).toEqual({
        values: {
          messages: [
            expectedOutputMessages[0],
            new AIMessage({
              id: "ai1",
              content: "",
              tool_calls: [
                {
                  id: "tool_call123",
                  name: "search_api",
                  args: { query: "a different query" },
                  type: "tool_call",
                },
              ],
            }),
            new ToolMessage({
              id: "abc",
              content: "result for a different query",
              name: "search_api",
              tool_call_id: "tool_call123",
            }),
            new AIMessage({
              content: "answer",
              id: "ai2",
            }),
          ],
        },
        next: [],
        tasks: [],
        metadata: {
          source: "update",
          step: 5,
          parents: {},
          thread_id: "1",
          writes: {
            agent: {
              messages: new AIMessage({
                content: "answer",
                id: "ai2",
              }),
              something_extra: "hi there",
            },
          },
        },
        createdAt: (await appWithInterruptCheckpointer.getTuple(config))
          ?.checkpoint.ts,
        config: (await appWithInterruptCheckpointer.getTuple(config))?.config,
        parentConfig: (
          await gatherIterator(
            appWithInterruptCheckpointer.list(config, { limit: 2 })
          )
        ).slice(-1)[0].config,
      });
    });

    it("multiple stream mode", async () => {
      const builder = new StateGraph({
        value: Annotation<number>({ reducer: (a, b) => a + b }),
      })
        .addNode("add_one", () => ({ value: 1 }))
        .addEdge(START, "add_one")
        .addConditionalEdges("add_one", (state) => {
          if (state.value < 6) return "add_one";
          return END;
        });

      const graph = builder.compile();

      // Default is updates
      expect(await gatherIterator(graph.stream({ value: 1 }))).toEqual([
        { add_one: { value: 1 } },
        { add_one: { value: 1 } },
        { add_one: { value: 1 } },
        { add_one: { value: 1 } },
        { add_one: { value: 1 } },
      ]);

      expect(
        await gatherIterator(
          graph.stream({ value: 1 }, { streamMode: "values" })
        )
      ).toEqual([
        { value: 1 },
        { value: 2 },
        { value: 3 },
        { value: 4 },
        { value: 5 },
        { value: 6 },
      ]);

      expect(
        await gatherIterator(
          graph.stream({ value: 1 }, { streamMode: ["values"] })
        )
      ).toEqual([
        ["values", { value: 1 }],
        ["values", { value: 2 }],
        ["values", { value: 3 }],
        ["values", { value: 4 }],
        ["values", { value: 5 }],
        ["values", { value: 6 }],
      ]);

      expect(
        await gatherIterator(
          graph.stream({ value: 1 }, { streamMode: ["updates"] })
        )
      ).toEqual([
        ["updates", { add_one: { value: 1 } }],
        ["updates", { add_one: { value: 1 } }],
        ["updates", { add_one: { value: 1 } }],
        ["updates", { add_one: { value: 1 } }],
        ["updates", { add_one: { value: 1 } }],
      ]);

      expect(
        await gatherIterator(
          graph.stream({ value: 1 }, { streamMode: ["values", "updates"] })
        )
      ).toEqual([
        ["values", { value: 1 }],
        ["updates", { add_one: { value: 1 } }],
        ["values", { value: 2 }],
        ["updates", { add_one: { value: 1 } }],
        ["values", { value: 3 }],
        ["updates", { add_one: { value: 1 } }],
        ["values", { value: 4 }],
        ["updates", { add_one: { value: 1 } }],
        ["values", { value: 5 }],
        ["updates", { add_one: { value: 1 } }],
        ["values", { value: 6 }],
      ]);
    });

    it("should handle node schemas with custom output", async () => {
      const StateAnnotation = Annotation.Root({
        hello: Annotation<string>,
        bye: Annotation<string>,
        messages: Annotation<string[]>({
          reducer: (a: string[], b: string[]) => [...a, ...b],
          default: () => [],
        }),
      });

      const OutputAnnotation = Annotation.Root({
        messages: Annotation<string[]>,
        extraOutput: Annotation<string>,
      });

      const nodeA = (state: { hello: string; messages: string[] }) => {
        // Unfortunately can't infer input types at runtime :(
        expect(state).toEqual({
          bye: "world",
          hello: "there",
          messages: ["hello"],
        });
        return {};
      };

      const nodeB = (state: { bye: string; now: number }) => {
        // Unfortunately can't infer input types at runtime :(
        expect(state).toEqual({
          bye: "world",
          hello: "there",
          messages: ["hello"],
        });
        return {
          hello: "again",
          now: 123,
        };
      };

      const nodeC = (state: { hello: string }) => {
        // Unfortunately can't infer input types at runtime :(
        expect(state).toEqual({
          bye: "world",
          hello: "again",
          messages: ["hello"],
        });
        return {};
      };

      const graph = new StateGraph({
        stateSchema: StateAnnotation,
        output: OutputAnnotation,
      })
        .addNode("a", nodeA)
        .addNode("b", nodeB)
        .addNode("c", nodeC)
        .addEdge(START, "a")
        .addEdge("a", "b")
        .addEdge("b", "c")
        .compile();

      const res = await graph.invoke({
        hello: "there",
        bye: "world",
        messages: ["hello"],
        // @ts-expect-error Output schema properties should not be part of input types
        extraOutput: "bar",
      });

      // State graph should respect output typing
      void res.extraOutput;

      expect(res).toEqual({
        messages: ["hello"],
      });

      const graphWithInput = new StateGraph({
        input: StateAnnotation,
        output: OutputAnnotation,
      })
        .addNode("a", nodeA)
        .addNode("b", nodeB)
        .addNode("c", nodeC)
        .addEdge(START, "a")
        .addEdge("a", "b")
        .addEdge("b", "c")
        .compile();

      expect(
        await graphWithInput.invoke({
          hello: "there",
          bye: "world",
          messages: ["hello"],
          // @ts-expect-error This should emit a TS error
          now: 345, // ignored because not in input schema
        })
      ).toEqual({
        messages: ["hello"],
      });

      expect(
        await gatherIterator(
          graphWithInput.stream({
            hello: "there",
            bye: "world",
            messages: ["hello"],
            // @ts-expect-error This should emit a TS error
            now: 345, // ignored because not in input schema
          })
        )
      ).toEqual([{ a: {} }, { b: { hello: "again" } }, { c: {} }]);

      const res2 = await graph.invoke({
        hello: "there",
        bye: "world",
        messages: ["hello"],
        // @ts-expect-error Output schema properties should not be part of input types
        extraOutput: "bar",
      });

      // State graph should respect output typing
      void res2.extraOutput;
      // @ts-expect-error Output type should not have a field not in the output schema, even if in other state
      void res2.hello;
      // @ts-expect-error Output type should not have a field not in the output schema, even if in other state
      void res2.random;

      expect(res2).toEqual({
        messages: ["hello"],
      });

      const InputStateAnnotation = Annotation.Root({
        specialInputField: Annotation<string>,
      });

      const graphWithAllSchemas = new StateGraph({
        input: InputStateAnnotation,
        output: OutputAnnotation,
        stateSchema: StateAnnotation,
      })
        .addNode("preA", async () => {
          return {
            bye: "world",
            hello: "there",
            messages: ["hello"],
          };
        })
        .addNode("a", nodeA)
        .addNode("b", nodeB)
        .addNode("c", nodeC)
        .addEdge(START, "preA")
        .addEdge("preA", "a")
        .addEdge("a", "b")
        .addEdge("b", "c")
        .compile();

      const res3 = await graphWithAllSchemas.invoke({
        // @ts-expect-error Input type should not contain fields outside input schema, even if in other states
        hello: "there",
        specialInputField: "foo",
      });
      expect(res3).toEqual({
        messages: ["hello"],
      });

      // Extra output fields should be respected
      void res3.extraOutput;
      // @ts-expect-error Output type should not have a field not in the output schema, even if in other state
      void res3.hello;
      // @ts-expect-error Output type should not have a field not in the output schema, even if in other state
      void res3.random;
    });

    it("should use a retry policy", async () => {
      const checkpointer = await createCheckpointer(); // Replace with actual checkpointer implementation

      let erroredOnce = false;
      let nonRetryableErrorCount = 0;

      const GraphAnnotation = Annotation.Root({
        total: Annotation<number>,
        input: Annotation<number>,
      });

      const raiseIfAbove10 = ({ total }: typeof GraphAnnotation.State) => {
        if (total > 2) {
          if (!erroredOnce) {
            erroredOnce = true;
            const error = new Error("I will be retried");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (error as any).status = 500;
            throw error;
          }
        }
        if (total > 8) {
          nonRetryableErrorCount += 1;
          const error = new Error("Total is too large");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (error as any).status = 400;
          throw error;
        }
        return { total };
      };

      const add = ({ input, total }: typeof GraphAnnotation.State) => ({
        total: input + (total ?? 0),
      });

      const app = new StateGraph(GraphAnnotation)
        .addNode("add", add)
        .addNode("check", raiseIfAbove10, {
          retryPolicy: { logWarning: false },
        })
        .addEdge("__start__", "add")
        .addEdge("add", "check")
        .addEdge("check", "__end__")
        .compile({ checkpointer });

      // total starts out as 0, so output is 0+2=2
      expect(
        await app.invoke({ input: 2 }, { configurable: { thread_id: "1" } })
      ).toEqual({ input: 2, total: 2 });
      let checkpoint = await checkpointer.get({
        configurable: { thread_id: "1" },
      });
      expect(checkpoint).not.toBeNull();
      expect(checkpoint?.channel_values.total).toBe(2);
      expect(erroredOnce).toBe(false);
      expect(nonRetryableErrorCount).toBe(0);

      // total is now 2, so output is 2+3=5
      expect(
        await app.invoke({ input: 3 }, { configurable: { thread_id: "1" } })
      ).toEqual({ input: 3, total: 5 });
      expect(erroredOnce).toBeTruthy();
      let checkpointTuple = await checkpointer.getTuple({
        configurable: { thread_id: "1" },
      });
      expect(checkpointTuple).not.toBeNull();
      expect(erroredOnce).toBe(true);
      expect(nonRetryableErrorCount).toBe(0);

      // total is now 2+3=5, so output would be 5+4=9, but raises Error
      await expect(
        app.invoke({ input: 4 }, { configurable: { thread_id: "1" } })
      ).rejects.toThrow("Total is too large");

      // checkpoint is not updated, error is recorded
      checkpointTuple = await checkpointer.getTuple({
        configurable: { thread_id: "1" },
      });
      expect(checkpointTuple).not.toBeNull();
      expect(checkpointTuple?.pendingWrites).toEqual([
        [
          expect.any(String),
          "__error__",
          { message: "Total is too large", name: "Error" },
        ],
      ]);
      expect(nonRetryableErrorCount).toBe(1);

      // on a new thread, total starts out as 0, so output is 0+5=5
      expect(
        await app.invoke({ input: 5 }, { configurable: { thread_id: "2" } })
      ).toEqual({ input: 5, total: 5 });
      checkpoint = await checkpointer.get({
        configurable: { thread_id: "1" },
      });
      expect(checkpoint).not.toBeNull();
      checkpoint = await checkpointer.get({
        configurable: { thread_id: "2" },
      });
      expect(checkpoint).not.toBeNull();
      expect(checkpoint?.channel_values.total).toBe(5);
      expect(nonRetryableErrorCount).toBe(1);
    });

    it("should allow undefined values returned in a node update", async () => {
      interface GraphState {
        test?: string;
        reducerField?: string;
      }

      const graphState: StateGraphArgs<GraphState>["channels"] = {
        test: null,
        reducerField: {
          default: () => "",
          reducer: (x, y?: string) => y ?? x,
        },
      };

      const workflow = new StateGraph<GraphState>({ channels: graphState });

      async function updateTest(
        _state: GraphState
      ): Promise<Partial<GraphState>> {
        return {
          test: "test",
          reducerField: "should not be wiped",
        };
      }

      async function wipeFields(
        _state: GraphState
      ): Promise<Partial<GraphState>> {
        return {
          test: undefined,
          reducerField: undefined,
        };
      }

      workflow
        .addNode("updateTest", updateTest)
        .addNode("wipeFields", wipeFields)
        .addEdge(START, "updateTest")
        .addEdge("updateTest", "wipeFields")
        .addEdge("wipeFields", END);

      const checkpointer = await createCheckpointer();

      const app = workflow.compile({ checkpointer });
      const config: RunnableConfig = {
        configurable: { thread_id: "102" },
      };
      const res = await app.invoke(
        {
          messages: ["initial input"],
        },
        config
      );
      expect(res).toEqual({
        reducerField: "should not be wiped",
      });
      const history = await gatherIterator(app.getStateHistory(config));
      expect(history).toEqual([
        {
          values: {
            reducerField: "should not be wiped",
          },
          next: [],
          tasks: [],
          metadata: {
            thread_id: "102",
            source: "loop",
            writes: {
              wipeFields: {
                test: undefined,
                reducerField: undefined,
              },
            },
            step: 2,
            parents: {},
          },
          config: {
            configurable: {
              thread_id: "102",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "102",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: {
            test: "test",
            reducerField: "should not be wiped",
          },
          next: ["wipeFields"],
          tasks: [
            {
              id: expect.any(String),
              name: "wipeFields",
              path: [PULL, "wipeFields"],
              interrupts: [],
            },
          ],
          metadata: {
            thread_id: "102",
            source: "loop",
            writes: {
              updateTest: {
                test: "test",
                reducerField: "should not be wiped",
              },
            },
            step: 1,
            parents: {},
          },
          config: {
            configurable: {
              thread_id: "102",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "102",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: {
            reducerField: "",
          },
          next: ["updateTest"],
          tasks: [
            {
              id: expect.any(String),
              name: "updateTest",
              path: [PULL, "updateTest"],
              interrupts: [],
            },
          ],
          metadata: {
            thread_id: "102",
            source: "loop",
            writes: null,
            step: 0,
            parents: {},
          },
          config: {
            configurable: {
              thread_id: "102",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "102",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: {
            reducerField: "",
          },
          next: ["__start__"],
          tasks: [
            {
              id: expect.any(String),
              name: "__start__",
              path: [PULL, "__start__"],
              interrupts: [],
            },
          ],
          metadata: {
            thread_id: "102",
            source: "input",
            writes: {
              __start__: {
                messages: ["initial input"],
              },
            },
            step: -1,
            parents: {},
          },
          config: {
            configurable: {
              thread_id: "102",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          createdAt: expect.any(String),
        },
      ]);
    });

    it("should allow custom configuration values", async () => {
      const StateAnnotation = Annotation.Root({
        hello: Annotation<string>,
      });

      const nodeA = (
        _: typeof StateAnnotation.State,
        config?: RunnableConfig
      ) => {
        // Unfortunately can't infer input types at runtime :(
        expect(config?.configurable?.foo).toEqual("bar");
        return {};
      };

      const nodeB = (
        _: typeof StateAnnotation.State,
        config?: RunnableConfig
      ) => {
        expect(config?.configurable?.foo).toEqual("bar");
        return {
          hello: "again",
          now: 123,
        };
      };

      const graph = new StateGraph(StateAnnotation)
        .addNode("a", nodeA)
        .addNode("b", nodeB)
        .addEdge(START, "a")
        .addEdge("a", "b")
        .compile();

      expect(
        await graph.invoke({ hello: "there" }, { configurable: { foo: "bar" } })
      ).toEqual({
        hello: "again",
      });
    });

    it("should allow private state passing between nodes", async () => {
      const StateAnnotation = Annotation.Root({
        hello: Annotation<string>,
      });

      const PrivateAnnotation = Annotation.Root({
        ...StateAnnotation.spec,
        privateProp: Annotation<string>,
      });

      const nodeA = (_: typeof StateAnnotation.State) => {
        return {
          privateProp: "secret",
        };
      };

      const nodeB = (state: typeof PrivateAnnotation.State) => {
        expect(state).toEqual({ privateProp: "secret", hello: "there" });
        return {
          hello: "again",
          now: 123,
        };
      };

      const graph = new StateGraph(StateAnnotation)
        .addNode("a", nodeA)
        .addNode("b", nodeB, { input: PrivateAnnotation })
        .addEdge(START, "a")
        .addEdge("a", "b")
        .compile();

      expect(await graph.invoke({ hello: "there" })).toEqual({
        hello: "again",
      });
    });

    it("should expose config schema as a type", async () => {
      const StateAnnotation = Annotation.Root({
        hello: Annotation<string>,
      });

      const ConfigurableAnnotation = Annotation.Root({
        shouldExist: Annotation<string>,
      });

      const nodeA = (
        _: typeof StateAnnotation.State,
        config: RunnableConfig<typeof ConfigurableAnnotation.State>
      ) => {
        expect(config.configurable?.shouldExist).toEqual("I exist");
        // @ts-expect-error Not in typing but should still be passed through
        expect(config.configurable?.shouldAlsoExist).toEqual(
          "I should also exist"
        );
        return {
          hello: "again",
        };
      };

      const nodeB = () => ({});

      const conditionalEdge = async (
        _: typeof StateAnnotation.State,
        config: RunnableConfig<typeof ConfigurableAnnotation.State>
      ) => {
        expect(config.configurable?.shouldExist).toEqual("I exist");
        // @ts-expect-error Not in typing but should still be passed through
        expect(config.configurable?.shouldAlsoExist).toEqual(
          "I should also exist"
        );
        return "__end__";
      };

      const checkpointer = await createCheckpointer();
      const graph = new StateGraph(StateAnnotation, ConfigurableAnnotation)
        .addNode("a", nodeA)
        .addNode("b", nodeB)
        .addEdge(START, "a")
        .addConditionalEdges("a", conditionalEdge)
        .compile({ checkpointer });

      expect(
        await graph.invoke(
          { hello: "there" },
          {
            configurable: {
              shouldExist: "I exist",
              shouldAlsoExist: "I should also exist",
              thread_id: "foo",
            },
          }
        )
      ).toEqual({
        hello: "again",
      });
    });
  });

  describe("PreBuilt", () => {
    class SearchAPI extends Tool {
      name = "search_api";

      description = "A simple API that returns the input string.";

      constructor() {
        super();
      }

      async _call(query: string): Promise<string> {
        return `result for ${query}`;
      }
    }
    const tools = [new SearchAPI()];

    it("Can invoke createAgentExecutor", async () => {
      const prompt = PromptTemplate.fromTemplate("Hello!");

      const llm = new FakeStreamingLLM({
        responses: [
          "tool:search_api:query",
          "tool:search_api:another",
          "finish:answer",
        ],
      });

      const agentParser = (input: string) => {
        if (input.startsWith("finish")) {
          const answer = input.split(":")[1];
          return {
            returnValues: { answer },
            log: input,
          };
        }
        const [, toolName, toolInput] = input.split(":");
        return {
          tool: toolName,
          toolInput,
          log: input,
        };
      };

      const agent = prompt.pipe(llm).pipe(agentParser);

      const agentExecutor = createAgentExecutor({
        agentRunnable: agent,
        tools,
      });

      const result = await agentExecutor.invoke({
        input: "what is the weather in sf?",
      });

      expect(result).toEqual({
        input: "what is the weather in sf?",
        agentOutcome: {
          returnValues: {
            answer: "answer",
          },
          log: "finish:answer",
        },
        steps: [
          {
            action: {
              log: "tool:search_api:query",
              tool: "search_api",
              toolInput: "query",
            },
            observation: "result for query",
          },
          {
            action: {
              log: "tool:search_api:another",
              tool: "search_api",
              toolInput: "another",
            },
            observation: "result for another",
          },
        ],
      });
    });
  });

  describe("MessageGraph", () => {
    class SearchAPI extends Tool {
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
    const tools = [new SearchAPI()];

    it("can invoke a single message", async () => {
      const model = new FakeChatModel({
        responses: [
          new AIMessage({
            content: "",
            additional_kwargs: {
              function_call: {
                name: "search_api",
                arguments: "query",
              },
            },
          }),
          new AIMessage({
            content: "",
            additional_kwargs: {
              function_call: {
                name: "search_api",
                arguments: "another",
              },
            },
          }),
          new AIMessage({
            content: "answer",
          }),
        ],
      });

      const toolExecutor = new ToolExecutor({ tools });

      const shouldContinue = (data: Array<BaseMessage>): string => {
        const lastMessage = data[data.length - 1];
        // If there is no function call, then we finish
        if (
          !("function_call" in lastMessage.additional_kwargs) ||
          !lastMessage.additional_kwargs.function_call
        ) {
          return "end";
        }
        // Otherwise if there is, we continue
        return "continue";
      };

      const callTool = async (
        data: Array<BaseMessage>,
        options?: RunnableConfig
      ) => {
        const lastMessage = data[data.length - 1];

        const action = {
          tool: lastMessage.additional_kwargs.function_call?.name ?? "",
          toolInput:
            lastMessage.additional_kwargs.function_call?.arguments ?? "",
          log: "",
        };

        const response = await toolExecutor.invoke(action, options);
        return new FunctionMessage({
          content: JSON.stringify(response),
          name: action.tool,
        });
      };

      const app = new MessageGraph()
        .addNode("agent", model)
        .addNode("action", callTool)
        .addEdge(START, "agent")
        .addConditionalEdges("agent", shouldContinue, {
          continue: "action",
          end: END,
        })
        .addEdge("action", "agent")
        .compile();

      expect(app.getGraph().toJSON()).toMatchObject({
        nodes: expect.arrayContaining([
          {
            id: "__start__",
            type: "schema",
            data: {
              $schema: "http://json-schema.org/draft-07/schema#",
              title: undefined,
            },
          },
          {
            id: "agent",
            type: "runnable",
            data: {
              id: ["langchain", "chat_models", "fake", "FakeChatModel"],
              name: "FakeChatModel",
            },
          },
          {
            id: "action",
            type: "runnable",
            data: {
              id: ["langgraph", "RunnableCallable"],
              name: "action",
            },
          },
          {
            id: "__end__",
            type: "schema",
            data: {
              $schema: "http://json-schema.org/draft-07/schema#",
              title: undefined,
            },
          },
        ]),
        edges: expect.arrayContaining([
          { conditional: false, source: "__start__", target: "agent" },
          { conditional: false, source: "action", target: "agent" },
          {
            source: "agent",
            target: "action",
            data: "continue",
            conditional: true,
          },
          {
            source: "agent",
            target: "__end__",
            data: "end",
            conditional: true,
          },
        ]),
      });

      const result = await app.invoke(
        new HumanMessage("what is the weather in sf?")
      );

      expect(result).toHaveLength(6);
      expect(result).toEqual([
        new _AnyIdHumanMessage("what is the weather in sf?"),
        new _AnyIdAIMessage({
          content: "",
          additional_kwargs: {
            function_call: {
              name: "search_api",
              arguments: "query",
            },
          },
        }),
        new _AnyIdFunctionMessage({
          content: '"result for query"',
          name: "search_api",
        }),
        new _AnyIdAIMessage({
          content: "",
          additional_kwargs: {
            function_call: {
              name: "search_api",
              arguments: "another",
            },
          },
        }),
        new _AnyIdFunctionMessage({
          content: '"result for another"',
          name: "search_api",
        }),
        new _AnyIdAIMessage("answer"),
      ]);
    });

    it("can stream a list of messages", async () => {
      const model = new FakeChatModel({
        responses: [
          new AIMessage({
            content: "",
            additional_kwargs: {
              function_call: {
                name: "search_api",
                arguments: "query",
              },
            },
          }),
          new AIMessage({
            content: "",
            additional_kwargs: {
              function_call: {
                name: "search_api",
                arguments: "another",
              },
            },
          }),
          new AIMessage({
            content: "answer",
          }),
        ],
      });

      const toolExecutor = new ToolExecutor({ tools });

      const shouldContinue = (data: Array<BaseMessage>): string => {
        const lastMessage = data[data.length - 1];
        // If there is no function call, then we finish
        if (
          !("function_call" in lastMessage.additional_kwargs) ||
          !lastMessage.additional_kwargs.function_call
        ) {
          return "end";
        }
        // Otherwise if there is, we continue
        return "continue";
      };

      const callTool = async (
        data: Array<BaseMessage>,
        options?: RunnableConfig
      ) => {
        const lastMessage = data[data.length - 1];

        const action = {
          tool: lastMessage.additional_kwargs.function_call?.name ?? "",
          toolInput:
            lastMessage.additional_kwargs.function_call?.arguments ?? "",
          log: "",
        };

        const response = await toolExecutor.invoke(action, options);
        return new FunctionMessage({
          content: JSON.stringify(response),
          name: action.tool,
        });
      };
      const app = new MessageGraph()
        .addNode("agent", model)
        .addNode("action", callTool)
        .addEdge(START, "agent")
        .addConditionalEdges("agent", shouldContinue, {
          continue: "action",
          end: END,
        })
        .addEdge("action", "agent")
        .compile();

      expect(app.getGraph().toJSON()).toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "__start__", type: "schema" }),
          expect.objectContaining({ id: "__end__", type: "schema" }),
          {
            id: "agent",
            type: "runnable",
            data: {
              id: ["langchain", "chat_models", "fake", "FakeChatModel"],
              name: "FakeChatModel",
            },
          },
          {
            id: "action",
            type: "runnable",
            data: {
              id: ["langgraph", "RunnableCallable"],
              name: "action",
            },
          },
        ]),
        edges: expect.arrayContaining([
          { conditional: false, source: "__start__", target: "agent" },
          { conditional: false, source: "action", target: "agent" },
          {
            source: "agent",
            target: "action",
            data: "continue",
            conditional: true,
          },
          {
            source: "agent",
            target: "__end__",
            data: "end",
            conditional: true,
          },
        ]),
      });

      const stream = await app.stream([
        new HumanMessage("what is the weather in sf?"),
      ]);
      const streamItems = await gatherIterator(stream);

      const lastItem = streamItems[streamItems.length - 1];
      expect(Object.keys(lastItem)).toEqual(["agent"]);
      expect(Object.values(lastItem)[0]).toEqual(new _AnyIdAIMessage("answer"));
    });
  });

  it("checkpoint events", async () => {
    const builder = new StateGraph({
      my_key: Annotation<string>({ reducer: (a, b) => a + b }),
      market: Annotation<string>,
    })
      .addNode("prepare", () => ({ my_key: " prepared" }))
      .addNode("tool_two_slow", () => ({ my_key: " slow" }))
      .addNode("tool_two_fast", () => ({ my_key: " fast" }))
      .addNode("finish", () => ({ my_key: " finished" }))
      .addEdge(START, "prepare")
      .addEdge("finish", END)
      .addEdge("tool_two_fast", "finish")
      .addEdge("tool_two_slow", "finish")
      .addConditionalEdges({
        source: "prepare",
        path: function condition(s) {
          return s.market === "DE" ? "tool_two_slow" : "tool_two_fast";
        },
        pathMap: ["tool_two_slow", "tool_two_fast"],
      });

    let graph = builder.compile();

    expect(await graph.invoke({ my_key: "value", market: "DE" })).toEqual({
      my_key: "value prepared slow finished",
      market: "DE",
    });

    expect(await graph.invoke({ my_key: "value", market: "US" })).toEqual({
      my_key: "value prepared fast finished",
      market: "US",
    });

    const checkpointer = await createCheckpointer();
    graph = builder.compile({ checkpointer });

    const config = { configurable: { thread_id: "10" } };
    const actual = await gatherIterator(
      graph.stream(
        { my_key: "value", market: "DE" },
        { ...config, streamMode: "debug" }
      )
    );
    const anyStringSame = createAnyStringSame();

    expect(actual).toEqual([
      {
        type: "checkpoint",
        timestamp: expect.any(String),
        step: -1,
        payload: {
          config: {
            tags: [],
            metadata: { thread_id: "10" },
            recursion_limit: 25,
            configurable: {
              thread_id: "10",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          values: {},
          metadata: {
            source: "input",
            step: -1,
            writes: { __start__: { my_key: "value", market: "DE" } },
            parents: {},
          },
          next: ["__start__"],
          tasks: [
            {
              id: expect.any(String),
              name: "__start__",
              path: [PULL, "__start__"],
              interrupts: [],
            },
          ],
        },
      },
      {
        type: "checkpoint",
        timestamp: expect.any(String),
        step: 0,
        payload: {
          config: {
            tags: [],
            metadata: { thread_id: "10" },
            recursion_limit: 25,
            configurable: {
              thread_id: "10",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          parentConfig: {
            tags: [],
            metadata: { thread_id: "10" },
            recursion_limit: 25,
            configurable: {
              thread_id: "10",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          values: {
            my_key: "value",
            market: "DE",
          },
          metadata: {
            source: "loop",
            step: 0,
            writes: null,
            parents: {},
          },
          next: ["prepare"],
          tasks: [
            {
              id: expect.any(String),
              name: "prepare",
              path: [PULL, "prepare"],
              interrupts: [],
            },
          ],
        },
      },
      {
        type: "task",
        timestamp: expect.any(String),
        step: 1,
        payload: {
          id: anyStringSame("task1"),
          name: "prepare",
          input: { my_key: "value", market: "DE" },
          triggers: ["branch:to:prepare"],
          interrupts: [],
        },
      },
      {
        type: "task_result",
        timestamp: expect.any(String),
        step: 1,
        payload: {
          id: anyStringSame("task1"),
          name: "prepare",
          result: [["my_key", " prepared"]],
          interrupts: [],
        },
      },
      {
        type: "checkpoint",
        timestamp: expect.any(String),
        step: 1,
        payload: {
          config: {
            tags: [],
            metadata: { thread_id: "10" },
            recursion_limit: 25,
            configurable: {
              thread_id: "10",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          parentConfig: {
            tags: [],
            metadata: { thread_id: "10" },
            recursion_limit: 25,
            configurable: {
              thread_id: "10",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          values: {
            my_key: "value prepared",
            market: "DE",
          },
          metadata: {
            source: "loop",
            step: 1,
            writes: { prepare: { my_key: " prepared" } },
            parents: {},
          },
          next: ["tool_two_slow"],
          tasks: [
            {
              id: expect.any(String),
              name: "tool_two_slow",
              path: [PULL, "tool_two_slow"],
              interrupts: [],
            },
          ],
        },
      },
      {
        type: "task",
        timestamp: expect.any(String),
        step: 2,
        payload: {
          id: anyStringSame("task2"),
          name: "tool_two_slow",
          input: { my_key: "value prepared", market: "DE" },
          triggers: ["branch:to:tool_two_slow"],
          interrupts: [],
        },
      },
      {
        type: "task_result",
        timestamp: expect.any(String),
        step: 2,
        payload: {
          id: anyStringSame("task2"),
          name: "tool_two_slow",
          result: [["my_key", " slow"]],
          interrupts: [],
        },
      },
      {
        type: "checkpoint",
        timestamp: expect.any(String),
        step: 2,
        payload: {
          config: {
            tags: [],
            metadata: { thread_id: "10" },
            recursion_limit: 25,
            configurable: {
              thread_id: "10",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          parentConfig: {
            tags: [],
            metadata: { thread_id: "10" },
            recursion_limit: 25,
            configurable: {
              thread_id: "10",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          values: {
            my_key: "value prepared slow",
            market: "DE",
          },
          metadata: {
            source: "loop",
            step: 2,
            writes: { tool_two_slow: { my_key: " slow" } },
            parents: {},
          },
          next: ["finish"],
          tasks: [
            {
              id: expect.any(String),
              name: "finish",
              path: [PULL, "finish"],
              interrupts: [],
            },
          ],
        },
      },
      {
        type: "task",
        timestamp: expect.any(String),
        step: 3,
        payload: {
          id: anyStringSame("task3"),
          name: "finish",
          input: { my_key: "value prepared slow", market: "DE" },
          triggers: ["branch:to:finish"],
          interrupts: [],
        },
      },
      {
        type: "task_result",
        timestamp: expect.any(String),
        step: 3,
        payload: {
          id: anyStringSame("task3"),
          name: "finish",
          result: [["my_key", " finished"]],
          interrupts: [],
        },
      },
      {
        type: "checkpoint",
        timestamp: expect.any(String),
        step: 3,
        payload: {
          config: {
            tags: [],
            metadata: { thread_id: "10" },
            recursion_limit: 25,
            configurable: {
              thread_id: "10",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          parentConfig: {
            tags: [],
            metadata: { thread_id: "10" },
            recursion_limit: 25,
            configurable: {
              thread_id: "10",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          values: {
            my_key: "value prepared slow finished",
            market: "DE",
          },
          metadata: {
            source: "loop",
            step: 3,
            writes: { finish: { my_key: " finished" } },
            parents: {},
          },
          next: [],
          tasks: [],
        },
      },
    ]);

    // check if the checkpoints actually match
    const checkpoints = await gatherIterator(checkpointer.list(config));
    expect(
      checkpoints.reverse().map((i) => {
        return {
          metadata: i.metadata,
          config: i.config,
          parentConfig: i.parentConfig,
        };
      })
    ).toEqual(
      actual
        .filter((i) => i.type === "checkpoint")
        .map((i) => ({
          metadata: i.payload.metadata,
          config: { configurable: i.payload.config.configurable },
          parentConfig: i.payload.parentConfig
            ? { configurable: i.payload.parentConfig?.configurable }
            : undefined,
        }))
    );
  });

  it("StateGraph start branch then end", async () => {
    type State = {
      my_key: string;
      market: string;
    };

    const toolTwoBuilder = new StateGraph<State>({
      channels: {
        my_key: { reducer: (x: string, y: string) => x + y },
        market: null,
      },
    })
      .addNode("tool_two_slow", (_: State) => ({ my_key: ` slow` }))
      .addNode("tool_two_fast", (_: State) => ({ my_key: ` fast` }))
      .addConditionalEdges({
        source: START,
        path: (state: State) =>
          state.market === "DE" ? "tool_two_slow" : "tool_two_fast",
      });

    const toolTwo = toolTwoBuilder.compile();

    expect(await toolTwo.invoke({ my_key: "value", market: "DE" })).toEqual({
      my_key: "value slow",
      market: "DE",
    });
    expect(await toolTwo.invoke({ my_key: "value", market: "US" })).toEqual({
      my_key: "value fast",
      market: "US",
    });

    const toolTwoWithCheckpointer = toolTwoBuilder.compile({
      checkpointer: await createCheckpointer(),
      interruptBefore: ["tool_two_fast", "tool_two_slow"],
    });

    await expect(() =>
      toolTwoWithCheckpointer.invoke({ my_key: "value", market: "DE" })
    ).rejects.toThrowError("thread_id");

    async function last<T>(iter: AsyncIterableIterator<T>): Promise<T> {
      // eslint-disable-next-line no-undef-init
      let value: T | undefined = undefined;
      for await (value of iter) {
        // do nothing
      }
      return value as T;
    }

    const thread1 = { configurable: { thread_id: "1" } };
    expect(
      await toolTwoWithCheckpointer.invoke(
        { my_key: "value ⛰️", market: "DE" },
        thread1
      )
    ).toEqual({ my_key: "value ⛰️", market: "DE", __interrupt__: [] });

    const toolTwoCheckpointer =
      toolTwoWithCheckpointer.checkpointer as BaseCheckpointSaver;
    expect(
      (await gatherIterator(toolTwoCheckpointer.list(thread1))).map(
        (c) => c.metadata
      )
    ).toEqual([
      {
        source: "loop",
        step: 0,
        writes: null,
        parents: {},
      },
      {
        source: "input",
        step: -1,
        writes: { __start__: { my_key: "value ⛰️", market: "DE" } },
        parents: {},
      },
    ]);
    expect(await toolTwoWithCheckpointer.getState(thread1)).toEqual({
      values: { my_key: "value ⛰️", market: "DE" },
      next: ["tool_two_slow"],
      tasks: [
        {
          id: expect.any(String),
          name: "tool_two_slow",
          path: [PULL, "tool_two_slow"],
          interrupts: [],
        },
      ],
      config: (await toolTwoCheckpointer.getTuple(thread1))!.config,
      createdAt: (await toolTwoCheckpointer.getTuple(thread1))!.checkpoint.ts,
      metadata: {
        source: "loop",
        step: 0,
        writes: null,
        parents: {},
        thread_id: "1",
      },
      parentConfig: (
        await last(toolTwoCheckpointer.list(thread1, { limit: 2 }))
      ).config,
    });

    expect(await toolTwoWithCheckpointer.invoke(null, thread1)).toEqual({
      my_key: "value ⛰️ slow",
      market: "DE",
    });
    expect(await toolTwoWithCheckpointer.getState(thread1)).toEqual({
      values: { my_key: "value ⛰️ slow", market: "DE" },
      next: [],
      tasks: [],
      config: (await toolTwoCheckpointer.getTuple(thread1))!.config,
      createdAt: (await toolTwoCheckpointer.getTuple(thread1))!.checkpoint.ts,
      metadata: {
        source: "loop",
        step: 1,
        writes: { tool_two_slow: { my_key: " slow" } },
        parents: {},
        thread_id: "1",
      },
      parentConfig: (
        await last(toolTwoCheckpointer.list(thread1, { limit: 2 }))
      ).config,
    });
    const thread2 = { configurable: { thread_id: "2" } };
    // stop when about to enter node
    expect(
      await toolTwoWithCheckpointer.invoke(
        { my_key: "value", market: "US" },
        thread2
      )
    ).toEqual({
      my_key: "value",
      market: "US",
      __interrupt__: [],
    });
    expect(await toolTwoWithCheckpointer.getState(thread2)).toEqual({
      values: { my_key: "value", market: "US" },
      next: ["tool_two_fast"],
      tasks: [
        {
          id: expect.any(String),
          name: "tool_two_fast",
          path: [PULL, "tool_two_fast"],
          interrupts: [],
        },
      ],
      config: (await toolTwoCheckpointer.getTuple(thread2))!.config,
      createdAt: (await toolTwoCheckpointer.getTuple(thread2))!.checkpoint.ts,
      metadata: {
        source: "loop",
        step: 0,
        writes: null,
        parents: {},
        thread_id: "2",
      },
      parentConfig: (
        await last(toolTwoCheckpointer.list(thread2, { limit: 2 }))
      ).config,
    });
    // resume, for same result as above
    expect(await toolTwoWithCheckpointer.invoke(null, thread2)).toEqual({
      my_key: "value fast",
      market: "US",
    });
    expect(await toolTwoWithCheckpointer.getState(thread2)).toEqual({
      values: { my_key: "value fast", market: "US" },
      next: [],
      tasks: [],
      config: (await toolTwoCheckpointer.getTuple(thread2))!.config,
      createdAt: (await toolTwoCheckpointer.getTuple(thread2))!.checkpoint.ts,
      metadata: {
        source: "loop",
        step: 1,
        thread_id: "2",
        writes: { tool_two_fast: { my_key: " fast" } },
        parents: {},
      },
      parentConfig: (
        await last(toolTwoCheckpointer.list(thread2, { limit: 2 }))
      ).config,
    });
    const thread3 = { configurable: { thread_id: "3" } };
    // stop when about to enter node
    expect(
      await toolTwoWithCheckpointer.invoke(
        { my_key: "value", market: "US" },
        thread3
      )
    ).toEqual({
      my_key: "value",
      market: "US",
      __interrupt__: [],
    });
    expect(await toolTwoWithCheckpointer.getState(thread3)).toEqual({
      values: { my_key: "value", market: "US" },
      next: ["tool_two_fast"],
      tasks: [
        {
          id: expect.any(String),
          name: "tool_two_fast",
          path: [PULL, "tool_two_fast"],
          interrupts: [],
        },
      ],
      config: (await toolTwoCheckpointer.getTuple(thread3))!.config,
      createdAt: (await toolTwoCheckpointer.getTuple(thread3))!.checkpoint.ts,
      metadata: {
        source: "loop",
        step: 0,
        writes: null,
        parents: {},
        thread_id: "3",
      },
      parentConfig: (
        await last(toolTwoCheckpointer.list(thread3, { limit: 2 }))
      ).config,
    });
    // update state
    await toolTwoWithCheckpointer.updateState(thread3, { my_key: "key" }); // appends to my_key
    expect(await toolTwoWithCheckpointer.getState(thread3)).toEqual({
      values: { my_key: "valuekey", market: "US" },
      next: ["tool_two_fast"],
      tasks: [
        {
          id: expect.any(String),
          name: "tool_two_fast",
          path: [PULL, "tool_two_fast"],
          interrupts: [],
        },
      ],
      config: (await toolTwoCheckpointer.getTuple(thread3))!.config,
      createdAt: (await toolTwoCheckpointer.getTuple(thread3))!.checkpoint.ts,
      metadata: {
        source: "update",
        step: 1,
        writes: { [START]: { my_key: "key" } },
        parents: {},
        thread_id: "3",
      },
      parentConfig: (
        await last(toolTwoCheckpointer.list(thread3, { limit: 2 }))
      ).config,
    });
    // resume, for same result as above
    expect(await toolTwoWithCheckpointer.invoke(null, thread3)).toEqual({
      my_key: "valuekey fast",
      market: "US",
    });
    expect(await toolTwoWithCheckpointer.getState(thread3)).toEqual({
      values: { my_key: "valuekey fast", market: "US" },
      next: [],
      tasks: [],
      config: (await toolTwoCheckpointer.getTuple(thread3))!.config,
      createdAt: (await toolTwoCheckpointer.getTuple(thread3))!.checkpoint.ts,
      metadata: {
        source: "loop",
        step: 2,
        writes: { tool_two_fast: { my_key: " fast" } },
        parents: {},
        thread_id: "3",
      },
      parentConfig: (
        await last(toolTwoCheckpointer.list(thread3, { limit: 2 }))
      ).config,
    });
  });

  it("StateGraph branch then node", async () => {
    interface State {
      my_key: string;
      market: string;
    }

    const invalidBuilder = new StateGraph<State>({
      channels: {
        my_key: { reducer: (x: string, y: string) => x + y },
        market: null,
      },
    })
      .addNode("prepare", (_: State) => ({ my_key: ` prepared` }))
      .addNode("tool_two_slow", (_: State) => ({ my_key: ` slow` }))
      .addNode("tool_two_fast", (_: State) => ({ my_key: ` fast` }))
      .addNode("finish", (_: State) => ({ my_key: ` finished` }))
      .addEdge(START, "prepare")
      .addConditionalEdges({
        source: "prepare",
        path: (state: State) =>
          state.market === "DE" ? "tool_two_slow" : "tool_two_fast",
        pathMap: ["tool_two_slow", "tool_two_fast"],
      })
      .addEdge("finish", END);

    expect(() => invalidBuilder.compile()).toThrowError();

    const toolBuilder = new StateGraph<State>({
      channels: {
        my_key: { reducer: (x: string, y: string) => x + y },
        market: null,
      },
    })
      .addNode("prepare", (_: State) => ({ my_key: ` prepared` }))
      .addNode("tool_two_slow", (_: State) => ({ my_key: ` slow` }))
      .addNode("tool_two_fast", (_: State) => ({ my_key: ` fast` }))
      .addNode("finish", (_: State) => ({ my_key: ` finished` }))
      .addEdge(START, "prepare")
      .addConditionalEdges({
        source: "prepare",
        path: (state: State) =>
          state.market === "DE" ? "tool_two_slow" : "tool_two_fast",
      })
      .addEdge("tool_two_fast", "finish")
      .addEdge("tool_two_slow", "finish")
      .addEdge("finish", END);

    const tool = toolBuilder.compile();

    expect(tool.getGraph().toJSON()).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "__start__", type: "schema" }),
        {
          id: "prepare",
          type: "runnable",
          data: {
            id: ["langgraph", "RunnableCallable"],
            name: "prepare",
          },
        },
        {
          id: "tool_two_slow",
          type: "runnable",
          data: {
            id: ["langgraph", "RunnableCallable"],
            name: "tool_two_slow",
          },
        },
        {
          id: "tool_two_fast",
          type: "runnable",
          data: {
            id: ["langgraph", "RunnableCallable"],
            name: "tool_two_fast",
          },
        },
        {
          id: "finish",
          type: "runnable",
          data: {
            id: ["langgraph", "RunnableCallable"],
            name: "finish",
          },
        },
        expect.objectContaining({ id: "__end__", type: "schema" }),
      ]),
      edges: expect.arrayContaining([
        { source: "__start__", target: "prepare", conditional: false },
        { source: "tool_two_fast", target: "finish", conditional: false },
        { source: "tool_two_slow", target: "finish", conditional: false },
        { source: "finish", target: "__end__", conditional: false },
        { source: "prepare", target: "tool_two_slow", conditional: true },
        { source: "prepare", target: "tool_two_fast", conditional: true },
        { source: "prepare", target: "finish", conditional: true },
        { source: "prepare", target: "__end__", conditional: true },
      ]),
    });

    expect(await tool.invoke({ my_key: "value", market: "DE" })).toEqual({
      my_key: "value prepared slow finished",
      market: "DE",
    });
    expect(await tool.invoke({ my_key: "value", market: "FR" })).toEqual({
      my_key: "value prepared fast finished",
      market: "FR",
    });
  });

  describe("StateGraph start branch then end", () => {
    let checkpointer: BaseCheckpointSaver<number>;

    const GraphAnnotation = Annotation.Root({
      my_key: Annotation<string>({
        reducer: (a: string, b: string) => a + b,
      }),
      market: Annotation<string>(),
      shared: SharedValue.on("assistant_id"),
    });

    beforeEach(async () => {
      checkpointer = await createCheckpointer();
    });

    const assertSharedValue = (
      data: typeof GraphAnnotation.State,
      config: RunnableConfig
    ): Partial<typeof GraphAnnotation.State> => {
      expect(data).toHaveProperty("shared");
      const threadId = config.configurable?.thread_id;
      if (threadId) {
        if (threadId === "1") {
          expect(data.shared).toEqual({});
          return { shared: { "1": { hello: "world" } } };
        } else if (threadId === "2") {
          expect(data.shared).toEqual({ "1": { hello: "world" } });
        } else if (threadId === "3") {
          // Should not contain a value because the "assistant_id" is different
          expect(data.shared).toEqual({});
        }
      }
      return {};
    };

    const toolTwoSlow = (
      data: typeof GraphAnnotation.State,
      config: any
    ): Partial<typeof GraphAnnotation.State> => {
      return { my_key: " slow", ...assertSharedValue(data, config) };
    };

    const toolTwoFast = (
      data: typeof GraphAnnotation.State,
      config: any
    ): Partial<typeof GraphAnnotation.State> => {
      return { my_key: " fast", ...assertSharedValue(data, config) };
    };

    it("should handle start branch then end", async () => {
      const toolTwoGraph = new StateGraph(GraphAnnotation);
      const debug = false;

      toolTwoGraph
        .addNode("tool_two_slow", toolTwoSlow)
        .addNode("tool_two_fast", toolTwoFast)
        .addConditionalEdges(START, (s) =>
          s.market === "DE" ? "tool_two_slow" : "tool_two_fast"
        )
        .addEdge("tool_two_slow", END)
        .addEdge("tool_two_fast", END);

      let toolTwo = toolTwoGraph.compile();

      expect(
        await toolTwo.invoke({ my_key: "value", market: "DE" }, { debug })
      ).toEqual({
        my_key: "value slow",
        market: "DE",
      });

      expect(
        await toolTwo.invoke({ my_key: "value", market: "US" }, { debug })
      ).toEqual({
        my_key: "value fast",
        market: "US",
      });

      toolTwo = toolTwoGraph.compile({
        checkpointer,
        interruptBefore: ["tool_two_fast", "tool_two_slow"] as any[],
      });

      // Will throw an error if a checkpointer is passed but `configurable` isn't.
      await expect(
        toolTwo.invoke({ my_key: "value", market: "DE" })
      ).rejects.toThrow(/thread_id/);

      toolTwo = toolTwoGraph.compile({
        store: new InMemoryStore(),
        interruptBefore: ["tool_two_fast", "tool_two_slow"] as any[],
      });

      // Will throw an error if a store is passed but `configurable` isn't.
      await expect(
        toolTwo.invoke({ my_key: "value", market: "DE" })
      ).rejects.toThrow(/assistant_id/);

      toolTwo = toolTwoGraph.compile({
        store: new InMemoryStore(),
        checkpointer,
        interruptBefore: ["tool_two_fast", "tool_two_slow"] as any[],
      });

      const thread1 = {
        configurable: { thread_id: "1", assistant_id: "a" },
        debug,
      };

      expect(
        await toolTwo.invoke({ my_key: "value ⛰️", market: "DE" }, thread1)
      ).toEqual({
        my_key: "value ⛰️",
        market: "DE",
        __interrupt__: [],
      });

      const checkpoints = [];
      if (toolTwo.checkpointer) {
        for await (const checkpoint of toolTwo.checkpointer.list(thread1)) {
          checkpoints.push(checkpoint);
        }
      }

      expect(checkpoints.map((c: any) => c.metadata)).toEqual([
        {
          source: "loop",
          step: 0,
          writes: null,
          parents: {},
        },
        {
          source: "input",
          step: -1,
          writes: { __start__: { my_key: "value ⛰️", market: "DE" } },
          parents: {},
        },
      ]);

      expect(await toolTwo.getState(thread1)).toMatchObject({
        values: { my_key: "value ⛰️", market: "DE" },
        tasks: [{ name: "tool_two_slow" }],
        next: ["tool_two_slow"],
        metadata: { source: "loop", step: 0, writes: null },
      });

      expect(await toolTwo.invoke(null, thread1)).toEqual({
        my_key: "value ⛰️ slow",
        market: "DE",
      });

      expect(await toolTwo.getState(thread1)).toMatchObject({
        values: {
          my_key: "value ⛰️ slow",
          market: "DE",
        },
        tasks: [],
        next: [],
        metadata: {
          source: "loop",
          step: 1,
          writes: {
            tool_two_slow: {
              my_key: " slow",
            },
          },
          parents: {},
        },
      });

      const thread2 = {
        configurable: { thread_id: "2", assistant_id: "a" },
        debug,
      };
      expect(
        await toolTwo.invoke(
          {
            my_key: "value",
            market: "US",
          },
          thread2
        )
      ).toEqual({
        my_key: "value",
        market: "US",
        __interrupt__: [],
      });

      expect(await toolTwo.getState(thread2)).toMatchObject({
        values: {
          my_key: "value",
          market: "US",
        },
        tasks: [{ name: "tool_two_fast" }],
        next: ["tool_two_fast"],
        metadata: { source: "loop", step: 0, writes: null, parents: {} },
      });

      expect(await toolTwo.invoke(null, thread2)).toEqual({
        my_key: "value fast",
        market: "US",
      });

      expect(await toolTwo.getState(thread2)).toMatchObject({
        values: {
          my_key: "value fast",
          market: "US",
        },
        tasks: [],
        next: [],
        metadata: {
          source: "loop",
          step: 1,
          writes: { tool_two_fast: { my_key: " fast" } },
          parents: {},
        },
      });

      const thread3 = { configurable: { thread_id: "3", assistant_id: "b" } };
      expect(
        await toolTwo.invoke({ my_key: "value", market: "US" }, thread3)
      ).toEqual({
        my_key: "value",
        market: "US",
        __interrupt__: [],
      });

      expect(await toolTwo.getState(thread3)).toMatchObject({
        values: { my_key: "value", market: "US" },
        tasks: [{ name: "tool_two_fast" }],
        next: ["tool_two_fast"],
        metadata: { source: "loop", step: 0, writes: null, parents: {} },
      });

      await toolTwo.updateState(thread3, { my_key: "key" });

      expect(await toolTwo.getState(thread3)).toMatchObject({
        values: { my_key: "valuekey", market: "US" },
        tasks: [{ name: "tool_two_fast" }],
        next: ["tool_two_fast"],
        metadata: {
          source: "update",
          step: 1,
          writes: { [START]: { my_key: "key" } },
          parents: {},
        },
      });

      expect(await toolTwo.invoke(null, thread3)).toEqual({
        my_key: "valuekey fast",
        market: "US",
      });

      expect(await toolTwo.getState(thread3)).toMatchObject({
        values: { my_key: "valuekey fast", market: "US" },
        tasks: [],
        next: [],
        metadata: {
          source: "loop",
          step: 2,
          writes: { tool_two_fast: { my_key: " fast" } },
          parents: {},
        },
      });
    });
  });

  describe("Managed Values (context) can be passed through state", () => {
    let store: InMemoryStore;
    let checkpointer: BaseCheckpointSaver;
    let threadId = "";
    let iter = 0;

    beforeEach(async () => {
      iter += 1;
      threadId = iter.toString();
      store = new InMemoryStore();
      checkpointer = await createCheckpointer();
    });

    const AgentAnnotation = Annotation.Root({
      ...MessagesAnnotation.spec,
      sharedStateKey: SharedValue.on("assistant_id"),
    });

    it("should be passed through state but not stored in checkpointer", async () => {
      const nodeOne = async (
        data: typeof AgentAnnotation.State,
        config?: RunnableConfig
      ): Promise<Partial<typeof AgentAnnotation.State>> => {
        if (!config) {
          throw new Error("config is undefined");
        }
        expect(config.configurable?.thread_id).toEqual(threadId);

        expect(data.sharedStateKey).toEqual({});

        return {
          sharedStateKey: {
            sharedStateValue: {
              value: "shared",
            },
          },
          messages: [new AIMessage("hello")],
        };
      };

      const nodeTwo = async (
        data: typeof AgentAnnotation.State,
        config?: RunnableConfig
      ): Promise<Partial<typeof AgentAnnotation.State>> => {
        if (!config) {
          throw new Error("config is undefined");
        }

        expect(data.sharedStateKey).toEqual({
          sharedStateValue: {
            value: "shared",
          },
        });

        const storeData: Map<
          string,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          Map<string, Record<string, any>>
          // @ts-expect-error protected property, API not yet built for accessing values.
        > = store.data;
        expect(storeData.size).toEqual(1);

        // Namespace is scoped:<shared value on key><state key><shared value on value>
        const namespace = "scoped:assistant_id:sharedStateKey:a";
        const scopedData = storeData.get(namespace);
        expect(scopedData).toBeDefined();
        expect(scopedData?.size).toEqual(1);
        const sharedValue = scopedData?.get("sharedStateValue");

        expect(sharedValue?.value).toEqual({
          value: "shared",
        });

        return {
          sharedStateKey: {
            sharedStateValue: {
              value: "updated",
            },
          },
        };
      };

      const nodeThree = async (
        data: typeof AgentAnnotation.State,
        config?: RunnableConfig
      ): Promise<Partial<typeof AgentAnnotation.State>> => {
        if (!config) {
          throw new Error("config is undefined");
        }

        expect(data.sharedStateKey).toEqual({
          sharedStateValue: {
            value: "updated",
          },
        });

        // Return entire state so the result of `.invoke` can be verified.
        return data;
      };

      const workflow = new StateGraph(AgentAnnotation)
        .addNode("nodeOne", nodeOne)
        .addNode("nodeTwo", nodeTwo)
        .addNode("nodeThree", nodeThree)
        .addEdge(START, "nodeOne")
        .addEdge("nodeOne", "nodeTwo")
        .addEdge("nodeTwo", "nodeThree")
        .addEdge("nodeThree", END);

      const app = workflow.compile({
        store,
        checkpointer,
        interruptBefore: ["nodeTwo", "nodeThree"],
      });

      const config = {
        configurable: { thread_id: threadId, assistant_id: "a" },
      };

      // Invoke the first time to cause `nodeOne` to be executed.
      await app.invoke(
        {
          messages: [
            new HumanMessage({
              content: "what is weather in sf",
            }),
          ],
        },
        config
      );

      // Get state and verify shared value is not present
      const currentState1 = await app.getState(config);
      expect(currentState1.next).toEqual(["nodeTwo"]);
      expect(currentState1.values).toHaveProperty("messages");
      expect(currentState1.values).not.toHaveProperty("sharedStateKey");

      // Invoke a second time to cause `nodeTwo` to be executed.
      await app.invoke(null, config);

      const currentState2 = await app.getState(config);
      expect(currentState2.next).toEqual(["nodeThree"]);
      expect(currentState2.values).toHaveProperty("messages");
      expect(currentState2.values).not.toHaveProperty("sharedStateKey");

      // Invoke the final time to cause `nodeThree` to be executed.
      const result = await app.invoke(null, config);

      const currentState3 = await app.getState(config);
      expect(currentState3.next).toEqual([]);
      expect(currentState3.values).toHaveProperty("messages");
      expect(currentState3.values).not.toHaveProperty("sharedStateKey");

      expect(result).not.toHaveProperty("sharedStateKey");
      expect(Object.keys(result)).toEqual(["messages"]);
    });

    it("can not access shared values from other 'on' keys", async () => {
      const nodeOne = async (
        data: typeof AgentAnnotation.State,
        config?: RunnableConfig
      ): Promise<Partial<typeof AgentAnnotation.State>> => {
        if (!config) {
          throw new Error("config is undefined");
        }
        expect(config.configurable?.thread_id).toBe(threadId);
        expect(config.configurable?.assistant_id).toBe("a");

        expect(data.sharedStateKey).toEqual({});

        return {
          sharedStateKey: {
            valueForA: {
              value: "assistant_id a",
            },
          },
        };
      };

      const nodeTwo = async (
        data: typeof AgentAnnotation.State,
        config?: RunnableConfig
      ): Promise<Partial<typeof AgentAnnotation.State>> => {
        if (!config) {
          throw new Error("config is undefined");
        }
        expect(config.configurable?.thread_id).toBe(threadId);
        expect(config.configurable?.assistant_id).toBe("b");

        expect(data.sharedStateKey).toEqual({});

        return {
          sharedStateKey: {
            valueForB: {
              value: "assistant_id b",
            },
          },
        };
      };

      const nodeThree = async (
        data: typeof AgentAnnotation.State,
        config?: RunnableConfig
      ): Promise<Partial<typeof AgentAnnotation.State>> => {
        if (!config) {
          throw new Error("config is undefined");
        }

        expect(config.configurable?.thread_id).toBe(threadId);
        expect(config.configurable?.assistant_id).toBe("a");

        expect(data.sharedStateKey).toEqual({
          valueForA: {
            value: "assistant_id a",
          },
        });

        return {};
      };

      const nodeFour = async (
        data: typeof AgentAnnotation.State,
        config?: RunnableConfig
      ): Promise<Partial<typeof AgentAnnotation.State>> => {
        if (!config) {
          throw new Error("config is undefined");
        }

        expect(config.configurable?.thread_id).toBe(threadId);
        expect(config.configurable?.assistant_id).toBe("b");

        expect(data.sharedStateKey).toEqual({
          valueForB: {
            value: "assistant_id b",
          },
        });

        return {};
      };

      const workflow = new StateGraph(AgentAnnotation)
        .addNode("nodeOne", nodeOne)
        .addNode("nodeTwo", nodeTwo)
        .addNode("nodeThree", nodeThree)
        .addNode("nodeFour", nodeFour)
        .addEdge(START, "nodeOne")
        .addEdge("nodeOne", "nodeTwo")
        .addEdge("nodeTwo", "nodeThree")
        .addEdge("nodeThree", "nodeFour")
        .addEdge("nodeFour", END);

      const app = workflow.compile({
        store,
        checkpointer,
        interruptBefore: ["nodeTwo", "nodeThree", "nodeFour"],
      });

      const input = {
        messages: [
          new HumanMessage({
            content: "what is weather in sf",
            id: "1",
          }),
        ],
      };

      // Invoke once, passing in config with `assistant_id` set to `a`.
      // This will cause the shared value to be set in the state.
      // After we'll update the config to have `assistant_id` set to `b`,
      // and verify that the shared value set under `assistant_id` `a` is not accessible.
      // Finally, we'll repeat for `b` after switching back to `a`.
      const config1 = {
        configurable: { thread_id: threadId, assistant_id: "a" },
      };
      await app.invoke(input, config1);

      const currentState1 = await app.getState(config1);
      expect(currentState1.next).toEqual(["nodeTwo"]);
      expect(currentState1.values).toEqual(input);

      // Will resume the graph, execute `nodeTwo` then interrupt again.
      const config2 = {
        configurable: { thread_id: threadId, assistant_id: "b" },
      };
      await app.invoke(null, config2);

      const currentState2 = await app.getState(config2);
      expect(currentState2.next).toEqual(["nodeThree"]);
      expect(currentState1.values).toEqual(input);

      // Will resume the graph, execute `nodeThree` then finish.
      const config3 = {
        configurable: { thread_id: threadId, assistant_id: "a" },
      };
      await app.invoke(null, config3);

      const currentState3 = await app.getState(config3);
      expect(currentState3.next).toEqual(["nodeFour"]);
      expect(currentState1.values).toEqual(input);

      // Finally, resume the graph with `assistant_id` set to `b`, and verify that the shared value is accessible.
      const config4 = {
        configurable: { thread_id: threadId, assistant_id: "b" },
      };
      await app.invoke(null, config4);
    });

    it("can get state when state has shared values", async () => {
      const nodeOne = (_: typeof AgentAnnotation.State) => {
        return {
          messages: [
            {
              role: "assistant",
              content: "no-op",
            },
          ],
          sharedStateKey: {
            data: {
              value: "shared",
            },
          },
        };
      };

      const nodeTwo = (_: typeof AgentAnnotation.State) => {
        // no-op
        return {};
      };

      const workflow = new StateGraph(AgentAnnotation)
        .addNode("nodeOne", nodeOne)
        .addNode("nodeTwo", nodeTwo)
        .addEdge(START, "nodeOne")
        .addEdge("nodeOne", "nodeTwo")
        .addEdge("nodeTwo", END);

      const app = workflow.compile({
        store,
        checkpointer,
        interruptBefore: ["nodeTwo"],
      });

      const config: Record<string, Record<string, unknown>> = {
        configurable: { thread_id: threadId, assistant_id: "a" },
      };

      // Execute the graph. This will run `nodeOne` which sets the shared value,
      // then is interrupted before executing `nodeTwo`.
      await app.invoke(
        {
          messages: [
            {
              role: "user",
              content: "no-op",
            },
          ],
        },
        config
      );

      // Remove the "assistant_id" from the config and attempt to fetch the state.
      // Since a `noop` managed value class is used when getting state, it should work
      // even though the shared value key is not present.
      if (config.configurable.assistant_id) {
        delete config.configurable.assistant_id;
      }
      // Expect it does not throw an error complaining that the `assistant_id` key
      // is not found in the config.
      expect(await app.getState(config)).toBeTruthy();

      // Re-running without re-setting the `assistant_id` key in the config should throw an error.
      await expect(app.invoke(null, config)).rejects.toThrow(/assistant_id/);

      // Re-set the `assistant_id` key in the config and attempt to fetch the state.
      config.configurable.assistant_id = "a";
      await app.invoke(null, config);
    });

    it("can update state without shared state key in config", async () => {
      // Define nodeOne that sets sharedStateKey and adds a message
      const nodeOne = async (
        data: typeof AgentAnnotation.State,
        config?: RunnableConfig
      ): Promise<Partial<typeof AgentAnnotation.State>> => {
        if (!config) {
          throw new Error("config is undefined");
        }
        expect(config.configurable?.thread_id).toEqual(threadId);

        expect(data.sharedStateKey).toEqual({});

        return {
          sharedStateKey: {
            data: {
              value: "shared",
            },
          },
          messages: [new AIMessage("initial message")],
        };
      };

      // Define nodeTwo that updates sharedStateKey
      const nodeTwo = async (
        data: typeof AgentAnnotation.State,
        config?: RunnableConfig
      ): Promise<Partial<typeof AgentAnnotation.State>> => {
        if (!config) {
          throw new Error("config is undefined");
        }

        expect(data.sharedStateKey).toEqual({
          data: {
            value: "shared",
          },
        });

        return {
          sharedStateKey: {
            data: {
              value: "updated shared",
            },
          },
          messages: [new AIMessage("updated message")],
        };
      };

      // Create the workflow
      const workflow = new StateGraph(AgentAnnotation)
        .addNode("nodeOne", nodeOne)
        .addNode("nodeTwo", nodeTwo)
        .addEdge(START, "nodeOne")
        .addEdge("nodeOne", "nodeTwo")
        .addEdge("nodeTwo", END);

      // Compile the workflow with store and checkpointer
      const app = workflow.compile({
        store,
        checkpointer,
        interruptBefore: ["nodeTwo"],
      });

      // Initial configuration with sharedStateKey
      const config: Record<string, Record<string, unknown>> = {
        configurable: { thread_id: threadId, assistant_id: "a" },
      };

      // Execute nodeOne to set sharedStateKey and add initial message
      await app.invoke(
        {
          messages: [
            {
              role: "user",
              content: "start",
            },
          ],
        },
        config
      );

      // Verify initial state after nodeOne
      let currentState = await app.getState(config);
      expect(currentState.next).toEqual(["nodeTwo"]);
      expect(currentState.values).toHaveProperty("messages");
      expect(currentState.values).not.toHaveProperty("sharedStateKey");

      // Remove 'assistant_id' from config.configurable
      delete config.configurable.assistant_id;

      // Prepare updated values to be applied
      const updatedValues = {
        messages: [
          {
            role: "assistant",
            content: "intermediate message",
          },
        ],
      };

      // Update the state without sharedStateKey in config
      await app.updateState(config, updatedValues);

      // Verify that sharedStateKey has not been altered
      currentState = await app.getState(config);
      expect(currentState.next).toEqual(["nodeTwo"]);
      expect(currentState.values).toHaveProperty("messages");

      // Attempt to invoke nodeTwo without 'assistant_id', expecting an error
      await expect(app.invoke(null, config)).rejects.toThrow(/assistant_id/);

      // Re-add 'assistant_id' to config.configurable
      config.configurable.assistant_id = "a";

      // Successfully invoke nodeTwo after restoring 'assistant_id'
      await app.invoke(null, config);

      // Final state after invoking nodeTwo and nodeThree
      currentState = await app.getState(config);
      expect(currentState.next).toEqual([]);
    });

    it("Can access the store inside nodes", async () => {
      const nodeOne = async (
        _state: typeof AgentAnnotation.State,
        config: LangGraphRunnableConfig
      ) => {
        expect(config.store).toBeDefined();
        expect(config.store).toBeInstanceOf(BaseStore);
      };

      const workflow = new StateGraph(MessagesAnnotation)
        .addNode("nodeOne", nodeOne)
        .addEdge(START, "nodeOne")
        .addEdge("nodeOne", END);

      const app = workflow.compile({
        store,
        checkpointer,
      });

      const config = {
        configurable: { thread_id: threadId, assistant_id: "a" },
      };

      // Invoke the first time to cause `nodeOne` to be executed.
      await app.invoke(
        {
          messages: [
            new HumanMessage({
              content: "what is weather in sf",
            }),
          ],
        },
        config
      );
    });

    it("Can write and read to the store inside nodes", async () => {
      const nodeOne = async (
        _state: typeof AgentAnnotation.State,
        config: LangGraphRunnableConfig
      ) => {
        const { store } = config;
        expect(store).toBeDefined();
        if (!store) {
          throw new Error("No store found");
        }

        expect(config.configurable?.assistant_id).toEqual("a");
        if (config.configurable?.assistant_id !== "a") {
          throw new Error("assistant_id is not 'a'");
        }
        // Write to the store
        const { assistant_id, namespace } = config.configurable;
        const value = { includeHashtags: true };
        await store.put(namespace, assistant_id, value);
      };

      const nodeTwo = async (
        _state: typeof AgentAnnotation.State,
        config: LangGraphRunnableConfig
      ) => {
        const { store } = config;
        expect(store).toBeDefined();
        if (!store) {
          throw new Error("No store found");
        }

        expect(config.configurable?.assistant_id).toEqual("a");
        if (config.configurable?.assistant_id !== "a") {
          throw new Error("assistant_id is not 'a'");
        }
        // Write to the store
        const { assistant_id, namespace } = config.configurable;

        const data = await store.get(namespace, assistant_id);
        expect(data).toBeDefined();
        expect(data?.value).toEqual({ includeHashtags: true });
      };

      const workflow = new StateGraph(MessagesAnnotation)
        .addNode("nodeOne", nodeOne)
        .addNode("nodeTwo", nodeTwo)
        .addEdge(START, "nodeOne")
        .addEdge("nodeOne", "nodeTwo")
        .addEdge("nodeTwo", END);

      const app = workflow.compile({
        store,
        checkpointer,
      });

      const config = {
        configurable: {
          thread_id: threadId,
          assistant_id: "a",
          namespace: ["rules", "style"],
        },
      };

      // Invoke the first time to cause `nodeOne` to be executed.
      await app.invoke(
        {
          messages: [
            new HumanMessage({
              content: "what is weather in sf",
            }),
          ],
        },
        config
      );
    });
  });

  describe("Subgraphs", () => {
    test.each([
      [
        "nested graph interrupts parallel",
        (() => {
          const inner = new StateGraph(
            Annotation.Root({
              myKey: Annotation<string>({
                reducer: (a, b) => a + b,
                default: () => "",
              }),
              myOtherKey: Annotation<string>,
            })
          )
            .addNode("inner1", async (state) => {
              await new Promise((resolve) => setTimeout(resolve, 100));
              return { myKey: "got here", myOtherKey: state.myKey };
            })
            .addNode("inner2", (state) => ({
              myKey: " and there",
              myOtherKey: state.myKey,
            }))
            .addEdge("inner1", "inner2")
            .addEdge("__start__", "inner1")
            .compile({ interruptBefore: ["inner2"] });

          const graph = new StateGraph(
            Annotation.Root({
              myKey: Annotation<string>({
                reducer: (a, b) => a + b,
                default: () => "",
              }),
            })
          )
            .addNode("inner", inner)
            .addNode("outer1", () => ({ myKey: " and parallel" }))
            .addNode("outer2", () => ({ myKey: " and back again" }))
            .addEdge(START, "inner")
            .addEdge(START, "outer1")
            .addEdge(["inner", "outer1"], "outer2");

          return graph;
        })(),
      ],
      [
        "nested graph interrupts parallel: subgraph in lambda",
        (() => {
          const inner = new StateGraph(
            Annotation.Root({
              myKey: Annotation<string>({
                reducer: (a, b) => a + b,
                default: () => "",
              }),
              myOtherKey: Annotation<string>,
            })
          )
            .addNode("inner1", async (state) => {
              await new Promise((resolve) => setTimeout(resolve, 100));
              return { myKey: "got here", myOtherKey: state.myKey };
            })
            .addNode("inner2", (state) => ({
              myKey: " and there",
              myOtherKey: state.myKey,
            }))
            .addEdge("inner1", "inner2")
            .addEdge("__start__", "inner1")
            .compile({ interruptBefore: ["inner2"] });

          const graph = new StateGraph(
            Annotation.Root({
              myKey: Annotation<string>({
                reducer: (a, b) => a + b,
                default: () => "",
              }),
            })
          )
            .addNode("inner", (state, config) => inner.invoke(state, config), {
              subgraphs: [inner],
            })
            .addNode("outer1", () => ({ myKey: " and parallel" }))
            .addNode("outer2", () => ({ myKey: " and back again" }))
            .addEdge(START, "inner")
            .addEdge(START, "outer1")
            .addEdge(["inner", "outer1"], "outer2");

          return graph;
        })(),
      ],
    ])("%s", async (_name, graph) => {
      const checkpointer = await createCheckpointer();

      const app = graph.compile({ checkpointer });

      // test invoke w/ nested interrupt
      const config1 = { configurable: { thread_id: "1" } };
      expect(await app.invoke({ myKey: "" }, config1)).toEqual({
        myKey: " and parallel",
        __interrupt__: [],
      });

      expect(await app.invoke(null, config1)).toEqual({
        myKey: "got here and there and parallel and back again",
      });

      // below combo of assertions is asserting two things
      // - outer_1 finishes before inner interrupts (because we see its output in stream, which only happens after node finishes)
      // - the writes of outer are persisted in 1st call and used in 2nd call, ie outer isn't called again (because we don't see outer_1 output again in 2nd stream)
      // test stream updates w/ nested interrupt
      const config2 = { configurable: { thread_id: "2" } };

      expect(
        await gatherIterator(
          app.stream({ myKey: "" }, { ...config2, subgraphs: true })
        )
      ).toEqual([
        // we got to parallel node first
        [[], { outer1: { myKey: " and parallel" } }],
        [
          [expect.stringContaining("inner:")],
          { inner1: { myKey: "got here", myOtherKey: "" } },
        ],
        [[], { __interrupt__: [] }],
      ]);
      expect(await gatherIterator(app.stream(null, config2))).toEqual([
        {
          outer1: { myKey: " and parallel" },
          __metadata__: { cached: true },
        },
        { inner: { myKey: "got here and there" } },
        { outer2: { myKey: " and back again" } },
      ]);

      // test stream values w/ nested interrupt
      const config3 = {
        configurable: { thread_id: "3" },
        streamMode: "values" as const,
      };
      expect(
        await gatherIterator(await app.stream({ myKey: "" }, config3))
      ).toEqual([
        { myKey: "" },
        { myKey: " and parallel" },
        { __interrupt__: [] },
      ]);
      expect(await gatherIterator(await app.stream(null, config3))).toEqual([
        { myKey: "" },
        { myKey: "got here and there and parallel" },
        { myKey: "got here and there and parallel and back again" },
      ]);

      // test interrupts BEFORE the parallel node
      const appBefore = graph.compile({
        checkpointer,
        interruptBefore: ["outer1"],
      });
      const config4 = {
        configurable: { thread_id: "4" },
        streamMode: "values" as const,
      };
      expect(
        await gatherIterator(appBefore.stream({ myKey: "" }, config4))
      ).toEqual([{ myKey: "" }, { __interrupt__: [] }]);
      // while we're waiting for the node w/ interrupt inside to finish
      expect(await gatherIterator(appBefore.stream(null, config4))).toEqual([
        { myKey: "" },
        { myKey: " and parallel" },
        { __interrupt__: [] },
      ]);
      expect(await gatherIterator(appBefore.stream(null, config4))).toEqual([
        { myKey: "" },
        { myKey: "got here and there and parallel" },
        { myKey: "got here and there and parallel and back again" },
      ]);

      // test interrupts AFTER the parallel node
      const appAfter = graph.compile({
        checkpointer,
        interruptAfter: ["outer1"],
      });
      const config5 = {
        configurable: { thread_id: "5" },
        streamMode: "values" as const,
      };
      expect(
        await gatherIterator(appAfter.stream({ myKey: "" }, config5))
      ).toEqual([
        { myKey: "" },
        { myKey: " and parallel" },
        { __interrupt__: [] },
      ]);
      expect(await gatherIterator(appAfter.stream(null, config5))).toEqual([
        { myKey: "" },
        { myKey: "got here and there and parallel" },
        { __interrupt__: [] },
      ]);
      expect(await gatherIterator(appAfter.stream(null, config5))).toEqual([
        { myKey: "got here and there and parallel" },
        { myKey: "got here and there and parallel and back again" },
      ]);
    });

    it("doubly nested graph interrupts", async () => {
      const checkpointer = await createCheckpointer();

      const StateAnnotation = Annotation.Root({
        myKey: Annotation<string>,
      });

      const ChildStateAnnotation = Annotation.Root({
        myKey: Annotation<string>,
      });

      const GrandchildStateAnnotation = Annotation.Root({
        myKey: Annotation<string>,
      });

      const grandchild1 = async (
        state: typeof GrandchildStateAnnotation.State
      ) => {
        return {
          myKey: state.myKey + " here",
        };
      };
      const grandchild2 = async (
        state: typeof GrandchildStateAnnotation.State
      ) => {
        return {
          myKey: state.myKey + " and there",
        };
      };

      const grandchild = new StateGraph(GrandchildStateAnnotation)
        .addNode("grandchild1", grandchild1)
        .addNode("grandchild2", grandchild2)
        .addEdge("__start__", "grandchild1")
        .addEdge("grandchild1", "grandchild2");

      const child = new StateGraph(ChildStateAnnotation)
        .addNode(
          "child1",
          grandchild.compile({ interruptBefore: ["grandchild2"] })
        )
        .addEdge("__start__", "child1");

      const parent1 = (state: typeof StateAnnotation.State) => {
        return { myKey: "hi " + state.myKey };
      };
      const parent2 = (state: typeof StateAnnotation.State) => {
        return { myKey: state.myKey + " and back again" };
      };
      const graph = new StateGraph(StateAnnotation)
        .addNode("parent1", parent1)
        .addNode("child", child.compile())
        .addNode("parent2", parent2)
        .addEdge("__start__", "parent1")
        .addEdge("parent1", "child")
        .addEdge("child", "parent2");

      const app = graph.compile({ checkpointer });

      // test invoke w/ nested interrupt
      const config = { configurable: { thread_id: "1" } };
      expect(await app.invoke({ myKey: "my value" }, config)).toEqual({
        myKey: "hi my value",
        __interrupt__: [],
      });
      expect(await app.invoke(null, config)).toEqual({
        myKey: "hi my value here and there and back again",
      });

      // test stream updates w/ nested interrupt
      const config2 = { configurable: { thread_id: "2" } };
      expect(
        await gatherIterator(app.stream({ myKey: "my value" }, config2))
      ).toEqual([{ parent1: { myKey: "hi my value" } }, { [INTERRUPT]: [] }]);
      expect(await gatherIterator(app.stream(null, config2))).toEqual([
        { child: { myKey: "hi my value here and there" } },
        { parent2: { myKey: "hi my value here and there and back again" } },
      ]);

      // test stream values w/ nested interrupt
      const config3 = {
        configurable: { thread_id: "3" },
        streamMode: "values" as const,
      };
      expect(
        await gatherIterator(app.stream({ myKey: "my value" }, config3))
      ).toEqual([
        { myKey: "my value" },
        { myKey: "hi my value" },
        { __interrupt__: [] },
      ]);

      expect(await gatherIterator(app.stream(null, config3))).toEqual([
        { myKey: "hi my value" },
        { myKey: "hi my value here and there" },
        { myKey: "hi my value here and there and back again" },
      ]);
    });

    it("nested graph state", async () => {
      const checkpointer = await createCheckpointer();

      const InnerStateAnnotation = Annotation.Root({
        myKey: Annotation<string>,
        myOtherKey: Annotation<string>,
      });
      const inner1 = async (state: typeof InnerStateAnnotation.State) => {
        return {
          myKey: state.myKey + " here",
          myOtherKey: state.myKey,
        };
      };
      const inner2 = async (state: typeof InnerStateAnnotation.State) => {
        return {
          myKey: state.myKey + " and there",
          myOtherKey: state.myKey,
        };
      };
      const inner = new StateGraph(InnerStateAnnotation)
        .addNode("inner1", inner1)
        .addNode("inner2", inner2)
        .addEdge("__start__", "inner1")
        .addEdge("inner1", "inner2");

      const StateAnnotation = Annotation.Root({
        myKey: Annotation<string>,
        otherParentKey: Annotation<string>,
      });
      const outer1 = async (state: typeof StateAnnotation.State) => {
        return { myKey: "hi " + state.myKey };
      };
      const outer2 = async (state: typeof StateAnnotation.State) => {
        return { myKey: state.myKey + " and back again" };
      };
      const graph = new StateGraph(StateAnnotation)
        .addNode("outer1", outer1)
        .addNode("inner", inner.compile({ interruptBefore: ["inner2"] }))
        .addNode("outer2", outer2)
        .addEdge("__start__", "outer1")
        .addEdge("outer1", "inner")
        .addEdge("inner", "outer2");

      const app = graph.compile({ checkpointer });
      const config = { configurable: { thread_id: "1" } };
      await app.invoke(
        {
          myKey: "my value",
        },
        config
      );
      // test state w/ nested subgraph state (right after interrupt)
      // first getState without subgraph state
      expect(await app.getState(config)).toEqual({
        values: { myKey: "hi my value" },
        tasks: [
          {
            id: expect.any(String),
            name: "inner",
            path: [PULL, "inner"],
            interrupts: [],
            state: {
              configurable: {
                thread_id: "1",
                checkpoint_ns: expect.any(String),
              },
            },
          },
        ],
        next: ["inner"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          parents: {},
          source: "loop",
          writes: { outer1: { myKey: "hi my value" } },
          step: 1,
          thread_id: "1",
        },
        createdAt: expect.any(String),
        parentConfig: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
      });
      // now, getState with subgraphs state
      expect(await app.getState(config, { subgraphs: true })).toEqual({
        values: { myKey: "hi my value" },
        tasks: [
          {
            id: expect.any(String),
            name: "inner",
            path: [PULL, "inner"],
            interrupts: [],
            state: {
              values: {
                myKey: "hi my value here",
                myOtherKey: "hi my value",
              },
              tasks: [
                {
                  id: expect.any(String),
                  name: "inner2",
                  path: [PULL, "inner2"],
                  interrupts: [],
                },
              ],
              next: ["inner2"],
              config: {
                configurable: {
                  thread_id: "1",
                  checkpoint_ns: expect.stringMatching(/^inner:/),
                  checkpoint_id: expect.any(String),
                  checkpoint_map: expect.objectContaining({
                    "": expect.any(String),
                  }),
                },
              },
              metadata: {
                thread_id: "1",
                parents: {
                  "": expect.any(String),
                },
                source: "loop",
                writes: {
                  inner1: {
                    myKey: "hi my value here",
                    myOtherKey: "hi my value",
                  },
                },
                step: 1,
              },
              createdAt: expect.any(String),
              parentConfig: {
                configurable: {
                  thread_id: "1",
                  checkpoint_ns: expect.stringMatching(/^inner:/),
                  checkpoint_id: expect.any(String),
                },
              },
            },
          },
        ],
        next: ["inner"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          thread_id: "1",
          parents: {},
          source: "loop",
          writes: { outer1: { myKey: "hi my value" } },
          step: 1,
        },
        createdAt: expect.any(String),
        parentConfig: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
      });

      // getStateHistory returns outer graph checkpoints
      const history = await gatherIterator(app.getStateHistory(config));
      expect(history).toEqual([
        {
          values: { myKey: "hi my value" },
          tasks: [
            {
              id: expect.any(String),
              name: "inner",
              path: [PULL, "inner"],
              interrupts: [],
              state: {
                configurable: expect.objectContaining({
                  thread_id: "1",
                }),
              },
            },
          ],
          next: ["inner"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            thread_id: "1",
            parents: {},
            source: "loop",
            writes: {
              outer1: { myKey: "hi my value" },
            },
            step: 1,
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: { myKey: "my value" },
          tasks: [
            {
              id: expect.any(String),
              name: "outer1",
              interrupts: [],
              path: [PULL, "outer1"],
            },
          ],
          next: ["outer1"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            parents: {},
            source: "loop",
            step: 0,
            writes: null,
            thread_id: "1",
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: {},
          tasks: [
            {
              id: expect.any(String),
              name: "__start__",
              interrupts: [],
              path: [PULL, "__start__"],
            },
          ],
          next: ["__start__"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            thread_id: "1",
            parents: {},
            source: "input",
            writes: { __start__: { myKey: "my value" } },
            step: -1,
          },
          createdAt: expect.any(String),
        },
      ]);
      // get_state_history for a subgraph returns its checkpoints
      const childHistory = await gatherIterator(
        app.getStateHistory(history[0].tasks[0].state as RunnableConfig)
      );
      expect(childHistory).toEqual([
        {
          values: { myKey: "hi my value here", myOtherKey: "hi my value" },
          next: ["inner2"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.stringMatching(/^inner:/),
              checkpoint_id: expect.any(String),
              checkpoint_map: expect.objectContaining({
                "": expect.any(String),
              }),
            },
          },
          metadata: {
            thread_id: "1",
            source: "loop",
            writes: {
              inner1: {
                myKey: "hi my value here",
                myOtherKey: "hi my value",
              },
            },
            step: 1,
            parents: { "": expect.any(String) },
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.stringMatching(/^inner:/),
              checkpoint_id: expect.any(String),
            },
          },
          tasks: [
            {
              id: expect.any(String),
              name: "inner2",
              path: [PULL, "inner2"],
              interrupts: [],
            },
          ],
        },
        {
          values: { myKey: "hi my value" },
          next: ["inner1"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.stringMatching(/^inner:/),
              checkpoint_id: expect.any(String),
              checkpoint_map: expect.objectContaining({
                "": expect.any(String),
              }),
            },
          },
          metadata: {
            thread_id: "1",
            source: "loop",
            writes: null,
            step: 0,
            parents: { "": expect.any(String) },
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.stringMatching(/^inner:/),
              checkpoint_id: expect.any(String),
            },
          },
          tasks: [
            {
              id: expect.any(String),
              name: "inner1",
              path: [PULL, "inner1"],
              interrupts: [],
            },
          ],
        },
        {
          values: {},
          next: ["__start__"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.stringMatching(/^inner:/),
              checkpoint_id: expect.any(String),
              checkpoint_map: expect.objectContaining({
                "": expect.any(String),
              }),
            },
          },
          metadata: {
            thread_id: "1",
            source: "input",
            writes: {
              __start__: { myKey: "hi my value" },
            },
            step: -1,
            parents: { "": expect.any(String) },
          },
          createdAt: expect.any(String),
          tasks: [
            {
              id: expect.any(String),
              name: "__start__",
              path: [PULL, "__start__"],
              interrupts: [],
            },
          ],
        },
      ]);

      // resume
      await app.invoke(null, config);
      expect(await app.getState(config)).toEqual({
        values: { myKey: "hi my value here and there and back again" },
        tasks: [],
        next: [],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          thread_id: "1",
          parents: {},
          source: "loop",
          writes: {
            outer2: { myKey: "hi my value here and there and back again" },
          },
          step: 3,
        },
        createdAt: expect.any(String),
        parentConfig: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
      });

      // test full history at the end
      const actualHistory = await gatherIterator(app.getStateHistory(config));
      const expectedHistory = [
        {
          values: { myKey: "hi my value here and there and back again" },
          tasks: [],
          next: [],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            thread_id: "1",
            parents: {},
            source: "loop",
            writes: {
              outer2: { myKey: "hi my value here and there and back again" },
            },
            step: 3,
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: { myKey: "hi my value here and there" },
          tasks: [
            {
              id: expect.any(String),
              name: "outer2",
              path: [PULL, "outer2"],
              interrupts: [],
            },
          ],
          next: ["outer2"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            thread_id: "1",
            parents: {},
            source: "loop",
            writes: { inner: { myKey: "hi my value here and there" } },
            step: 2,
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: { myKey: "hi my value" },
          tasks: [
            {
              id: expect.any(String),
              name: "inner",
              path: [PULL, "inner"],
              interrupts: [],
              state: {
                configurable: {
                  thread_id: "1",
                  checkpoint_ns: expect.any(String),
                },
              },
            },
          ],
          next: ["inner"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            thread_id: "1",
            parents: {},
            source: "loop",
            writes: { outer1: { myKey: "hi my value" } },
            step: 1,
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: { myKey: "my value" },
          tasks: [
            {
              id: expect.any(String),
              name: "outer1",
              path: [PULL, "outer1"],
              interrupts: [],
            },
          ],
          next: ["outer1"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            parents: {},
            source: "loop",
            writes: null,
            step: 0,
            thread_id: "1",
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: {},
          tasks: [
            {
              id: expect.any(String),
              name: "__start__",
              path: [PULL, "__start__"],
              interrupts: [],
            },
          ],
          next: ["__start__"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            thread_id: "1",
            parents: {},
            source: "input",
            writes: { __start__: { myKey: "my value" } },
            step: -1,
          },
          createdAt: expect.any(String),
        },
      ];
      expect(actualHistory).toEqual(expectedHistory);
      for (let i = 0; i < actualHistory.length; i += 1) {
        // test looking up parent state by checkpoint ID
        const actualSnapshot = actualHistory[i];
        const expectedSnapshot = expectedHistory[i];
        expect(await app.getState(actualSnapshot.config)).toEqual(
          expectedSnapshot
        );
      }
    });

    it("invoke join then call other pregel", async () => {
      const checkpointer = await createCheckpointer();

      const addOne = vi.fn((x: number) => x + 1);
      const add10Each = vi.fn((x: number[]) => x.map((y) => y + 10));

      const innerApp = new Pregel({
        nodes: {
          one: Channel.subscribeTo("input")
            .pipe(addOne)
            .pipe(Channel.writeTo(["output"])),
        },
        channels: {
          output: new LastValue<number>(),
          input: new LastValue<number>(),
        },
        inputChannels: "input",
        outputChannels: "output",
      });

      const one = Channel.subscribeTo("input")
        .pipe(add10Each)
        .pipe(Channel.writeTo(["inbox_one"]).map());

      const two = Channel.subscribeTo("inbox_one")
        .pipe(innerApp.map())
        .pipe((x: number[]) => x.sort())
        .pipe(Channel.writeTo(["outbox_one"]));

      const chainThree = Channel.subscribeTo("outbox_one")
        .pipe((x: number[]) => x.reduce((a, b) => a + b, 0))
        .pipe(Channel.writeTo(["output"]));

      const app = new Pregel({
        nodes: {
          one,
          two,
          chainThree,
        },
        channels: {
          inbox_one: new Topic<number>(),
          outbox_one: new LastValue<number[]>(),
          output: new LastValue<number>(),
          input: new LastValue<number[]>(),
        },
        inputChannels: "input",
        outputChannels: "output",
      });

      for (let i = 0; i < 10; i += 1) {
        expect(await app.invoke([2, 3])).toBe(27);
      }

      const results = await Promise.all(
        Array(10)
          .fill(null)
          .map(() => app.invoke([2, 3]))
      );
      expect(results).toEqual(Array(10).fill(27));

      // Add checkpointer
      app.checkpointer = checkpointer;
      // Subgraph is called twice in the same node, through .map(), so raises
      expect(
        await app.invoke([2, 3], { configurable: { thread_id: "1" } })
      ).toBe(27);

      // Set inner graph checkpointer to not checkpoint
      innerApp.checkpointer = false;
      // Subgraph still called twice, but checkpointing for inner graph is disabled
      expect(
        await app.invoke([2, 3], { configurable: { thread_id: "1" } })
      ).toBe(27);
    });

    it("doubly nested graph state", async () => {
      const checkpointer = await createCheckpointer();

      const StateAnnotation = Annotation.Root({
        myKey: Annotation<string>,
      });

      const ChildStateAnnotation = Annotation.Root({
        myKey: Annotation<string>,
      });

      const GrandchildStateAnnotation = Annotation.Root({
        myKey: Annotation<string>,
      });

      const grandchild1 = async (
        state: typeof GrandchildStateAnnotation.State
      ) => {
        return {
          myKey: state.myKey + " here",
        };
      };
      const grandchild2 = async (
        state: typeof GrandchildStateAnnotation.State
      ) => {
        return {
          myKey: state.myKey + " and there",
        };
      };

      const grandchild = new StateGraph(GrandchildStateAnnotation)
        .addNode("grandchild1", grandchild1)
        .addNode("grandchild2", grandchild2)
        .addEdge("__start__", "grandchild1")
        .addEdge("grandchild1", "grandchild2");

      const child = new StateGraph(ChildStateAnnotation)
        .addNode(
          "child1",
          grandchild.compile({ interruptBefore: ["grandchild2"] })
        )
        .addEdge("__start__", "child1");

      const parent1 = (state: typeof StateAnnotation.State) => {
        return { myKey: "hi " + state.myKey };
      };
      const parent2 = (state: typeof StateAnnotation.State) => {
        return { myKey: state.myKey + " and back again" };
      };
      const graph = new StateGraph(StateAnnotation)
        .addNode("parent1", parent1)
        .addNode("child", child.compile())
        .addNode("parent2", parent2)
        .addEdge("__start__", "parent1")
        .addEdge("parent1", "child")
        .addEdge("child", "parent2");

      const app = graph.compile({ checkpointer });

      // test invoke w/ nested interrupt
      const config = { configurable: { thread_id: "1" } };
      expect(
        await gatherIterator(
          app.stream({ myKey: "my value" }, { ...config, subgraphs: true })
        )
      ).toEqual([
        [[], { parent1: { myKey: "hi my value" } }],
        [
          [expect.stringMatching(/^child:/), expect.stringMatching(/^child1:/)],
          { grandchild1: { myKey: "hi my value here" } },
        ],
        [[], { [INTERRUPT]: [] }],
      ]);

      // get state without subgraphs
      const outerState = await app.getState(config);
      expect(outerState).toEqual({
        values: { myKey: "hi my value" },
        tasks: [
          {
            id: expect.any(String),
            name: "child",
            path: [PULL, "child"],
            interrupts: [],
            state: {
              configurable: {
                thread_id: "1",
                checkpoint_ns: expect.stringMatching(/^child/),
              },
            },
          },
        ],
        next: ["child"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          parents: {},
          source: "loop",
          writes: { parent1: { myKey: "hi my value" } },
          step: 1,
          thread_id: "1",
        },
        createdAt: expect.any(String),
        parentConfig: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
      });
      const childState = await app.getState(
        outerState.tasks[0].state as RunnableConfig
      );
      expect(childState.tasks[0]).toEqual({
        id: expect.any(String),
        name: "child1",
        path: [PULL, "child1"],
        interrupts: [],
        state: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: expect.any(String),
          },
        },
      });
      const grandchildState = await app.getState(
        childState.tasks[0].state as RunnableConfig
      );
      expect(grandchildState).toEqual({
        values: { myKey: "hi my value here" },
        tasks: [
          {
            id: expect.any(String),
            name: "grandchild2",
            path: [PULL, "grandchild2"],
            interrupts: [],
          },
        ],
        next: ["grandchild2"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: expect.any(String),
            checkpoint_id: expect.any(String),
            checkpoint_map: expect.objectContaining({
              "": expect.any(String),
            }),
          },
        },
        metadata: {
          thread_id: "1",
          parents: expect.objectContaining({
            "": expect.any(String),
          }),
          source: "loop",
          writes: { grandchild1: { myKey: "hi my value here" } },
          step: 1,
        },
        createdAt: expect.any(String),
        parentConfig: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: expect.any(String),
            checkpoint_id: expect.any(String),
          },
        },
      });
      // get state with subgraphs
      expect(await app.getState(config, { subgraphs: true })).toEqual({
        values: { myKey: "hi my value" },
        tasks: [
          {
            id: expect.any(String),
            name: "child",
            path: [PULL, "child"],
            interrupts: [],
            state: {
              values: { myKey: "hi my value" },
              tasks: [
                {
                  id: expect.any(String),
                  name: "child1",
                  path: [PULL, "child1"],
                  interrupts: [],
                  state: {
                    values: { myKey: "hi my value here" },
                    tasks: [
                      {
                        id: expect.any(String),
                        name: "grandchild2",
                        path: [PULL, "grandchild2"],
                        interrupts: [],
                      },
                    ],
                    next: ["grandchild2"],
                    config: {
                      configurable: {
                        thread_id: "1",
                        checkpoint_ns: expect.any(String),
                        checkpoint_id: expect.any(String),
                        checkpoint_map: expect.objectContaining({
                          "": expect.any(String),
                        }),
                      },
                    },
                    metadata: {
                      parents: expect.objectContaining({
                        "": expect.any(String),
                      }),
                      source: "loop",
                      writes: {
                        grandchild1: { myKey: "hi my value here" },
                      },
                      step: 1,
                      thread_id: "1",
                    },
                    createdAt: expect.any(String),
                    parentConfig: {
                      configurable: {
                        thread_id: "1",
                        checkpoint_ns: expect.any(String),
                        checkpoint_id: expect.any(String),
                      },
                    },
                  },
                },
              ],
              next: ["child1"],
              config: {
                configurable: {
                  thread_id: "1",
                  checkpoint_ns: expect.stringMatching(/^child:/),
                  checkpoint_id: expect.any(String),
                  checkpoint_map: expect.objectContaining({
                    "": expect.any(String),
                  }),
                },
              },
              metadata: {
                thread_id: "1",
                parents: { "": expect.any(String) },
                source: "loop",
                writes: null,
                step: 0,
              },
              createdAt: expect.any(String),
              parentConfig: {
                configurable: {
                  thread_id: "1",
                  checkpoint_ns: expect.stringMatching(/^child:/),
                  checkpoint_id: expect.any(String),
                },
              },
            },
          },
        ],
        next: ["child"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          thread_id: "1",
          parents: {},
          source: "loop",
          writes: { parent1: { myKey: "hi my value" } },
          step: 1,
        },
        createdAt: expect.any(String),
        parentConfig: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
      });

      // resume
      expect(
        await gatherIterator(app.stream(null, { ...config, subgraphs: true }))
      ).toEqual([
        [
          [expect.stringMatching(/^child:/), expect.stringMatching(/^child1:/)],
          { grandchild2: { myKey: "hi my value here and there" } },
        ],
        [
          [expect.stringMatching(/^child:/)],
          { child1: { myKey: "hi my value here and there" } },
        ],
        [[], { child: { myKey: "hi my value here and there" } }],
        [
          [],
          { parent2: { myKey: "hi my value here and there and back again" } },
        ],
      ]);
      // get state with and without subgraphs
      expect(await app.getState(config)).toEqual(
        await app.getState(config, { subgraphs: true })
      );
      expect(await app.getState(config)).toEqual({
        values: { myKey: "hi my value here and there and back again" },
        tasks: [],
        next: [],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          thread_id: "1",
          parents: {},
          source: "loop",
          writes: {
            parent2: { myKey: "hi my value here and there and back again" },
          },
          step: 3,
        },
        createdAt: expect.any(String),
        parentConfig: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
      });
      // get outer graph history
      const outerHistory = await gatherIterator(app.getStateHistory(config));
      expect(outerHistory).toEqual([
        {
          values: { myKey: "hi my value here and there and back again" },
          tasks: [],
          next: [],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            thread_id: "1",
            parents: {},
            source: "loop",
            writes: {
              parent2: { myKey: "hi my value here and there and back again" },
            },
            step: 3,
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: { myKey: "hi my value here and there" },
          next: ["parent2"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            thread_id: "1",
            source: "loop",
            writes: { child: { myKey: "hi my value here and there" } },
            step: 2,
            parents: {},
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          tasks: [
            {
              id: expect.any(String),
              name: "parent2",
              path: [PULL, "parent2"],
              interrupts: [],
            },
          ],
        },
        {
          values: { myKey: "hi my value" },
          tasks: [
            {
              id: expect.any(String),
              name: "child",
              path: [PULL, "child"],
              interrupts: [],
              state: {
                configurable: {
                  thread_id: "1",
                  checkpoint_ns: expect.stringContaining("child"),
                },
              },
            },
          ],
          next: ["child"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            thread_id: "1",
            parents: {},
            source: "loop",
            writes: { parent1: { myKey: "hi my value" } },
            step: 1,
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: { myKey: "my value" },
          next: ["parent1"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            source: "loop",
            writes: null,
            step: 0,
            parents: {},
            thread_id: "1",
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          tasks: [
            {
              id: expect.any(String),
              name: "parent1",
              path: [PULL, "parent1"],
              interrupts: [],
            },
          ],
        },
        {
          values: {},
          next: ["__start__"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            thread_id: "1",
            source: "input",
            writes: { __start__: { myKey: "my value" } },
            step: -1,
            parents: {},
          },
          createdAt: expect.any(String),
          tasks: [
            {
              id: expect.any(String),
              name: "__start__",
              path: [PULL, "__start__"],
              interrupts: [],
            },
          ],
        },
      ]);
      // get child graph history
      const childHistory = await gatherIterator(
        app.getStateHistory(outerHistory[2].tasks[0].state as RunnableConfig)
      );
      expect(childHistory).toEqual([
        {
          values: { myKey: "hi my value here and there" },
          next: [],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.stringContaining("child:"),
              checkpoint_id: expect.any(String),
              checkpoint_map: expect.objectContaining({
                "": expect.any(String),
              }),
            },
          },
          metadata: {
            thread_id: "1",
            source: "loop",
            writes: { child1: { myKey: "hi my value here and there" } },
            step: 1,
            parents: { "": expect.any(String) },
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.stringContaining("child:"),
              checkpoint_id: expect.any(String),
            },
          },
          tasks: [],
        },

        {
          values: { myKey: "hi my value" },
          next: ["child1"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.stringContaining("child:"),
              checkpoint_id: expect.any(String),
              checkpoint_map: expect.objectContaining({
                "": expect.any(String),
              }),
            },
          },
          metadata: {
            thread_id: "1",
            source: "loop",
            writes: null,
            step: 0,
            parents: { "": expect.any(String) },
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.stringContaining("child:"),
              checkpoint_id: expect.any(String),
            },
          },
          tasks: [
            {
              id: expect.any(String),
              name: "child1",
              path: [PULL, "child1"],
              interrupts: [],
              state: {
                configurable: {
                  thread_id: "1",
                  checkpoint_ns: expect.stringContaining("child:"),
                },
              },
            },
          ],
        },
        {
          values: {},
          next: ["__start__"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.stringContaining("child:"),
              checkpoint_id: expect.any(String),
              checkpoint_map: expect.objectContaining({
                "": expect.any(String),
              }),
            },
          },
          metadata: {
            thread_id: "1",
            source: "input",
            writes: { __start__: { myKey: "hi my value" } },
            step: -1,
            parents: { "": expect.any(String) },
          },
          createdAt: expect.any(String),
          tasks: [
            {
              id: expect.any(String),
              name: "__start__",
              path: [PULL, "__start__"],
              interrupts: [],
            },
          ],
        },
      ]);
      // get grandchild graph history
      const grandchildHistory = await gatherIterator(
        app.getStateHistory(childHistory[1].tasks[0].state as RunnableConfig)
      );
      expect(grandchildHistory).toEqual([
        {
          values: { myKey: "hi my value here and there" },
          next: [],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.any(String),
              checkpoint_id: expect.any(String),
              checkpoint_map: expect.objectContaining({
                "": expect.any(String),
              }),
            },
          },
          metadata: {
            thread_id: "1",
            source: "loop",
            writes: { grandchild2: { myKey: "hi my value here and there" } },
            step: 2,
            parents: expect.objectContaining({
              "": expect.any(String),
            }),
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.any(String),
              checkpoint_id: expect.any(String),
            },
          },
          tasks: [],
        },
        {
          values: { myKey: "hi my value here" },
          next: ["grandchild2"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.any(String),
              checkpoint_id: expect.any(String),
              checkpoint_map: expect.objectContaining({
                "": expect.any(String),
              }),
            },
          },
          metadata: {
            thread_id: "1",
            source: "loop",
            writes: { grandchild1: { myKey: "hi my value here" } },
            step: 1,
            parents: expect.objectContaining({
              "": expect.any(String),
            }),
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.any(String),
              checkpoint_id: expect.any(String),
            },
          },
          tasks: [
            {
              id: expect.any(String),
              name: "grandchild2",
              path: [PULL, "grandchild2"],
              interrupts: [],
            },
          ],
        },
        {
          values: { myKey: "hi my value" },
          next: ["grandchild1"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.any(String),
              checkpoint_id: expect.any(String),
              checkpoint_map: expect.objectContaining({
                "": expect.any(String),
              }),
            },
          },
          metadata: {
            thread_id: "1",
            source: "loop",
            writes: null,
            step: 0,
            parents: expect.objectContaining({
              "": expect.any(String),
            }),
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.any(String),
              checkpoint_id: expect.any(String),
            },
          },
          tasks: [
            {
              id: expect.any(String),
              name: "grandchild1",
              path: [PULL, "grandchild1"],
              interrupts: [],
            },
          ],
        },
        {
          values: {},
          next: ["__start__"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: expect.any(String),
              checkpoint_id: expect.any(String),
              checkpoint_map: expect.objectContaining({
                "": expect.any(String),
              }),
            },
          },
          metadata: {
            thread_id: "1",
            source: "input",
            writes: { __start__: { myKey: "hi my value" } },
            step: -1,
            parents: expect.objectContaining({
              "": expect.any(String),
            }),
          },
          createdAt: expect.any(String),
          tasks: [
            {
              id: expect.any(String),
              name: "__start__",
              path: [PULL, "__start__"],
              interrupts: [],
            },
          ],
        },
      ]);
      // replay grandchild checkpoint
      const events = await gatherIterator(
        app.stream(null, { ...grandchildHistory[2].config, subgraphs: true })
      );
      expect(events).toEqual([
        [
          [expect.stringMatching(/^child:/), expect.stringMatching(/^child1:/)],
          { grandchild1: { myKey: "hi my value here" } },
        ],
        [[""], { [INTERRUPT]: [] }],
      ]);
    });

    it("send to nested graphs", async () => {
      const checkpointer = await createCheckpointer();

      const OverallStateAnnotation = Annotation.Root({
        subjects: Annotation<string[]>,
        jokes: Annotation<string[]>({
          reducer: (a, b) => a.concat(b),
          default: () => [],
        }),
      });
      const continueToJokes = async (
        state: typeof OverallStateAnnotation.State
      ) => {
        return state.subjects.map(
          (s) => new Send("generateJoke", { subject: s })
        );
      };

      const JokeStateAnnotation = Annotation.Root({
        subject: Annotation<string>,
      });

      const edit = async (state: typeof JokeStateAnnotation.State) => {
        const { subject } = state;
        return { subject: `${subject} - hohoho` };
      };

      // subgraph
      const subgraph = new StateGraph({
        input: JokeStateAnnotation,
        output: OverallStateAnnotation,
      })
        .addNode("edit", edit)
        .addNode("generate", async (state) => {
          return { jokes: [`Joke about ${state.subject}`] };
        })
        .addEdge("__start__", "edit")
        .addEdge("edit", "generate");

      // parent graph
      const builder = new StateGraph(OverallStateAnnotation)
        .addNode(
          "generateJoke",
          subgraph.compile({ interruptBefore: ["generate"] })
        )
        .addConditionalEdges("__start__", continueToJokes);

      const graph = builder.compile({ checkpointer });
      const config = { configurable: { thread_id: "1" } };
      const tracer = new FakeTracer();

      // invoke and pause at nested interrupt
      expect(
        await graph.invoke(
          {
            subjects: ["cats", "dogs"],
          },
          { ...config, callbacks: [tracer] }
        )
      ).toEqual({
        subjects: ["cats", "dogs"],
        jokes: [],
        __interrupt__: [],
      });
      await awaitAllCallbacks();
      expect(tracer.runs.length).toEqual(1);

      // check state
      const outerState = await graph.getState(config);
      expect(outerState).toEqual({
        values: { subjects: ["cats", "dogs"], jokes: [] },
        tasks: [
          {
            id: expect.any(String),
            name: "generateJoke",
            path: [PUSH, 0],
            interrupts: [],
            state: {
              configurable: {
                thread_id: "1",
                checkpoint_ns: expect.stringContaining("generateJoke:"),
              },
            },
          },
          {
            id: expect.any(String),
            name: "generateJoke",
            path: [PUSH, 1],
            interrupts: [],
            state: {
              configurable: {
                thread_id: "1",
                checkpoint_ns: expect.stringContaining("generateJoke:"),
              },
            },
          },
        ],
        next: ["generateJoke", "generateJoke"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          parents: {},
          source: "loop",
          writes: null,
          step: 0,
          thread_id: "1",
        },
        createdAt: expect.any(String),
        parentConfig: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
      });
      // check state of each of the inner tasks
      expect(
        await graph.getState(outerState.tasks[0].state as RunnableConfig)
      ).toEqual({
        values: { subject: "cats - hohoho", jokes: [] },
        next: ["generate"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: expect.stringContaining("generateJoke:"),
            checkpoint_id: expect.any(String),
            checkpoint_map: expect.objectContaining({
              "": expect.any(String),
            }),
          },
        },
        metadata: {
          step: 1,
          source: "loop",
          writes: {
            edit: {},
          },
          parents: { "": expect.any(String) },
          thread_id: "1",
        },
        createdAt: expect.any(String),
        parentConfig: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: expect.stringContaining("generateJoke:"),
            checkpoint_id: expect.any(String),
          },
        },
        tasks: [
          {
            id: expect.any(String),
            name: "generate",
            path: [PULL, "generate"],
            interrupts: [],
          },
        ],
      });

      expect(
        await graph.getState(outerState.tasks[1].state as RunnableConfig)
      ).toEqual({
        values: { subject: "dogs - hohoho", jokes: [] },
        next: ["generate"],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: expect.stringContaining("generateJoke:"),
            checkpoint_id: expect.any(String),
            checkpoint_map: expect.objectContaining({
              "": expect.any(String),
            }),
          },
        },
        metadata: {
          thread_id: "1",
          step: 1,
          source: "loop",
          writes: {
            edit: {},
          },
          parents: { "": expect.any(String) },
        },
        createdAt: expect.any(String),
        parentConfig: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: expect.stringContaining("generateJoke:"),
            checkpoint_id: expect.any(String),
          },
        },
        tasks: [
          {
            id: expect.any(String),
            name: "generate",
            path: [PULL, "generate"],
            interrupts: [],
          },
        ],
      });

      // update state of dogs joke graph
      await graph.updateState(outerState.tasks[1].state as RunnableConfig, {
        subject: "turtles - hohoho",
      });

      // continue past interrupt
      const results = (await gatherIterator(graph.stream(null, config))).sort();
      expect(results).toHaveLength(2);
      expect(results).toEqual(
        expect.arrayContaining([
          {
            generateJoke: { jokes: ["Joke about cats - hohoho"] },
          },
          {
            generateJoke: { jokes: ["Joke about turtles - hohoho"] },
          },
        ])
      );

      const actualSnapshot = await graph.getState(config);
      const expectedSnapshot = {
        values: {
          subjects: ["cats", "dogs"],
          jokes: ["Joke about cats - hohoho", "Joke about turtles - hohoho"],
        },
        tasks: [],
        next: [],
        config: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
        metadata: {
          parents: {},
          thread_id: "1",
          source: "loop",
          writes: {
            generateJoke: [
              { jokes: ["Joke about cats - hohoho"] },
              { jokes: ["Joke about turtles - hohoho"] },
            ],
          },
          step: 1,
        },
        createdAt: expect.any(String),
        parentConfig: {
          configurable: {
            thread_id: "1",
            checkpoint_ns: "",
            checkpoint_id: expect.any(String),
          },
        },
      };
      expect(actualSnapshot).toEqual(expectedSnapshot);

      // test full history
      const actualHistory = await gatherIterator(graph.getStateHistory(config));

      // get subgraph node state for expected history
      const expectedHistory = [
        {
          values: {
            subjects: ["cats", "dogs"],
            jokes: ["Joke about cats - hohoho", "Joke about turtles - hohoho"],
          },
          tasks: [],
          next: [],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            parents: {},
            source: "loop",
            writes: {
              generateJoke: [
                { jokes: ["Joke about cats - hohoho"] },
                { jokes: ["Joke about turtles - hohoho"] },
              ],
            },
            step: 1,
            thread_id: "1",
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: { subjects: ["cats", "dogs"], jokes: [] },
          tasks: [
            {
              id: expect.any(String),
              name: "generateJoke",
              path: [PUSH, 0],
              interrupts: [],
              state: {
                configurable: {
                  thread_id: "1",
                  checkpoint_ns: expect.stringContaining("generateJoke:"),
                },
              },
            },
            {
              id: expect.any(String),
              name: "generateJoke",
              path: [PUSH, 1],
              interrupts: [],
              state: {
                configurable: {
                  thread_id: "1",
                  checkpoint_ns: expect.stringContaining("generateJoke:"),
                },
              },
            },
          ],
          next: ["generateJoke", "generateJoke"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            parents: {},
            source: "loop",
            writes: null,
            step: 0,
            thread_id: "1",
          },
          createdAt: expect.any(String),
          parentConfig: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
        },
        {
          values: { jokes: [] },
          tasks: [
            {
              id: expect.any(String),
              name: "__start__",
              path: [PULL, "__start__"],
              interrupts: [],
            },
          ],
          next: ["__start__"],
          config: {
            configurable: {
              thread_id: "1",
              checkpoint_ns: "",
              checkpoint_id: expect.any(String),
            },
          },
          metadata: {
            parents: {},
            source: "input",
            writes: { __start__: { subjects: ["cats", "dogs"] } },
            step: -1,
            thread_id: "1",
          },
          createdAt: expect.any(String),
        },
      ];
      expect(actualHistory).toEqual(expectedHistory);
    });

    it("streams updates as soon as they are available", async () => {
      const StateAnnotation = Annotation.Root({
        foo: Annotation<string>({
          reducer: (a, b) => a + b,
          default: () => "",
        }),
      });

      const subgraph = new StateGraph(StateAnnotation)
        .addNode("fast", async () => {
          return { foo: "b" };
        })
        .addNode("slow", async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return { foo: "a" };
        })
        .addEdge("__start__", "fast")
        .addEdge("fast", "slow")
        .compile();

      const graph = new StateGraph(StateAnnotation)
        .addNode("subgraph", subgraph)
        .addNode("after", async () => {
          return { foo: "r" };
        })
        .addEdge("__start__", "subgraph")
        .addEdge("subgraph", "after")
        .compile();

      // First chunk from subgraph (buffered on initial await) should be streamed immediately
      const stream = await Promise.race([
        graph.stream({}, { subgraphs: true }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out.")), 100)
        ),
      ]);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      expect(chunks.length).toEqual(4);
    });

    it("should handle non-overlapping parent command updates", async () => {
      const StateAnnotation = Annotation.Root({
        uniqueStrings: Annotation<string[]>({
          reducer: (a, b) => Array.from(new Set([...a, ...b])),
        }),
      });

      // Define subgraph
      const subgraph = new StateGraph(StateAnnotation)
        .addNode(
          "subgraph_node_1",
          () =>
            new Command({
              goto: "subgraph_node_2",
              update: {
                uniqueStrings: ["bar"],
                visitedNodes: ["subgraph_node_1"],
              },
            }),
          { ends: ["subgraph_node_2"] }
        )
        .addNode(
          "subgraph_node_2",
          () =>
            new Command({
              goto: "node_3",
              update: { visitedNodes: ["subgraph_node_2"] },
              graph: "PARENT",
            })
        )
        .addEdge(START, "subgraph_node_1")
        .compile();

      // Define main graph
      const mainGraph = new StateGraph(StateAnnotation)
        .addNode(
          "node_1",
          () =>
            new Command({
              goto: "node_2",
              update: { uniqueStrings: ["foo"] },
            }),
          { ends: ["node_2"] }
        )
        .addNode("node_2", subgraph)
        .addNode(
          "node_3",
          () =>
            new Command({
              update: { uniqueStrings: ["baz"] },
            })
        )
        .addEdge(START, "node_1")
        .addEdge("node_2", "node_3")
        .compile();

      const result = await mainGraph.invoke({ uniqueStrings: [] });
      expect(result).toEqual({
        uniqueStrings: ["foo", "bar", "baz"],
      });
    });

    it("should not throw when you try to access config.store inside a subgraph", async () => {
      const MinimalAnnotatedState = Annotation.Root({
        query: Annotation<string>(),
      });
      type MinimalState = typeof MinimalAnnotatedState.State;
      type MinimalUpdate = typeof MinimalAnnotatedState.Update;

      async function nodeCallingBuildContext(
        state: MinimalState,
        config?: LangGraphRunnableConfig
      ): Promise<MinimalUpdate> {
        if (!config?.store) {
          throw new Error("Store is required.");
        }

        await config.store.search(["namespace"], {
          query: state.query,
        });
        return {};
      }

      const checkpointer = await createCheckpointer();
      const store = new InMemoryStore();

      const reasoningWorkflow = new StateGraph(MinimalAnnotatedState)
        .addNode("initial_reasoning_minimal", nodeCallingBuildContext)
        .addEdge(START, "initial_reasoning_minimal")
        .addEdge("initial_reasoning_minimal", END);

      const minimalReasoningGraph = reasoningWorkflow.compile({
        store,
        checkpointer,
      });

      const mainWorkflow = new StateGraph(MinimalAnnotatedState)
        .addNode("reasoning_subgraph", minimalReasoningGraph)
        .addEdge(START, "reasoning_subgraph")
        .addEdge("reasoning_subgraph", END);

      const minimalMainGraph = mainWorkflow.compile({ store, checkpointer });

      const config = {
        configurable: {
          thread_id: "1",
        },
      };

      // Expect the invocation to pass
      const result = await minimalMainGraph.invoke(
        {
          query: "test",
        },
        config
      );
      expect(result).toBeDefined();
    });
  });

  it("should work with streamMode messages and custom from within a subgraph", async () => {
    const child = new StateGraph(MessagesAnnotation)
      .addNode("c_one", () => ({
        messages: [new HumanMessage("f"), new AIMessage("b")],
      }))
      .addNode("c_two", async (_, config) => {
        const model = new FakeChatModel({
          responses: [new AIMessage("1"), new AIMessage("2")],
        }).withConfig({ tags: ["c_two_chat_model"] });

        const stream = await model.stream("yo", {
          ...config,
          runName: "c_two_chat_model_stream",
        });

        for await (const chunk of stream) {
          config.writer?.({ content: chunk.content, from: "subgraph" });
        }
        return { messages: [await model.invoke("hey", config)] };
      })
      .addEdge(START, "c_one")
      .addEdge("c_one", "c_two")
      .addEdge("c_two", END);

    const parent = new StateGraph(MessagesAnnotation)
      .addNode("p_one", async (_, config) => {
        const toolExecutor = RunnableLambda.from(async () => {
          return [new ToolMessage({ content: "q", tool_call_id: "test" })];
        });
        config.writer?.({ from: "parent" });
        return { messages: await toolExecutor.invoke({}, config) };
      })
      .addNode("p_two", child.compile())
      .addNode("p_three", async (_, config) => {
        const model = new FakeChatModel({ responses: [new AIMessage("x")] });
        await model.invoke("hey", config);
        return { messages: [] };
      })
      .addEdge(START, "p_one")
      .addEdge("p_one", "p_two")
      .addEdge("p_two", "p_three")
      .addEdge("p_three", END);

    const graph = parent.compile({});
    const config = {};

    const streamedEvents = await gatherIterator(
      graph.stream({ messages: [] }, { ...config, streamMode: "messages" })
    );

    expect(streamedEvents).toEqual([
      [
        new _AnyIdToolMessage({
          tool_call_id: "test",
          content: "q",
        }),
        {
          langgraph_step: 1,
          langgraph_node: "p_one",
          langgraph_triggers: ["branch:to:p_one"],
          langgraph_path: [PULL, "p_one"],
          langgraph_checkpoint_ns: expect.stringMatching(/^p_one:/),
          __pregel_task_id: expect.any(String),
          checkpoint_ns: expect.stringMatching(/^p_one:/),
          name: "p_one",
          tags: ["graph:step:1"],
        },
      ],
      [
        new _AnyIdHumanMessage({
          content: "f",
        }),
        {
          langgraph_step: 1,
          langgraph_node: "c_one",
          langgraph_triggers: ["branch:to:c_one"],
          langgraph_path: [PULL, "c_one"],
          langgraph_checkpoint_ns: expect.stringMatching(/^p_two:.*\|c_one:.*/),
          __pregel_task_id: expect.any(String),
          checkpoint_ns: expect.stringMatching(/^p_two:/),
          name: "c_one",
          tags: ["graph:step:1"],
        },
      ],
      [
        new _AnyIdAIMessage({
          content: "b",
        }),
        {
          langgraph_step: 1,
          langgraph_node: "c_one",
          langgraph_triggers: ["branch:to:c_one"],
          langgraph_path: [PULL, "c_one"],
          langgraph_checkpoint_ns: expect.stringMatching(/^p_two:.*\|c_one:.*/),
          __pregel_task_id: expect.any(String),
          checkpoint_ns: expect.stringMatching(/^p_two:/),
          name: "c_one",
          tags: ["graph:step:1"],
        },
      ],
      [
        new _AnyIdAIMessageChunk({
          content: "1",
        }),
        {
          langgraph_step: 2,
          langgraph_node: "c_two",
          langgraph_triggers: ["branch:to:c_two"],
          langgraph_path: [PULL, "c_two"],
          langgraph_checkpoint_ns: expect.stringMatching(/^p_two:.*\|c_two:.*/),
          __pregel_task_id: expect.any(String),
          checkpoint_ns: expect.stringMatching(/^p_two:/),
          ls_model_type: "chat",
          ls_provider: "FakeChatModel",
          ls_stop: undefined,
          tags: ["c_two_chat_model"],
          name: "c_two_chat_model_stream",
        },
      ],
      [
        new _AnyIdAIMessageChunk({
          content: "2",
        }),
        {
          langgraph_step: 2,
          langgraph_node: "c_two",
          langgraph_triggers: ["branch:to:c_two"],
          langgraph_path: [PULL, "c_two"],
          langgraph_checkpoint_ns: expect.stringMatching(/^p_two:.*\|c_two:.*/),
          __pregel_task_id: expect.any(String),
          checkpoint_ns: expect.stringMatching(/^p_two:/),
          ls_model_type: "chat",
          ls_provider: "FakeChatModel",
          ls_stop: undefined,
          tags: ["c_two_chat_model"],
        },
      ],
      [
        new _AnyIdAIMessageChunk({
          content: "x",
        }),
        {
          langgraph_step: 3,
          langgraph_node: "p_three",
          langgraph_triggers: ["branch:to:p_three"],
          langgraph_path: [PULL, "p_three"],
          langgraph_checkpoint_ns: expect.stringMatching(/^p_three/),
          __pregel_task_id: expect.any(String),
          checkpoint_ns: expect.stringMatching(/^p_three/),
          ls_model_type: "chat",
          ls_provider: "FakeChatModel",
          ls_stop: undefined,
          tags: [],
        },
      ],
    ]);

    const streamedCustomEvents: StateSnapshot[] = await gatherIterator(
      graph.stream({ messages: [] }, { ...config, streamMode: "custom" })
    );

    expect(streamedCustomEvents).toEqual([
      { from: "parent" },
      { content: "1", from: "subgraph" },
    ]);

    const streamedCombinedEvents = await gatherIterator(
      graph.stream(
        { messages: [] },
        { ...config, streamMode: ["custom", "messages"] }
      )
    );

    expect(streamedCombinedEvents).toMatchObject([
      ["custom", { from: "parent" }],
      [
        "messages",
        [
          new _AnyIdToolMessage({ tool_call_id: "test", content: "q" }),
          {
            langgraph_step: 1,
            langgraph_node: "p_one",
            langgraph_triggers: ["branch:to:p_one"],
            langgraph_path: [PULL, "p_one"],
            langgraph_checkpoint_ns: expect.stringMatching(/^p_one:/),
            __pregel_task_id: expect.any(String),
            checkpoint_ns: expect.stringMatching(/^p_one:/),
            name: "p_one",
            tags: ["graph:step:1"],
          },
        ],
      ],
      [
        "messages",
        [
          new _AnyIdHumanMessage({ content: "f" }),
          {
            langgraph_step: 1,
            langgraph_node: "c_one",
            langgraph_triggers: ["branch:to:c_one"],
            langgraph_path: [PULL, "c_one"],
            langgraph_checkpoint_ns:
              expect.stringMatching(/^p_two:.*\|c_one:.*/),
            __pregel_task_id: expect.any(String),
            checkpoint_ns: expect.stringMatching(/^p_two:/),
            name: "c_one",
            tags: ["graph:step:1"],
          },
        ],
      ],
      [
        "messages",
        [
          new _AnyIdAIMessage({ content: "b" }),
          {
            langgraph_step: 1,
            langgraph_node: "c_one",
            langgraph_triggers: ["branch:to:c_one"],
            langgraph_path: [PULL, "c_one"],
            langgraph_checkpoint_ns:
              expect.stringMatching(/^p_two:.*\|c_one:.*/),
            __pregel_task_id: expect.any(String),
            checkpoint_ns: expect.stringMatching(/^p_two:/),
            name: "c_one",
            tags: ["graph:step:1"],
          },
        ],
      ],
      [
        "messages",
        [
          new _AnyIdAIMessageChunk({ content: "1" }),
          {
            langgraph_step: 2,
            langgraph_node: "c_two",
            langgraph_triggers: ["branch:to:c_two"],
            langgraph_path: [PULL, "c_two"],
            langgraph_checkpoint_ns:
              expect.stringMatching(/^p_two:.*\|c_two:.*/),
            __pregel_task_id: expect.any(String),
            checkpoint_ns: expect.stringMatching(/^p_two:/),
            ls_model_type: "chat",
            ls_provider: "FakeChatModel",
            ls_stop: undefined,
            tags: ["c_two_chat_model"],
            name: "c_two_chat_model_stream",
          },
        ],
      ],
      ["custom", { from: "subgraph", content: "1" }],
      [
        "messages",
        [
          new _AnyIdAIMessageChunk({ content: "2" }),
          {
            langgraph_step: 2,
            langgraph_node: "c_two",
            langgraph_triggers: ["branch:to:c_two"],
            langgraph_path: [PULL, "c_two"],
            langgraph_checkpoint_ns:
              expect.stringMatching(/^p_two:.*\|c_two:.*/),
            __pregel_task_id: expect.any(String),
            checkpoint_ns: expect.stringMatching(/^p_two:/),
            ls_model_type: "chat",
            ls_provider: "FakeChatModel",
            ls_stop: undefined,
            tags: ["c_two_chat_model"],
          },
        ],
      ],
      [
        "messages",
        [
          new _AnyIdAIMessageChunk({ content: "x" }),
          {
            langgraph_step: 3,
            langgraph_node: "p_three",
            langgraph_triggers: ["branch:to:p_three"],
            langgraph_path: [PULL, "p_three"],
            langgraph_checkpoint_ns: expect.stringMatching(/^p_three/),
            __pregel_task_id: expect.any(String),
            checkpoint_ns: expect.stringMatching(/^p_three/),
            ls_model_type: "chat",
            ls_provider: "FakeChatModel",
            ls_stop: undefined,
            tags: [],
          },
        ],
      ],
    ]);
  });

  it("debug retry", async () => {
    const state = Annotation.Root({
      messages: Annotation<string[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
      }),
    });

    const checkpointer = await createCheckpointer();
    const graph = new StateGraph(state)
      .addNode("one", () => ({ messages: ["one"] }))
      .addNode("two", () => ({ messages: ["two"] }))
      .addEdge(START, "one")
      .addEdge("one", "two")
      .addEdge("two", END)
      .compile({ checkpointer });

    const config = { configurable: { thread_id: "1" } };
    await graph.invoke({ messages: [] }, config);

    // re-run step 1
    const targetConfig = (await gatherIterator(checkpointer.list(config))).find(
      (i) => i.metadata?.step === 1
    )?.parentConfig;
    expect(targetConfig).not.toBeUndefined();
    const updateConfig = await graph.updateState(targetConfig!, null);

    const events = await gatherIterator(
      graph.stream(null, { ...updateConfig, streamMode: "debug" })
    );

    const checkpointEvents: StateSnapshot[] = events
      .filter((item) => item.type === "checkpoint")
      .map((i) => i.payload);

    const checkpointHistoryMap = (
      await gatherIterator(graph.getStateHistory(config))
    ).reduce<Record<string, StateSnapshot>>((acc, item: StateSnapshot) => {
      acc[item.config.configurable!.checkpoint_id] = item;
      return acc;
    }, {});

    for (const stream of checkpointEvents) {
      expect(stream.config?.configurable).not.toEqual(
        stream.parentConfig?.configurable
      );

      const history =
        checkpointHistoryMap[stream.config!.configurable!.checkpoint_id];
      expect(stream.config.configurable).toEqual(history.config.configurable);
      expect(stream.parentConfig?.configurable).toEqual(
        history.parentConfig?.configurable
      );
    }
  });

  it("debug nested subgraph", async () => {
    const state = Annotation.Root({
      messages: Annotation<string[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
      }),
    });

    const checkpointer = await createCheckpointer();

    const child = new StateGraph(state)
      .addNode("c_one", () => ({ messages: ["c_one"] }))
      .addNode("c_two", () => ({ messages: ["c_two"] }))
      .addEdge(START, "c_one")
      .addEdge("c_one", "c_two")
      .addEdge("c_two", END);

    const parent = new StateGraph(state)
      .addNode("p_one", () => ({ messages: ["p_one"] }))
      .addNode("p_two", child.compile())
      .addEdge(START, "p_one")
      .addEdge("p_one", "p_two")
      .addEdge("p_two", END);

    const graph = parent.compile({ checkpointer });
    const config = { configurable: { thread_id: "1" } };

    const checkpointEvents: StateSnapshot[] = (
      await gatherIterator(
        graph.stream({ messages: [] }, { ...config, streamMode: "debug" })
      )
    )
      .filter((i) => i.type === "checkpoint")
      .map((i) => i.payload);

    const checkpointHistory = (
      await gatherIterator(graph.getStateHistory(config))
    ).reverse();

    function sanitizeCheckpoints(checkpoints: StateSnapshot[]) {
      return checkpoints.map((checkpoint) => {
        const clone = { ...checkpoint };
        delete clone.createdAt;
        if (clone.metadata) {
          clone.metadata = {
            ...clone.metadata,
            ...{ thread_id: "1" },
          };
        }
        return clone;
      });
    }

    expect(sanitizeCheckpoints(checkpointEvents)).toMatchObject(
      sanitizeCheckpoints(checkpointHistory)
    );
  });

  test.each([
    [
      "debug nested subgraph: default graph",
      (() => {
        const state = Annotation.Root({
          messages: Annotation<string[]>({
            reducer: (a, b) => a.concat(b),
            default: () => [],
          }),
        });

        const child = new StateGraph(state)
          .addNode("c_one", () => ({ messages: ["c_one"] }))
          .addNode("c_two", () => ({ messages: ["c_two"] }))
          .addEdge(START, "c_one")
          .addEdge("c_one", "c_two")
          .addEdge("c_two", END);

        const parent = new StateGraph(state)
          .addNode("p_one", () => ({ messages: ["p_one"] }))
          .addNode("p_two", child.compile())
          .addEdge(START, "p_one")
          .addEdge("p_one", "p_two")
          .addEdge("p_two", END);

        const grandParent = new StateGraph(state)
          .addNode("gp_one", () => ({ messages: ["gp_one"] }))
          .addNode("gp_two", parent.compile())
          .addEdge(START, "gp_one")
          .addEdge("gp_one", "gp_two")
          .addEdge("gp_two", END);

        return grandParent;
      })(),
    ],
    [
      "debug nested subgraph: subgraph as third argument",
      (() => {
        const state = Annotation.Root({
          messages: Annotation<string[]>({
            reducer: (a, b) => a.concat(b),
            default: () => [],
          }),
        });

        const child = new StateGraph(state)
          .addNode("c_one", () => ({ messages: ["c_one"] }))
          .addNode("c_two", () => ({ messages: ["c_two"] }))
          .addEdge(START, "c_one")
          .addEdge("c_one", "c_two")
          .addEdge("c_two", END)
          .compile();

        const parent = new StateGraph(state)
          .addNode("p_one", () => ({ messages: ["p_one"] }))
          .addNode("p_two", (state, config) => child.invoke(state, config), {
            subgraphs: [child],
          })
          .addEdge(START, "p_one")
          .addEdge("p_one", "p_two")
          .addEdge("p_two", END)
          .compile();

        const grandParent = new StateGraph(state)
          .addNode("gp_one", () => ({ messages: ["gp_one"] }))
          .addNode("gp_two", (state, config) => parent.invoke(state, config), {
            subgraphs: [parent],
          })
          .addEdge(START, "gp_one")
          .addEdge("gp_one", "gp_two")
          .addEdge("gp_two", END);

        return grandParent;
      })(),
    ],
  ])("%s", async (_title, grandParent) => {
    const checkpointer = await createCheckpointer();
    const graph = grandParent.compile({ checkpointer });

    const events = await gatherIterator(
      graph.stream(
        { messages: [] },
        {
          configurable: { thread_id: "1" },
          streamMode: "debug",
          subgraphs: true,
        }
      )
    );

    const streamCheckpointMap: Record<string, StateSnapshot[]> = {};
    const streamNamespaces: Record<string, string[]> = {};

    for (const [ns, item] of events) {
      if (item.type === "checkpoint") {
        streamCheckpointMap[ns.join("|")] ??= [];
        streamCheckpointMap[ns.join("|")].push(item.payload);
        streamNamespaces[ns.join("|")] = ns;
      }
    }

    expect(Object.values(streamNamespaces)).toEqual([
      [],
      [expect.stringMatching(/^gp_two:/)],
      [expect.stringMatching(/^gp_two:/), expect.stringMatching(/^p_two:/)],
    ]);

    const historyNs = await Promise.all(
      Object.keys(streamCheckpointMap).map((ns) =>
        gatherIterator(
          graph.getStateHistory({
            configurable: { thread_id: "1", checkpoint_ns: ns },
          })
        ).then((a) => a.reverse())
      )
    );

    function sanitizeCheckpoints(checkpoints: StateSnapshot[]) {
      return checkpoints.map((checkpoint) => {
        const clone = { ...checkpoint };

        // createdAt from streamed checkpoints is useless, as the date is being
        // handled by the checkpointer itself at the moment.
        delete clone.createdAt;

        if (clone.config?.configurable) {
          // TODO: figure out how to get checkpoint_map in streamed checkpoints
          delete clone.config.configurable.checkpoint_map;
        }

        if (clone.parentConfig?.configurable) {
          // TODO: figure out how to get checkpoint_map in streamed checkpoints
          delete clone.parentConfig.configurable.checkpoint_map;
        }

        if (clone.metadata) {
          // state snapshots are augmented with thread_id, so we add it to the cloned checkpoint so we don't get an assertion failure
          clone.metadata = {
            ...clone.metadata,
            ...{ thread_id: "1" },
          };
        }

        return clone;
      });
    }

    expect(
      Object.values(streamCheckpointMap).map(sanitizeCheckpoints)
    ).toMatchObject(historyNs.map(sanitizeCheckpoints));
  });

  it("test_parent_command", async () => {
    const getUserName = tool(
      async () => {
        return new Command({
          update: { user_name: "Meow" },
          graph: Command.PARENT,
        });
      },
      {
        name: "get_user_name",
        schema: z.object({}),
      }
    );
    const subgraph = new StateGraph(MessagesAnnotation)
      .addNode("tool", getUserName)
      .addEdge("__start__", "tool")
      .compile();

    const CustomParentStateAnnotation = Annotation.Root({
      ...MessagesAnnotation.spec,
      user_name: Annotation<string>,
    });

    const checkpointer = await createCheckpointer();

    const graph = new StateGraph(CustomParentStateAnnotation)
      .addNode("alice", subgraph)
      .addEdge("__start__", "alice")
      .compile({ checkpointer });

    const config = {
      configurable: {
        thread_id: "1",
      },
    };

    const res = await graph.invoke(
      {
        messages: [{ role: "user", content: "get user name" }],
      },
      config
    );

    expect(res).toEqual({
      messages: [
        new _AnyIdHumanMessage({
          content: "get user name",
        }),
      ],
      user_name: "Meow",
    });

    const state = await graph.getState(config);
    expect(state).toEqual({
      values: {
        messages: [
          new _AnyIdHumanMessage({
            content: "get user name",
          }),
        ],
        user_name: "Meow",
      },
      next: [],
      config: {
        configurable: {
          thread_id: "1",
          checkpoint_ns: "",
          checkpoint_id: expect.any(String),
        },
      },
      metadata: {
        source: "loop",
        writes: {
          alice: {
            user_name: "Meow",
          },
        },
        step: 1,
        parents: {},
        thread_id: "1",
      },
      createdAt: expect.any(String),
      parentConfig: {
        configurable: {
          thread_id: "1",
          checkpoint_ns: "",
          checkpoint_id: expect.any(String),
        },
      },
      tasks: [],
    });
  });

  it("test_parent_command with goto with double updates", async () => {
    const CustomStateAnnotation = Annotation.Root({
      ...MessagesAnnotation.spec,
      user_name: Annotation<string>({
        // Reducer is necessary because using Command.PARENT causes two updates
        reducer: (_, b) => b,
      }),
    });

    const getUserName = tool(
      async () => {
        return [
          new Command({
            update: { user_name: "Meow" },
            goto: "bob",
            graph: Command.PARENT,
          }),
        ];
      },
      {
        name: "get_user_name",
        schema: z.object({}),
      }
    );
    const subgraph = new StateGraph(CustomStateAnnotation)
      .addNode("init", async () => {
        return { user_name: "Woof" };
      })
      .addNode("tool", getUserName, { ends: ["__end__"] })
      .addEdge("__start__", "init")
      .addEdge("init", "tool")
      .compile();

    const checkpointer = await createCheckpointer();

    const graph = new StateGraph(CustomStateAnnotation)
      .addNode("init", async () => {
        return {};
      })
      .addNode("alice", subgraph)
      .addNode("bob", async (state) => {
        if (state.user_name !== "Meow") {
          throw new Error("failed to update state from child");
        }
        return { messages: [{ role: "assistant", content: "bob" }] };
      })
      .addEdge("__start__", "init")
      .addConditionalEdges("init", async () => "alice")
      .addEdge("alice", "bob")
      .compile({ checkpointer });

    const config = {
      configurable: {
        thread_id: "1",
      },
    };

    const res = await graph.invoke(
      { messages: [{ role: "user", content: "get user name" }] },
      config
    );

    expect(res).toEqual({
      messages: [
        new _AnyIdHumanMessage({
          content: "get user name",
        }),
        new _AnyIdAIMessage({
          content: "bob",
        }),
      ],
      user_name: "Meow",
    });

    const state = await graph.getState(config);

    expect(state).toEqual({
      values: {
        messages: [
          new _AnyIdHumanMessage({
            content: "get user name",
          }),
          new _AnyIdAIMessage({
            content: "bob",
          }),
        ],
        user_name: "Meow",
      },
      next: [],
      tasks: [],
      metadata: {
        source: "loop",
        thread_id: "1",
        writes: {
          bob: {
            messages: [
              {
                role: "assistant",
                content: "bob",
              },
            ],
          },
        },
        step: 3,
        parents: {},
      },
      config: {
        configurable: {
          thread_id: "1",
          checkpoint_id: expect.any(String),
          checkpoint_ns: "",
        },
      },
      createdAt: expect.any(String),
      parentConfig: {
        configurable: {
          thread_id: "1",
          checkpoint_ns: "",
          checkpoint_id: expect.any(String),
        },
      },
    });
  });

  it("test_parent_command from grandchild graph", async () => {
    const CustomStateAnnotation = Annotation.Root({
      ...MessagesAnnotation.spec,
      user_name: Annotation<string>,
    });

    const getUserName = tool(
      async () => {
        return new Command({
          update: {
            messages: [{ role: "assistant", content: "grandkid" }],
            user_name: "jeffrey",
          },
          goto: "robert",
          graph: Command.PARENT,
        });
      },
      {
        name: "get_user_name",
        schema: z.object({}),
      }
    );

    const grandchildGraph = new StateGraph(CustomStateAnnotation)
      .addNode("tool", getUserName)
      .addEdge("__start__", "tool")
      .compile();

    const childGraph = new StateGraph(CustomStateAnnotation)
      .addNode("bob", grandchildGraph)
      .addNode("robert", async (state) => {
        if (state.user_name !== "jeffrey") {
          throw new Error("failed to update state from grandchild");
        }
        return { messages: [{ role: "assistant", content: "robert" }] };
      })
      .addEdge("__start__", "bob")
      .addEdge("bob", "robert")
      .compile();

    const checkpointer = await createCheckpointer();

    const graph = new StateGraph(CustomStateAnnotation)
      .addNode("alice", childGraph)
      .addEdge("__start__", "alice")
      .compile({ checkpointer });

    const config = {
      configurable: {
        thread_id: "1",
      },
    };

    const res = await graph.invoke(
      {
        messages: [{ role: "user", content: "get user name" }],
      },
      config
    );

    expect(res).toEqual({
      messages: [
        new _AnyIdHumanMessage({
          content: "get user name",
        }),
        new _AnyIdAIMessage({
          content: "grandkid",
        }),
        new _AnyIdAIMessage({
          content: "robert",
        }),
      ],
      user_name: "jeffrey",
    });

    const state = await graph.getState(config);

    expect(state).toEqual({
      values: {
        messages: [
          new _AnyIdHumanMessage({
            content: "get user name",
          }),
          new _AnyIdAIMessage({
            content: "grandkid",
          }),
          new _AnyIdAIMessage({
            content: "robert",
          }),
        ],
        user_name: "jeffrey",
      },
      next: [],
      tasks: [],
      metadata: {
        source: "loop",
        writes: {
          alice: {
            messages: [
              new _AnyIdHumanMessage({
                content: "get user name",
              }),
              new _AnyIdAIMessage({
                content: "grandkid",
              }),
              new _AnyIdAIMessage({
                content: "robert",
              }),
            ],
            user_name: "jeffrey",
          },
        },
        step: 1,
        parents: {},
        thread_id: "1",
      },
      config: {
        configurable: {
          thread_id: "1",
          checkpoint_id: expect.any(String),
          checkpoint_ns: "",
        },
      },
      createdAt: expect.any(String),
      parentConfig: {
        configurable: {
          thread_id: "1",
          checkpoint_ns: "",
          checkpoint_id: expect.any(String),
        },
      },
    });
  });

  it("should handle Command.PARENT as described in the docs", async () => {
    // See https://langchain-ai.github.io/langgraphjs/how-tos/command/#navigating-to-a-node-in-a-parent-graph
    // Note that the example in the docs isn't deterministic, so this example is modified slightly
    // to allow us to decide which way the graph branches explicitly from outside of the graph

    // Define graph state
    const StateAnnotation = Annotation.Root({
      foo: Annotation<string>({
        reducer: (_, b) => b,
        default: () => "",
      }),
    });

    const callLog: string[] = [];
    let goto = ""; // will init before execution

    // Define the nodes
    const nodeASubgraph = async (_state: typeof StateAnnotation.State) => {
      callLog.push("Called A");
      return new Command({
        update: {
          foo: "a",
        },
        goto,
        graph: Command.PARENT,
      });
    };

    // Nodes B and C are unchanged
    const nodeB = async (state: typeof StateAnnotation.State) => {
      callLog.push("Called B");
      return {
        foo: state.foo + "|b",
      };
    };

    const nodeC = async (state: typeof StateAnnotation.State) => {
      callLog.push("Called C");
      return {
        foo: state.foo + "|c",
      };
    };

    const subgraph = new StateGraph(StateAnnotation)
      .addNode("nodeA", nodeASubgraph)
      .addEdge("__start__", "nodeA")
      .compile();

    const parentGraph = new StateGraph(StateAnnotation)
      .addNode("subgraph", subgraph, {
        ends: ["nodeB", "nodeC"],
      })
      .addNode("nodeB", nodeB)
      .addNode("nodeC", nodeC)
      .addEdge("__start__", "subgraph")
      .compile();

    goto = "nodeB";
    let result = await parentGraph.invoke({});
    expect(callLog).toEqual(["Called A", "Called B"]);
    expect(result).toEqual({ foo: "a|b" });

    // clear callLog
    callLog.splice(0, callLog.length);

    goto = "nodeC";
    result = await parentGraph.invoke({});
    expect(callLog).toEqual(["Called A", "Called C"]);
    expect(result).toEqual({ foo: "a|c" });
  });

  it("should pass recursion limit set via .withConfig", async () => {
    const StateAnnotation = Annotation.Root({
      prop: Annotation<string>,
    });
    const graph = new StateGraph(StateAnnotation)
      .addNode("first", async () => {
        return {
          prop: "foo",
        };
      })
      .addNode("second", async () => {
        return {};
      })
      .addEdge("__start__", "first")
      .addEdge("first", "second")
      .compile();
    expect(await graph.invoke({})).toEqual({
      prop: "foo",
    });
    const graphWithConfig = graph.withConfig({
      recursionLimit: 1,
    });
    await expect(graphWithConfig.invoke({})).rejects.toThrow(
      GraphRecursionError
    );
  });

  it("should pass custom callbacks set via .withConfig", async () => {
    const StateAnnotation = Annotation.Root({ prop: Annotation<string> });

    const seen = new Set<string>();
    const graph = new StateGraph(StateAnnotation)
      .addNode("one", () => ({ prop: "foo" }))
      .addEdge(START, "one")
      .compile()
      .withConfig({
        callbacks: [
          {
            handleChainStart: () => seen.add("handleChainStart"),
            handleChainEnd: () => seen.add("handleChainEnd"),
          },
        ],
      });

    await gatherIterator(
      graph.streamEvents({ prop: "bar" }, { version: "v2" })
    );
    expect(seen).toEqual(new Set(["handleChainStart", "handleChainEnd"]));
  });

  it("should interrupt and resume with Command inside a subgraph", async () => {
    const subgraph = new StateGraph(MessagesAnnotation)
      .addNode("one", (_) => {
        const interruptValue = interrupt("<INTERRUPTED>");
        if (interruptValue !== "<RESUMED>") {
          throw new Error("Expected interrupt to return <RESUMED>");
        }
        return {
          messages: [
            {
              role: "user",
              content: "success",
            },
          ],
        };
      })
      .addEdge(START, "one")
      .compile();

    const graph = new StateGraph(MessagesAnnotation)
      .addNode("one", () => {
        // No-op
        return {};
      })
      .addNode("subgraph", subgraph)
      .addNode("two", (state) => {
        if (state.messages.length !== 1) {
          throw new Error(`Expected 1 message, got ${state.messages.length}`);
        }
        return {};
      })
      .addEdge(START, "one")
      .addEdge("one", "subgraph")
      .addEdge("subgraph", "two")
      .addEdge("two", END)
      .compile({ checkpointer: await createCheckpointer() });

    const config = {
      configurable: { thread_id: "test_subgraph_interrupt_resume" },
    };

    await graph.invoke(
      {
        messages: [],
      },
      config
    );

    const currTasks = (await graph.getState(config)).tasks;
    expect(currTasks[0].interrupts).toHaveLength(1);

    // Resume with `Command`
    const result = await graph.invoke(
      new Command({
        resume: "<RESUMED>",
      }),
      config
    );

    const currTasksAfterCmd = (await graph.getState(config)).tasks;
    expect(currTasksAfterCmd).toHaveLength(0);

    expect(result.messages).toBeDefined();
    expect(result.messages).toHaveLength(1);
  });

  it("should interrupt and resume with Command inside a subgraph and Zod schema", async () => {
    const schema = z.object({
      foo: z.string(),
      items: z
        .array(z.string())
        .default(() => [])
        .langgraph.reducer(
          // eslint-disable-next-line no-nested-ternary
          (a, b) => a.concat(Array.isArray(b) ? b : b != null ? [b] : []),
          z.union([z.string(), z.array(z.string())])
        ),
    });

    const subgraph = new StateGraph(schema)
      .addNode("subnode", (_) => {
        const interruptValue = interrupt("<INTERRUPTED>");
        if (interruptValue !== "<RESUMED>") {
          throw new Error("Expected interrupt to return <RESUMED>");
        }
        return {
          foo: "subgraph",
          items: ["sub"],
        };
      })
      .addEdge(START, "subnode")
      .compile();
    let enterred = 0;
    const graph = new StateGraph(schema)
      .addNode("one", () => {
        enterred += 1;
        return { foo: "start", items: ["one"] };
      })
      .addNode("subgraph", subgraph)
      .addNode("two", (state) => {
        if (state.items.length < 2) {
          throw new Error(
            `Expected at least 2 items, got ${state.items.length}`
          );
        }
        return { foo: "done", items: ["two"] };
      })
      .addEdge(START, "one")
      .addEdge("one", "subgraph")
      .addEdge("subgraph", "two")
      .addEdge("two", END)
      .compile({ checkpointer: await createCheckpointer() });

    const config = {
      configurable: { thread_id: "test_subgraph_interrupt_resume_zod" },
    };

    await graph.invoke({ foo: "input", items: ["zero"] }, config);

    const currTasks = (await graph.getState(config)).tasks;
    expect(currTasks[0].interrupts).toHaveLength(1);

    // Resume with `Command`
    const result = await graph.invoke(
      new Command({ resume: "<RESUMED>" }),
      config
    );

    expect(enterred).toBe(1);
    const currTasksAfterCmd = (await graph.getState(config)).tasks;
    expect(currTasksAfterCmd).toHaveLength(0);

    expect(result.foo).toBe("done");
    // Since we return the full ["zero", "one", "sub"], it gets
    // appended to the existing ["zero", "one"], causing the expected "duplication"
    expect(result.items).toEqual(["zero", "one", "zero", "one", "sub", "two"]);
  });

  it("should be able to invoke a single node on a graph", async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("one", (state) => {
        if (!state.messages.length) {
          throw new Error("State not found");
        }
        return {
          messages: [
            ...state.messages,
            {
              role: "user",
              content: "success",
            },
          ],
        };
      })
      .addNode("two", () => {
        throw new Error("Should not be called");
      })
      .addEdge(START, "one")
      .addEdge("one", "two")
      .addEdge("two", END)
      .compile();
    const result = await graph.nodes.one.invoke({
      messages: [new HumanMessage("start")],
    });
    expect(result.messages).toBeDefined();
    expect(result.messages).toHaveLength(2);
  });

  it("Can have three graphs with different keys", async () => {
    const annotationOne = Annotation.Root({
      inputOne: Annotation<string>,
    });
    const annotationTwo = Annotation.Root({
      inputOne: Annotation<string>,
      inputTwo: Annotation<string>,
    });
    const annotationThree = Annotation.Root({
      inputTwo: Annotation<string>,
      inputThree: Annotation<string>,
    });

    const graphThree = new StateGraph(annotationThree)
      .addNode("returns", () => ({ inputThree: "one" }))
      .addEdge(START, "returns")
      .compile();

    const graphTwo = new StateGraph(annotationTwo)
      .addNode("one", () => ({ inputTwo: "one" }))
      .addNode("callGraphThree", graphThree, { input: annotationThree })
      .addEdge(START, "one")
      .addEdge("one", "callGraphThree")
      .addEdge("callGraphThree", END)
      .compile();

    const graphOne = new StateGraph(annotationOne)
      .addNode("one", () => ({ inputOne: "one" }))
      .addNode("callGraphTwo", graphTwo, { input: annotationTwo })
      .addEdge(START, "one")
      .addEdge("one", "callGraphTwo")
      .addEdge("callGraphTwo", END)
      .compile();

    await expect(graphOne.invoke({ inputOne: "one" })).resolves.toBeDefined();
  });

  it("Can access store inside a node", async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("one", async (_, configTop) => {
        expect(configTop.store).toBeDefined();
        return {};
      })
      .addEdge(START, "one")
      .compile({ store: new InMemoryStore() });

    await graph.invoke({ messages: [] });
  });

  it("can interrupt then update state with asNode of __end__", async () => {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("one", () => {
        throw new NodeInterrupt("<INTERRUPTED>");
      })
      .addEdge(START, "one")
      .compile({ checkpointer: await createCheckpointer() });

    const config = {
      configurable: { thread_id: "test_update_state_as_node_end" },
    };
    await expect(graph.invoke({ messages: [] }, config)).resolves.toBeDefined();

    const stateAfterInterrupt = await graph.getState(config);
    expect(stateAfterInterrupt.next).toEqual(["one"]);

    const updateStateResult = await graph.updateState(config, null, END);
    expect(updateStateResult).toBeDefined();
    const stateAfterUpdate = await graph.getState(config);
    expect(stateAfterUpdate.next).toEqual([]);
  });

  it("test_command_with_static_breakpoints", async () => {
    const StateAnnotation = Annotation.Root({
      foo: Annotation<string>,
    });
    const checkpointer = await createCheckpointer();
    const graph = new StateGraph(StateAnnotation)
      .addNode("node1", async (state: typeof StateAnnotation.State) => {
        return {
          foo: state.foo + "|node-1",
        };
      })
      .addNode("node2", async (state: typeof StateAnnotation.State) => {
        return {
          foo: state.foo + "|node-2",
        };
      })
      .addEdge("__start__", "node1")
      .addEdge("node1", "node2")
      .compile({ checkpointer, interruptBefore: ["node1"] });

    const config = {
      configurable: {
        thread_id: "1",
      },
    };

    expect(await graph.invoke({ foo: "abc" }, config)).toEqual({
      foo: "abc",
      __interrupt__: [],
    });

    const result = await graph.invoke(
      new Command({ update: { foo: "def" } }),
      config
    );
    expect(result).toEqual({
      foo: "def|node-1|node-2",
    });
  });

  it("can throw a node interrupt multiple times in a single node", async () => {
    const GraphAnnotation = Annotation.Root({
      myKey: Annotation<string>({
        reducer: (a, b) => a + b,
      }),
    });

    const nodeOne = (_: typeof GraphAnnotation.State) => {
      const answer = interrupt({ value: 1 });
      const answer2 = interrupt({ value: 2 });
      return { myKey: answer + " " + answer2 };
    };

    const graph = new StateGraph(GraphAnnotation)
      .addNode("one", nodeOne)
      .addEdge(START, "one")
      .compile({ checkpointer: await createCheckpointer() });

    const config = {
      configurable: { thread_id: "test_multi_interrupt" },
      streamMode: "values" as const,
    };
    const firstResult = await gatherIterator(
      graph.stream(
        {
          myKey: "DE",
        },
        config
      )
    );
    expect(firstResult).toBeDefined();
    const firstState = await graph.getState(config);
    expect(firstState.tasks).toHaveLength(1);
    expect(firstState.tasks[0].interrupts).toHaveLength(1);
    expect(firstState.tasks[0].interrupts[0].value).toEqual({
      value: 1,
    });

    const secondResult = await gatherIterator(
      graph.stream(
        new Command({
          resume: "answer 1",
        }),
        config
      )
    );
    expect(secondResult).toBeDefined();

    const secondState = await graph.getState(config);
    expect(secondState.tasks).toHaveLength(1);
    expect(secondState.tasks[0].interrupts).toHaveLength(1);
    expect(secondState.tasks[0].interrupts[0].value).toEqual({
      value: 2,
    });

    const thirdResult = await gatherIterator(
      graph.stream(
        new Command({
          resume: "answer 2",
        }),
        config
      )
    );
    expect(thirdResult[thirdResult.length - 1].myKey).toEqual(
      "DEanswer 1 answer 2"
    );
    const thirdState = await graph.getState(config);
    expect(thirdState.tasks).toHaveLength(0);
  });

  it("should throw when resuming without a checkpointer", async () => {
    const chain = Channel.subscribeTo("input").pipe(
      Channel.writeTo(["output"])
    );

    const channels = {
      input: new LastValue(),
      output: new LastValue(),
    };

    // create Pregel class
    const graph = new Pregel({
      nodes: { chain },
      debug: false,
      inputChannels: "input",
      outputChannels: "output",
      interruptBefore: ["chain"],
      streamMode: "values",
      channels,
    });

    // TODO: should ideally throw here when no checkpointer is provided
    expect(await graph.invoke("a")).toEqual({ __interrupt__: [] });

    await expect(() =>
      graph.invoke(new Command({ resume: "hello" }))
    ).rejects.toThrow("Cannot use Command(resume=...) without checkpointer");
  });

  it.each(["omit", "first-only", "always"] as const)(
    "`messages` inherits message ID - %p",
    async (streamMessageId) => {
      const checkpointer = await createCheckpointer();

      const graph = new StateGraph(MessagesAnnotation)
        .addNode("one", async () => {
          const model = new FakeChatModel({
            responses: [new AIMessage({ id: "123", content: "Output" })],
            streamMessageId,
          });

          const invoke = await model.invoke([new HumanMessage("Input")]);
          return { messages: invoke };
        })
        .addEdge(START, "one")
        .compile({ checkpointer });

      const messages = await gatherIterator(
        graph.stream(
          { messages: [] },
          { configurable: { thread_id: "1" }, streamMode: "messages" }
        )
      );

      const messageIds = [...new Set(messages.map(([m]) => m.id))];
      expect(messageIds).toHaveLength(1);
      if (streamMessageId !== "omit") expect(messageIds[0]).toBe("123");
    }
  );

  it("should not assign message ID for tool messages", async () => {
    const checkpointer = await createCheckpointer();
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("one", async () => {
        return {
          messages: [
            new ToolMessage({ content: "Tool 1", tool_call_id: "1" }),
            new ToolMessage({ content: "Tool 2", tool_call_id: "2" }),
          ],
        };
      })
      .addEdge(START, "one")
      .compile({ checkpointer });

    const messages = await gatherIterator(
      graph.stream(
        { messages: [] },
        { configurable: { thread_id: "1" }, streamMode: "messages" }
      )
    );

    expect(messages.length).toBe(2);
    expect(
      (await graph.getState({ configurable: { thread_id: "1" } })).values
        .messages
    ).toMatchObject([
      expect.objectContaining({ content: "Tool 1", tool_call_id: "1" }),
      expect.objectContaining({ content: "Tool 2", tool_call_id: "2" }),
    ]);
  });

  it("should not stream input messages in streamMode: messages", async () => {
    const subgraph = new StateGraph(MessagesAnnotation)
      .addNode("callModel", async () => {
        return {
          messages: new AIMessage({
            content: "Hi",
            id: "123",
          }),
        };
      })
      .addNode("route", async () => {
        return new Command({
          goto: "node2",
          graph: Command.PARENT,
        });
      })
      .addEdge(START, "callModel")
      .addEdge("callModel", "route")
      .compile();

    const graph = new StateGraph(MessagesAnnotation)
      .addNode("node1", subgraph, { ends: ["node2"] })
      .addNode("node2", async (state: typeof MessagesAnnotation.State) => state)
      .addEdge(START, "node1")
      .compile();

    const chunks = await gatherIterator(
      graph.stream(
        { messages: "hi" },
        { streamMode: "messages", subgraphs: true }
      )
    );

    expect(chunks.length).toBe(1);
    expect(chunks[0][0]).toEqual([
      expect.stringMatching(/^node1:.*$/),
      expect.stringMatching(/^callModel:.*$/),
    ]);
    expect(chunks[0][1][0]).toEqual(
      new AIMessage({ content: "Hi", id: "123" })
    );
    expect(chunks[0][1][1].langgraph_node).toEqual("callModel");
  });

  it("should not stream input messages in streamMode: messages when continuing checkpointed thread", async () => {
    const toEmit = [
      new AIMessage({
        content: "bye",
        id: "1",
      }),
      new AIMessage({
        content: "bye again",
        id: "2",
      }),
    ];
    const subgraph = new StateGraph(MessagesAnnotation)
      .addNode("callModel", async () => {
        return {
          messages: toEmit.shift(),
        };
      })
      .addNode("route", async () => {
        return new Command({
          goto: "node2",
          graph: Command.PARENT,
        });
      })
      .addEdge(START, "callModel")
      .addEdge("callModel", "route")
      .compile();

    const graph = new StateGraph(MessagesAnnotation)
      .addNode("node1", subgraph, { ends: ["node2"] })
      .addNode("node2", async (state: typeof MessagesAnnotation.State) => state)
      .addEdge(START, "node1")
      .compile({
        checkpointer: await createCheckpointer(),
      });

    const chunks = await gatherIterator(
      graph.stream(
        { messages: "hi" },
        {
          streamMode: "messages",
          subgraphs: true,
          configurable: { thread_id: "1" },
        }
      )
    );

    expect(chunks.length).toBe(1);
    expect(chunks[0][0]).toEqual([
      expect.stringMatching(/^node1:.*$/),
      expect.stringMatching(/^callModel:.*$/),
    ]);
    expect(chunks[0][1][0]).toEqual(new AIMessage({ content: "bye", id: "1" }));
    expect(chunks[0][1][1].langgraph_node).toEqual("callModel");

    const chunks2 = await gatherIterator(
      graph.stream(
        { messages: "bye" },
        {
          streamMode: "messages",
          subgraphs: true,
          configurable: { thread_id: "1" },
        }
      )
    );

    expect(chunks2.length).toBe(1);
    expect(chunks2[0][0]).toEqual([
      expect.stringMatching(/^node1:.*$/),
      expect.stringMatching(/^callModel:.*$/),
    ]);
    expect(chunks2[0][1][0]).toEqual(
      new AIMessage({ content: "bye again", id: "2" })
    );
    expect(chunks2[0][1][1].langgraph_node).toEqual("callModel");
  });

  it("should handle bulk state updates", async () => {
    const State = Annotation.Root({
      foo: Annotation<string>,
      baz: Annotation<string>,
    });

    const checkpointer = new MemorySaverAssertImmutable();

    const nodeA = (_state: typeof State.State) => ({ foo: "bar" });
    const nodeB = (_state: typeof State.State) => ({ baz: "qux" });

    const graph = new StateGraph(State)
      .addNode("nodeA", nodeA)
      .addNode("nodeB", nodeB)
      .addEdge(START, "nodeA")
      .addEdge("nodeA", "nodeB")
      .compile({ checkpointer });

    let config = { configurable: { thread_id: "1" } };

    // First update with nodeA
    await graph.bulkUpdateState(config, [
      { updates: [{ values: { foo: "bar" }, asNode: "nodeA" }] },
    ]);

    // Then bulk update with both nodes
    await graph.bulkUpdateState(config, [
      {
        updates: [
          { values: { foo: "updated" }, asNode: "nodeA" },
          { values: { baz: "new" }, asNode: "nodeB" },
        ],
      },
    ]);

    let state = await graph.getState(config);
    expect(state.values).toEqual({ foo: "updated", baz: "new" });

    // check if there are only two checkpoints
    let checkpoints = await gatherIterator(
      checkpointer.list({ configurable: { thread_id: "1" } })
    );

    expect(checkpoints.length).toBe(2);
    expect(checkpoints).toMatchObject([
      {
        metadata: {
          writes: { nodeA: { foo: "updated" }, nodeB: { baz: "new" } },
        },
      },
      { metadata: { writes: { nodeA: { foo: "bar" } } } },
    ]);

    // perform multiple steps at the same time
    config = { configurable: { thread_id: "2" } };

    await graph.bulkUpdateState(config, [
      {
        updates: [{ values: { foo: "bar" }, asNode: "nodeA" }],
      },
      {
        updates: [
          { values: { foo: "updated" }, asNode: "nodeA" },
          { values: { baz: "new" }, asNode: "nodeB" },
        ],
      },
    ]);

    state = await graph.getState(config);
    expect(state.values).toEqual({ foo: "updated", baz: "new" });

    checkpoints = await gatherIterator(
      checkpointer.list({ configurable: { thread_id: "1" } })
    );

    expect(checkpoints.length).toBe(2);
    expect(checkpoints).toMatchObject([
      {
        metadata: {
          writes: { nodeA: { foo: "updated" }, nodeB: { baz: "new" } },
        },
      },
      { metadata: { writes: { nodeA: { foo: "bar" } } } },
    ]);

    // throw error if updating without `asNode`
    await expect(
      graph.bulkUpdateState(config, [
        {
          updates: [{ values: { foo: "error" } }, { values: { bar: "error" } }],
        },
      ])
    ).rejects.toThrow();

    // throw if no updates are provided
    await expect(graph.bulkUpdateState(config, [])).rejects.toThrow(
      "No supersteps provided"
    );

    await expect(
      graph.bulkUpdateState(config, [{ updates: [] }])
    ).rejects.toThrow("No updates provided");

    // throw if __end__ or __copy__ update is applied in bulk
    await expect(
      graph.bulkUpdateState(config, [
        {
          updates: [
            { values: null, asNode: "__end__" },
            { values: null, asNode: "__copy__" },
          ],
        },
      ])
    ).rejects.toThrow();
  });

  it("update as input", async () => {
    const checkpointer = await createCheckpointer();
    const graph = new StateGraph(Annotation.Root({ foo: Annotation<string> }))
      .addNode("agent", () => ({ foo: "agent" }))
      .addNode("tool", () => ({ foo: "tool" }))
      .addEdge(START, "agent")
      .addEdge("agent", "tool")
      .compile({ checkpointer });

    expect(
      await graph.invoke({ foo: "input" }, { configurable: { thread_id: "1" } })
    ).toEqual({ foo: "tool" });

    expect(
      await graph.invoke({ foo: "input" }, { configurable: { thread_id: "1" } })
    ).toEqual({ foo: "tool" });

    const history = await gatherIterator(
      graph.getStateHistory({ configurable: { thread_id: "1" } })
    );

    // now clone the thread
    await graph.bulkUpdateState({ configurable: { thread_id: "2" } }, [
      // first turn
      { updates: [{ values: { foo: "input" }, asNode: "__input__" }] },
      { updates: [{ values: { foo: "input" }, asNode: "__start__" }] },
      { updates: [{ values: { foo: "agent" }, asNode: "agent" }] },
      { updates: [{ values: { foo: "tool" }, asNode: "tool" }] },

      // second turn
      { updates: [{ values: { foo: "input" }, asNode: "__input__" }] },
      { updates: [{ values: { foo: "input" }, asNode: "__start__" }] },
      { updates: [{ values: { foo: "agent" }, asNode: "agent" }] },
      { updates: [{ values: { foo: "tool" }, asNode: "tool" }] },
    ]);

    const state = await graph.getState({ configurable: { thread_id: "2" } });
    expect(state.values).toEqual({ foo: "tool" });

    const newHistory = await gatherIterator(
      graph.getStateHistory({ configurable: { thread_id: "2" } })
    );

    const mapSnapshot = (i: StateSnapshot) => ({
      values: i.values,
      next: i.next,
      step: i.metadata?.step,
    });

    expect(newHistory.map(mapSnapshot)).toMatchObject(history.map(mapSnapshot));
  });

  it("batch update as input (map-reduce)", async () => {
    const checkpointer = await createCheckpointer();
    const graph = new StateGraph(
      Annotation.Root({
        foo: Annotation<string>,
        tasks: Annotation<number[]>({
          default: () => [],
          reducer: (acc, task: number | number[]) => [
            ...acc,
            ...(Array.isArray(task) ? task : [task]),
          ],
        }),
      })
    )
      .addNode("agent", () => ({ foo: "agent" }))
      .addNode(
        "map",
        () => {
          return new Command({
            goto: [
              new Send("task", { index: 0 }),
              new Send("task", { index: 1 }),
              new Send("task", { index: 2 }),
            ],
            update: { foo: "map" },
          });
        },
        { ends: ["task"] }
      )
      .addNode("task", (task: { index: number }) => ({
        tasks: [task.index],
      }))
      .addEdge(START, "agent")
      .addEdge("agent", "map")
      .compile({ checkpointer });

    expect(
      await graph.invoke({ foo: "input" }, { configurable: { thread_id: "1" } })
    ).toEqual({ foo: "map", tasks: [0, 1, 2] });

    const mapSnapshot = (i: StateSnapshot) => ({
      values: i.values,
      next: i.next,
      step: i.metadata?.step,
      tasks: i.tasks.map((t) => t.name),
    });

    const history = await gatherIterator(
      graph.getStateHistory({ configurable: { thread_id: "1" } })
    );

    // now clone the thread
    await graph.bulkUpdateState({ configurable: { thread_id: "2" } }, [
      // first turn
      { updates: [{ values: { foo: "input" }, asNode: "__input__" }] },
      { updates: [{ values: { foo: "input" }, asNode: "__start__" }] },
      { updates: [{ values: { foo: "agent", tasks: [] }, asNode: "agent" }] },
      {
        updates: [
          {
            values: new Command({
              goto: [
                new Send("task", { index: 0 }),
                new Send("task", { index: 1 }),
                new Send("task", { index: 2 }),
              ],
              update: { foo: "map" },
            }),
            asNode: "map",
          },
        ],
      },
      {
        updates: [
          { values: { tasks: [0] }, asNode: "task" },
          { values: { tasks: [1] }, asNode: "task" },
          { values: { tasks: [2] }, asNode: "task" },
        ],
      },
    ]);

    const state = await graph.getState({ configurable: { thread_id: "2" } });
    expect(state.values).toEqual({ foo: "map", tasks: [0, 1, 2] });

    const newHistory = await gatherIterator(
      graph.getStateHistory({ configurable: { thread_id: "2" } })
    );

    expect(newHistory.map(mapSnapshot)).toMatchObject(history.map(mapSnapshot));
  });

  it("zod schema", async () => {
    const schema = z.object({
      foo: z.string(),
      items: z
        .array(z.string())
        .default(() => ["default"])
        .langgraph.reducer(
          // eslint-disable-next-line no-nested-ternary
          (a, b) => a.concat(Array.isArray(b) ? b : b != null ? [b] : []),
          z.union([z.string(), z.array(z.string())])
        ),
    });

    const graph = new StateGraph(schema)
      .addNode("agent", () => ({ foo: "agent", items: ["a", "b"] }))
      .addNode("tool", () => ({ foo: "tool", items: ["c", "d"] }))
      .addEdge("__start__", "agent")
      .addEdge("agent", "tool")
      .compile();

    const state = await graph.invoke(
      { foo: "input" },
      { configurable: { thread_id: "1" } }
    );

    expect(graph.builder._schemaRuntimeDefinition).toBeDefined();
    expect(state).toEqual({
      foo: "tool",
      items: ["default", "a", "b", "c", "d"],
    });

    expect(getStateTypeSchema(graph)).toStrictEqual({
      type: "object",
      properties: {
        foo: { type: "string" },
        items: {
          type: "array",
          items: { type: "string" },
          default: ["default"],
        },
      },
      required: ["foo"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(getUpdateTypeSchema(graph)).toStrictEqual({
      type: "object",
      properties: {
        foo: { type: "string" },
        items: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  it("zod schema - input / output", async () => {
    const state = z.object({
      hey: z.string(),
      counter: z.number().gt(0),
      messages: z
        .array(z.string())
        .langgraph.reducer(
          (a, b) => (Array.isArray(b) ? [...a, ...b] : [...a, b]),
          z.union([z.string(), z.array(z.string())])
        ),
    });

    const input = state.pick({ counter: true });
    const output = state.pick({ hey: true });

    const graph = new StateGraph({ state, input, output })
      .addNode("agent", () => ({ hey: "agent", counter: 1 }))
      .addNode("tool", () => ({ hey: "tool", counter: 2 }))
      .addEdge("__start__", "agent")
      .addEdge("agent", "tool")
      .compile();

    const value = await graph.invoke(
      { counter: 123 },
      { configurable: { thread_id: "1" } }
    );

    expect(value).toEqual({ hey: "tool" });

    await expect(
      graph.invoke({ counter: -1 }, { configurable: { thread_id: "1" } })
    ).rejects.toBeDefined();

    expect(getInputTypeSchema(graph)).toStrictEqual({
      type: "object",
      properties: {
        counter: { type: "number", exclusiveMinimum: 0 },
      },
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(getOutputTypeSchema(graph)).toStrictEqual({
      type: "object",
      properties: {
        hey: { type: "string" },
      },
      required: ["hey"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(getStateTypeSchema(graph)).toStrictEqual({
      type: "object",
      properties: {
        hey: { type: "string" },
        counter: { type: "number", exclusiveMinimum: 0 },
        messages: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["hey", "counter", "messages"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(getUpdateTypeSchema(graph)).toStrictEqual({
      type: "object",
      properties: {
        hey: { type: "string" },
        counter: { type: "number", exclusiveMinimum: 0 },
        messages: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  it("zod schema - config", async () => {
    const schema = z.object({
      foo: z.string(),
    });

    const config = z.object({
      prompt: z
        .string()
        .min(1)
        .langgraph.metadata({
          langgraph_nodes: ["agent"],
          langgraph_type: "prompt",
        }),
    });

    const graph = new StateGraph(schema, config)
      .addNode("agent", () => ({ foo: "agent" }))
      .addNode("tool", () => ({ foo: "tool" }))
      .addEdge("__start__", "agent")
      .addEdge("agent", "tool")
      .compile();

    expect(
      await graph.invoke(
        { foo: "input" },
        { configurable: { thread_id: "1", prompt: "user input" } }
      )
    ).toEqual({ foo: "tool" });

    await expect(
      graph.invoke(
        { foo: "input" },
        { configurable: { thread_id: "1", prompt: "" } }
      )
    ).rejects.toBeDefined();

    expect(getConfigTypeSchema(graph)).toStrictEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          langgraph_nodes: ["agent"],
          langgraph_type: "prompt",
          minLength: 1,
        },
      },
      required: ["prompt"],
      type: "object",
    });
  });

  it("zod overlap schema", async () => {
    const state = z.object({
      question: z.string(),
      answer: z.string(),
      language: z.string(),
    });

    const input = state.pick({ question: true });
    const output = state.pick({ answer: true });

    const graph = new StateGraph({ state, input, output })
      .addNode("agent", (state) => {
        return {
          answer: "agent",
          language: state.language,
        };
      })
      .addNode("tool", () => ({ answer: "tool" }))
      .addEdge("__start__", "agent")
      .addEdge("agent", "tool")
      .compile();

    await graph.invoke(
      { question: "hey" },
      { configurable: { thread_id: "1" } }
    );

    expect(getInputTypeSchema(graph)).toStrictEqual({
      type: "object",
      properties: {
        question: { type: "string" },
      },
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(getOutputTypeSchema(graph)).toStrictEqual({
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(getStateTypeSchema(graph)).toStrictEqual({
      type: "object",
      properties: {
        question: { type: "string" },
        answer: { type: "string" },
        language: { type: "string" },
      },
      required: ["question", "answer", "language"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(getUpdateTypeSchema(graph)).toStrictEqual({
      type: "object",
      properties: {
        question: { type: "string" },
        answer: { type: "string" },
        language: { type: "string" },
      },
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  it("Annotation overlap schema", async () => {
    const stateSchema = Annotation.Root({
      question: Annotation<string>,
      answer: Annotation<string>,
      language: Annotation<string>,
    });

    const input = Annotation.Root({
      question: Annotation<string>,
    });

    const output = Annotation.Root({
      answer: Annotation<string>,
    });

    // This should be a valid TypeScript code
    const graph = new StateGraph({ stateSchema, input, output })
      .addNode("agent", (state) => {
        return {
          answer: "agent",
          language: state.language,
        };
      })
      .addNode("tool", () => ({ answer: "tool" }))
      .addEdge("__start__", "agent")
      .addEdge("agent", "tool")
      .compile();

    const res = await graph.invoke(
      { question: "hey" },
      { configurable: { thread_id: "1" } }
    );

    expect(res).toEqual({ answer: "tool" });

    // @ts-expect-error `question` is not in the output schema
    void res.question;

    // @ts-expect-error `language` is not in the output schema
    void res.language;
  });

  it("can goto an interrupt", async () => {
    const checkpointer = await createCheckpointer();
    const configurable = { thread_id: "1" };

    const graph = new StateGraph(
      Annotation.Root({
        messages: Annotation<string[], string | string[]>({
          default: () => [],
          reducer: (a, b) => [...a, ...(Array.isArray(b) ? b : [b])],
        }),
      })
    )
      .addNode("router", () => new Command({ goto: END }), {
        ends: ["interrupt", END],
      })
      .addNode("interrupt", () => ({
        messages: [`interrupt: ${interrupt("interrupt")}`],
      }))
      .addEdge(START, "router")
      .compile({ checkpointer });

    await graph.invoke({ messages: ["input"] }, { configurable });
    let state = await graph.getState({ configurable });

    expect(state.next).toEqual([]);
    expect(state.values).toEqual({ messages: ["input"] });

    await graph.invoke(
      new Command({ goto: "interrupt", update: { messages: ["update"] } }),
      { configurable }
    );
    state = await graph.getState({ configurable });

    expect(state.next).toEqual(["interrupt"]);
    expect(state.values).toEqual({ messages: ["input", "update"] });
    expect(state.tasks).toMatchObject([
      {
        name: "interrupt",
        interrupts: [{ value: "interrupt", when: "during", resumable: true }],
      },
    ]);

    await graph.invoke(
      new Command({
        resume: "resume",
        update: { messages: ["update: resume"] },
      }),
      { configurable }
    );
    state = await graph.getState({ configurable });

    expect(state.next).toEqual([]);
    expect(state.values).toEqual({
      messages: ["input", "update", "update: resume", "interrupt: resume"],
    });
  });

  it("persist a falsy value", async () => {
    const checkpointer = await createCheckpointer();

    const builder = new StateGraph(
      Annotation.Root({
        ...MessagesAnnotation.spec,
        number: Annotation<number>,
        boolean: Annotation<boolean>,
        string: Annotation<string>,
      })
    )
      .addNode("node", (state) => state)
      .addEdge("__start__", "node");

    const graph = builder.compile({ checkpointer });

    const input = { number: 0, boolean: false, string: "" };
    const config = { configurable: { thread_id: "thread_id" } };

    await gatherIterator(graph.stream(input, config));

    expect(await graph.getState(config)).toMatchObject({
      values: { number: 0, boolean: false, string: "" },
    });
  });

  describe("add sequence", () => {
    const State = Annotation.Root({
      foo: Annotation<string[]>({
        default: () => [],
        reducer: (a, b) => [...a, ...b],
      }),
      bar: Annotation<string>(),
    });

    const step1 = (): typeof State.Update => ({
      foo: ["step1"],
      bar: "baz",
    });

    const step2 = (): typeof State.Update => ({
      foo: ["step2"],
    });

    it("should raise error if less than 1 step", () => {
      expect(() => new StateGraph(State).addSequence([])).toThrow();
    });

    it("should raise error if duplicate step names", () => {
      expect(() => {
        new StateGraph(State).addSequence([
          ["foo", step1],
          ["foo", step1],
        ]);
      }).toThrow();
    });

    it("should work with dictionary", async () => {
      const graph = new StateGraph(State)
        .addSequence({ step1, step2 })
        .addEdge("__start__", "step1")
        .compile();

      const result = await graph.invoke({ foo: [] });
      expect(result).toEqual({ foo: ["step1", "step2"], bar: "baz" });

      const streamChunks = await gatherIterator(graph.stream({ foo: [] }));
      expect(streamChunks).toEqual([
        { step1: { foo: ["step1"], bar: "baz" } },
        { step2: { foo: ["step2"] } },
      ]);
    });

    it("should work with list of tuples", async () => {
      const graph = new StateGraph(State)
        .addSequence([
          ["meow1", step1],
          ["meow2", step2],
        ])
        .addEdge("__start__", "meow1")
        .compile();

      const result = await graph.invoke({ foo: [] });
      expect(result).toEqual({ foo: ["step1", "step2"], bar: "baz" });

      const streamChunks = await gatherIterator(graph.stream({ foo: [] }));
      expect(streamChunks).toEqual([
        { meow1: { foo: ["step1"], bar: "baz" } },
        { meow2: { foo: ["step2"] } },
      ]);
    });

    it("should work with two sequences", async () => {
      const a = () => ({ foo: ["a"] });
      const b = () => ({ foo: ["b"] });

      const graph = new StateGraph(State)
        .addSequence({ a })
        .addSequence({ b })
        .addEdge("__start__", "a")
        .addEdge("a", "b")
        .compile();

      const result = await graph.invoke({ foo: [] });
      expect(result).toEqual({ foo: ["a", "b"] });

      const streamChunks = await gatherIterator(graph.stream({ foo: [] }));
      expect(streamChunks).toEqual([
        { a: { foo: ["a"] } },
        { b: { foo: ["b"] } },
      ]);
    });

    it("should work with mixed nodes and sequences", async () => {
      const a = () => ({ foo: ["a"] });
      const b = () => ({ foo: ["b"] });
      const c = () => ({ foo: ["c"] });
      const d = () => ({ foo: ["d"] });
      const e = () => ({ foo: ["e"] });

      const foo = (state: typeof State.State) => {
        if (state.foo[0] === "a") {
          return "d";
        }
        return "c";
      };

      const graph = new StateGraph(State)
        .addSequence({ a, b })
        .addConditionalEdges("b", foo)
        .addNode("c", c)
        .addSequence([
          ["d", d],
          ["e", e],
        ])
        .addEdge("__start__", "a")
        .compile();

      const result1 = await graph.invoke({ foo: [] });
      expect(result1).toEqual({ foo: ["a", "b", "d", "e"] });

      const result2 = await graph.invoke({ foo: ["start"] });
      expect(result2).toEqual({ foo: ["start", "a", "b", "c"] });

      const streamChunks = await gatherIterator(graph.stream({ foo: [] }));
      expect(streamChunks).toEqual([
        { a: { foo: ["a"] } },
        { b: { foo: ["b"] } },
        { d: { foo: ["d"] } },
        { e: { foo: ["e"] } },
      ]);
    });
  });

  it("test_concurrent_emit_sends", async () => {
    const State = Annotation.Root({
      foo: Annotation<string[]>({
        default: () => [],
        reducer: (a, b) => [...a, ...b],
      }),
    });

    const node = <T extends string>(
      name: T
    ): [T, (state: typeof State.State | number) => typeof State.Update] => [
      name,
      (state) => {
        if (typeof state === "number") return { foo: [`${name}|${state}`] };
        return { foo: [name] };
      },
    ];

    const graph = new StateGraph(State)
      .addNode([node("1"), node("1.1"), node("2"), node("3"), node("3.1")])
      .addEdge("__start__", "1")
      .addEdge("__start__", "1.1")
      .addConditionalEdges("1", () => [
        new Send("2", 1),
        new Send("2", 2),
        "3.1",
      ])
      .addConditionalEdges("1.1", () => [new Send("2", 3), new Send("2", 4)])
      .addConditionalEdges("2", () => "3")
      .compile();

    const result = await graph.invoke({ foo: ["0"] });
    expect(result.foo).toEqual([
      "0",
      "1",
      "1.1",
      "3.1",
      "2|1",
      "2|2",
      "2|3",
      "2|4",
      "3",
    ]);
  });

  it("resume multiple interrupts", async () => {
    const checkpointer = await createCheckpointer();
    const config = { configurable: { thread_id: "1" } };

    const graph = new StateGraph(
      Annotation.Root({
        inputs: Annotation<("a" | "b" | "c")[]>,
        outputs: Annotation<string[]>({
          default: () => [],
          reducer: (a, b) => [...a, ...b],
        }),
      })
    )
      .addNode({
        a: () => ({ outputs: [interrupt<string>("a")] }),
        b: () => ({ outputs: [interrupt<string>("b")] }),
        c: () => ({ outputs: [interrupt<string>("c")] }),
      })
      .addNode(
        "cleanup",
        (state) => {
          expect(state.outputs).toHaveLength(state.inputs.length);
          return {};
        },
        { defer: true }
      )
      .addConditionalEdges(
        START,
        (state) => state.inputs.map((prompt) => new Send(prompt, state)),
        ["a", "b", "c"]
      )
      .addEdge(["a", "b", "c"], "cleanup")
      .compile({ checkpointer });

    const values = await graph.invoke({ inputs: ["a", "b", "c"] }, config);
    const state = await graph.getState(config);

    if (!isInterrupted(values)) throw new Error("Graph was not interrupted");
    expect(values[INTERRUPT]).toEqual(state.tasks.flatMap((t) => t.interrupts));

    // TODO: add tests for multiple resumes after we have a stable ID for interrupts
  });
}

runPregelTests(() => new MemorySaverAssertImmutable());
