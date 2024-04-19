/* eslint-disable no-process-env */
import { it, expect, jest, beforeAll, describe } from "@jest/globals";
import {
  RunnableConfig,
  RunnableLambda,
  RunnablePassthrough,
} from "@langchain/core/runnables";
import { AgentAction, AgentFinish } from "@langchain/core/agents";
import { PromptTemplate } from "@langchain/core/prompts";
import { FakeStreamingLLM } from "@langchain/core/utils/testing";
import { Tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  AIMessage,
  BaseMessage,
  FunctionMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { FakeChatModel } from "./utils.js";
import { LastValue } from "../channels/last_value.js";
import { END, Graph, StateGraph } from "../graph/index.js";
import { ReservedChannelsMap } from "../pregel/reserved.js";
import { Topic } from "../channels/topic.js";
import { ChannelInvoke } from "../pregel/read.js";
import { InvalidUpdateError } from "../channels/base.js";
import { MemorySaverAssertImmutable } from "../checkpoint/memory.js";
import { BinaryOperatorAggregate } from "../channels/binop.js";
import { Channel, GraphRecursionError, Pregel } from "../pregel/index.js";
import { ToolExecutor, createAgentExecutor } from "../prebuilt/index.js";
import { MessageGraph } from "../graph/message.js";

// Tracing slows down the tests
beforeAll(() => {
  process.env.LANGCHAIN_TRACING_V2 = "false";
  process.env.LANGCHAIN_ENDPOINT = "";
  process.env.LANGCHAIN_ENDPOINT = "";
  process.env.LANGCHAIN_API_KEY = "";
  process.env.LANGCHAIN_PROJECT = "";
});

it("can invoke pregel with a single process", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: {
      one: chain,
    },
    channels: {
      input: new LastValue<number>(),
      output: new LastValue<number>(),
    },
    input: "input",
    output: "output",
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
  const addOne = jest.fn((x: number): number => x + 1);

  const graph = new Graph();
  graph.addNode("add_one", addOne);
  graph.setEntryPoint("add_one");
  graph.setFinishPoint("add_one");
  const gapp = graph.compile();

  expect(await gapp.invoke(2)).toBe(3);
});

it("should process input and produce output with implicit channels", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({ nodes: { one: chain } });

  expect(await app.invoke(2)).toBe(3);

  // Verify the mock was called correctly
  expect(addOne).toHaveBeenCalled();
});

it("should process input and write kwargs correctly", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(
      Channel.writeTo("output", {
        fixed: 5,
        outputPlusOne: (x: number) => x + 1,
      })
    );

  const app = new Pregel({
    nodes: { one: chain },
    output: ["output", "fixed", "outputPlusOne"],
  });

  expect(await app.invoke(2)).toEqual({
    output: 3,
    fixed: 5,
    outputPlusOne: 4,
  });
});

it("should process input and check for last step", async () => {
  const addOne = jest.fn((x: { input: number; is_last_step?: boolean }) => ({
    ...x,
    input: x.input + 1,
  }));
  const chain = Channel.subscribeTo(["input"])
    .join([ReservedChannelsMap.isLastStep])
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one: chain },
  });

  expect(await app.invoke(2)).toEqual({ input: 3, isLastStep: false });
  expect(await app.invoke(2, { recursionLimit: 1 })).toEqual({
    input: 3,
    isLastStep: true,
  });
});

it("should throw if you try to join channels when all are not named", async () => {
  const channel = Channel.subscribeTo("input");
  expect(() => {
    channel.join([ReservedChannelsMap.isLastStep]);
  }).toThrowError();
});

it("should invoke single process in out objects", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: {
      one: chain,
    },
    output: ["output"],
  });

  expect(await app.invoke(2)).toEqual({ output: 3 });
});

it("should process input and output as objects", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const chain = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one: chain },
    input: ["input"],
    output: ["output"],
  });

  expect(await app.invoke({ input: 2 })).toEqual({ output: 3 });
});

it("should invoke two processes and get correct output", async () => {
  const addOne = jest.fn((x: number): number => x + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("inbox"));
  const two = Channel.subscribeTo("inbox")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two },
  });

  await expect(app.invoke(2, { recursionLimit: 1 })).rejects.toThrow(
    GraphRecursionError
  );

  expect(await app.invoke(2)).toEqual(4);

  const stream = await app.stream(2);
  let step = 0;
  for await (const value of stream) {
    if (step === 0) {
      expect(value).toEqual({ inbox: 3 });
    } else if (step === 1) {
      expect(value).toEqual({ output: 4 });
    }
    step += 1;
  }
});

it("should process two processes with object input and output", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("inbox"));
  const two = Channel.subscribeTo("inbox")
    .pipe(new RunnableLambda({ func: addOne }).map())
    .pipe(Channel.writeTo("output").map());

  const app = new Pregel({
    nodes: { one, two },
    channels: { inbox: new Topic<number>() },
    input: ["input", "inbox"],
  });

  const streamResult = await app.stream(
    { input: 2, inbox: 12 },
    { outputKeys: "output" }
  );
  const outputResults = [];
  for await (const result of streamResult) {
    outputResults.push(result);
  }
  expect(outputResults).toEqual([13, 4]); // [12 + 1, 2 + 1 + 1]

  const fullStreamResult = await app.stream({ input: 2, inbox: 12 });
  const fullOutputResults = [];
  for await (const result of fullStreamResult) {
    fullOutputResults.push(result);
  }
  expect(fullOutputResults).toEqual([
    { inbox: [3], output: 13 },
    { output: 4 },
  ]);
});

it("should process batch with two processes and delays", async () => {
  const addOneWithDelay = jest.fn(
    (inp: number): Promise<number> =>
      new Promise((resolve) => {
        setTimeout(() => resolve(inp + 1), inp * 100);
      })
  );

  const one = Channel.subscribeTo("input")
    .pipe(addOneWithDelay)
    .pipe(Channel.writeTo("one"));
  const two = Channel.subscribeTo("one")
    .pipe(addOneWithDelay)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two },
  });

  expect(await app.batch([3, 2, 1, 3, 5])).toEqual([5, 4, 3, 5, 7]);
  expect(await app.batch([3, 2, 1, 3, 5], { outputKeys: ["output"] })).toEqual([
    { output: 5 },
    { output: 4 },
    { output: 3 },
    { output: 5 },
    { output: 7 },
  ]);
});

it("should process batch with two processes and delays with graph", async () => {
  const addOneWithDelay = jest.fn(
    (inp: number): Promise<number> =>
      new Promise((resolve) => {
        setTimeout(() => resolve(inp + 1), inp * 100);
      })
  );

  const graph = new Graph();
  graph.addNode("add_one", addOneWithDelay);
  graph.addNode("add_one_more", addOneWithDelay);
  graph.setEntryPoint("add_one");
  graph.setFinishPoint("add_one_more");
  graph.addEdge("add_one", "add_one_more");
  const gapp = graph.compile();

  expect(await gapp.batch([3, 2, 1, 3, 5])).toEqual([5, 4, 3, 5, 7]);
});

it("should batch many processes with input and output", async () => {
  const testSize = 100;
  const addOne = jest.fn((x: number) => x + 1);

  const nodes: Record<string, ChannelInvoke> = {
    "-1": Channel.subscribeTo("input").pipe(addOne).pipe(Channel.writeTo("-1")),
  };

  for (let i = 0; i < testSize - 2; i += 1) {
    nodes[String(i)] = Channel.subscribeTo(String(i - 1))
      .pipe(addOne)
      .pipe(Channel.writeTo(String(i)));
  }
  nodes.last = Channel.subscribeTo(String(testSize - 3))
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({ nodes });

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
  const addOne = jest.fn((x: number): number => x + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));
  const two = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two },
  });

  await expect(app.invoke(2)).rejects.toThrow(InvalidUpdateError);
});

it("should process two inputs to two outputs validly", async () => {
  const addOne = jest.fn((x: number): number => x + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));
  const two = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two },
    channels: { output: new Topic<number>() },
  });

  // An Inbox channel accumulates updates into a sequence
  expect(await app.invoke(2)).toEqual([3, 3]);
});

it("should handle checkpoints correctly", async () => {
  const inputPlusTotal = jest.fn(
    (x: { total: number; input: number }): number => x.total + x.input
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
    .pipe(Channel.writeTo("output", "total"))
    .pipe(raiseIfAbove10);

  const memory = new MemorySaverAssertImmutable();

  const app = new Pregel({
    nodes: { one },
    channels: { total: new BinaryOperatorAggregate<number>((a, b) => a + b) },
    checkpointer: memory,
  });

  // total starts out as 0, so output is 0+2=2
  await expect(
    app.invoke(2, { configurable: { threadId: "1" } })
  ).resolves.toBe(2);
  let checkpoint = await memory.get({ configurable: { threadId: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channelValues.total).toBe(2);

  // total is now 2, so output is 2+3=5
  await expect(
    app.invoke(3, { configurable: { threadId: "1" } })
  ).resolves.toBe(5);
  checkpoint = await memory.get({ configurable: { threadId: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channelValues.total).toBe(7);

  // total is now 2+5=7, so output would be 7+4=11, but raises Error
  await expect(
    app.invoke(4, { configurable: { threadId: "1" } })
  ).rejects.toThrow("Input is too large");
  // checkpoint is not updated
  checkpoint = await memory.get({ configurable: { threadId: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channelValues.total).toBe(7);

  // on a new thread, total starts out as 0, so output is 0+5=5
  await expect(
    app.invoke(5, { configurable: { threadId: "2" } })
  ).resolves.toBe(5);
  checkpoint = await memory.get({ configurable: { threadId: "1" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channelValues.total).toBe(7);
  checkpoint = await memory.get({ configurable: { threadId: "2" } });
  expect(checkpoint).not.toBeNull();
  expect(checkpoint?.channelValues.total).toBe(5);
});

it("should process two inputs joined into one topic and produce two outputs", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const add10Each = jest.fn((x: number[]): number[] =>
    x.map((y) => y + 10).sort()
  );

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("inbox"));
  const chainThree = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("inbox"));
  const chainFour = Channel.subscribeTo("inbox")
    .pipe(add10Each)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: {
      one,
      chainThree,
      chainFour,
    },
    channels: { inbox: new Topic<number>() },
  });

  // Invoke app and check results
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
  const addOne = jest.fn((x: number): number => x + 1);
  const add10Each = jest.fn((x: number[]): number[] => x.map((y) => y + 10));

  const innerApp = new Pregel({
    nodes: {
      one: Channel.subscribeTo("input")
        .pipe(addOne)
        .pipe(Channel.writeTo("output")),
    },
  });

  const one = Channel.subscribeTo("input")
    .pipe(add10Each)
    .pipe(Channel.writeTo("inbox_one").map());

  const two = Channel.subscribeTo("inbox_one")
    .pipe(() => innerApp.map())
    .pipe((x: number[]) => x.sort())
    .pipe(Channel.writeTo("outbox_one"));

  const chainThree = Channel.subscribeTo("outbox_one")
    .pipe((x: number[]) => x.reduce((a, b) => a + b, 0))
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: {
      one,
      two,
      chain_three: chainThree,
    },
    channels: { inbox_one: new Topic<number>() },
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
  const addOne = jest.fn((x: number) => x + 1);

  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(
      Channel.writeTo(
        { output: new RunnablePassthrough() },
        { between: new RunnablePassthrough() }
      )
    );

  const two = Channel.subscribeTo("between")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));

  const app = new Pregel({
    nodes: { one, two },
  });

  const results = await app.stream(2);
  const streamResults = [];
  for await (const chunk of results) {
    streamResults.push(chunk);
  }

  expect(streamResults).toEqual([{ between: 3, output: 3 }, { output: 4 }]);
});

it("should finish executing without output", async () => {
  const addOne = jest.fn((x: number): number => x + 1);
  const one = Channel.subscribeTo("input")
    .pipe(addOne)
    .pipe(Channel.writeTo("between"));
  const two = Channel.subscribeTo("between").pipe(addOne);

  const app = new Pregel({ nodes: { one, two } });

  // It finishes executing (once no more messages being published)
  // but returns nothing, as nothing was published to OUT topic
  expect(await app.invoke(2)).toBeUndefined();
});

it("should throw an error when no input channel is provided", () => {
  const addOne = jest.fn((x: number): number => x + 1);

  const one = Channel.subscribeTo("between")
    .pipe(addOne)
    .pipe(Channel.writeTo("output"));
  const two = Channel.subscribeTo("between").pipe(addOne);

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

  type AgentState = {
    input: string;
    agentOutcome?: AgentAction | AgentFinish;
    steps: Step[];
  };

  const executeTools = async (data: AgentState) => {
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
      steps: [[agentOutcome, observation]],
    };
  };

  const shouldContinue = async (data: AgentState): Promise<string> => {
    if (data.agentOutcome && "returnValues" in data.agentOutcome) {
      return "exit";
    }
    return "continue";
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

    const agent = async (state: AgentState) => {
      const chain = prompt.pipe(llm).pipe(agentParser);
      const result = await chain.invoke({ input: state.input });
      return {
        ...result,
      };
    };

    const workflow = new StateGraph<AgentState>({
      channels: {
        input: {
          value: null,
        },
        agentOutcome: {
          value: null,
        },
        steps: {
          value: (x: Step[], y: Step[]) => x.concat(y),
          default: () => [],
        },
      },
    });

    workflow.addNode("agent", agent);
    workflow.addNode("tools", executeTools);

    workflow.setEntryPoint("agent");

    workflow.addConditionalEdges("agent", shouldContinue, {
      continue: "tools",
      exit: END,
    });

    workflow.addEdge("tools", "agent");

    const app = workflow.compile();
    const result = await app.invoke({ input: "what is the weather in sf?" });
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

    const agent = async (state: AgentState) => {
      const chain = prompt.pipe(llm).pipe(agentParser);
      const result = await chain.invoke({ input: state.input });
      return {
        ...result,
      };
    };

    const workflow = new StateGraph<AgentState>({
      channels: {
        input: {
          value: null,
        },
        agentOutcome: {
          value: null,
        },
        steps: {
          value: (x: Step[], y: Step[]) => x.concat(y),
          default: () => [],
        },
      },
    });

    workflow.addNode("agent", agent);
    workflow.addNode("tools", executeTools);

    workflow.setEntryPoint("agent");

    workflow.addConditionalEdges("agent", shouldContinue, {
      continue: "tools",
      exit: END,
    });

    workflow.addEdge("tools", "agent");

    const app = workflow.compile();
    const stream = await app.stream({ input: "what is the weather in sf?" });
    const streamItems = [];
    for await (const item of stream) {
      streamItems.push(item);
    }
    expect(streamItems.length).toBe(6);
    expect(streamItems[0]).toEqual({
      agent: {
        agentOutcome: {
          tool: "search_api",
          toolInput: "query",
          log: "tool:search_api:query",
        },
      },
    });
    expect(streamItems[1]).toEqual({
      tools: {
        steps: [
          [
            {
              tool: "search_api",
              toolInput: "query",
              log: "tool:search_api:query",
            },
            "result for query",
          ],
        ],
      },
    });
    expect(streamItems[2]).toEqual({
      agent: {
        agentOutcome: {
          tool: "search_api",
          toolInput: "another",
          log: "tool:search_api:another",
        },
      },
    });
    expect(streamItems[3]).toEqual({
      tools: {
        steps: [
          [
            {
              tool: "search_api",
              toolInput: "another",
              log: "tool:search_api:another",
            },
            "result for another",
          ],
        ],
      },
    });
    expect(streamItems[4]).toEqual({
      agent: {
        agentOutcome: {
          returnValues: {
            answer: "answer",
          },
          log: "finish:answer",
        },
      },
    });
    expect(streamItems[5]).toEqual({
      [END]: {
        input: "what is the weather in sf?",
        agentOutcome: {
          returnValues: { answer: "answer" },
          log: "finish:answer",
        },
        steps: [
          [
            {
              tool: "search_api",
              toolInput: "query",
              log: "tool:search_api:query",
            },
            "result for query",
          ],
          [
            {
              tool: "search_api",
              toolInput: "another",
              log: "tool:search_api:another",
            },
            "result for another",
          ],
        ],
      },
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
      options?: { config?: RunnableConfig }
    ) => {
      const lastMessage = data[data.length - 1];

      const action = {
        tool: lastMessage.additional_kwargs.function_call?.name ?? "",
        toolInput: lastMessage.additional_kwargs.function_call?.arguments ?? "",
        log: "",
      };

      const response = await toolExecutor.invoke(action, options?.config);
      return new FunctionMessage({
        content: JSON.stringify(response),
        name: action.tool,
      });
    };

    const workflow = new MessageGraph<Array<BaseMessage>>();

    workflow.addNode("agent", model);
    workflow.addNode("action", callTool);

    workflow.setEntryPoint("agent");

    workflow.addConditionalEdges("agent", shouldContinue, {
      continue: "action",
      end: END,
    });

    workflow.addEdge("action", "agent");

    const app = workflow.compile();

    const result = await app.invoke(
      new HumanMessage("what is the weather in sf?")
    );

    expect(result).toHaveLength(6);
    expect(result).toStrictEqual([
      new HumanMessage("what is the weather in sf?"),
      new AIMessage({
        content: "",
        additional_kwargs: {
          function_call: {
            name: "search_api",
            arguments: "query",
          },
        },
      }),
      new FunctionMessage({
        content: '"result for query"',
        name: "search_api",
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
      new FunctionMessage({
        content: '"result for another"',
        name: "search_api",
      }),
      new AIMessage("answer"),
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
      options?: { config?: RunnableConfig }
    ) => {
      const lastMessage = data[data.length - 1];

      const action = {
        tool: lastMessage.additional_kwargs.function_call?.name ?? "",
        toolInput: lastMessage.additional_kwargs.function_call?.arguments ?? "",
        log: "",
      };

      const response = await toolExecutor.invoke(action, options?.config);
      return new FunctionMessage({
        content: JSON.stringify(response),
        name: action.tool,
      });
    };
    const workflow = new MessageGraph<Array<BaseMessage>>();

    workflow.addNode("agent", model);
    workflow.addNode("action", callTool);

    workflow.setEntryPoint("agent");

    workflow.addConditionalEdges("agent", shouldContinue, {
      continue: "action",
      end: END,
    });

    workflow.addEdge("action", "agent");

    const app = workflow.compile();

    const stream = await app.stream([
      new HumanMessage("what is the weather in sf?"),
    ]);
    const streamItems = [];
    for await (const item of stream) {
      streamItems.push(item);
    }

    const lastItem = streamItems[streamItems.length - 1];
    expect(Object.keys(lastItem)).toEqual([END]);
    expect(Object.values(lastItem)[0]).toHaveLength(6);
    expect(Object.values(lastItem)[0]).toStrictEqual([
      new HumanMessage("what is the weather in sf?"),
      new AIMessage({
        content: "",
        additional_kwargs: {
          function_call: {
            name: "search_api",
            arguments: "query",
          },
        },
      }),
      new FunctionMessage({
        content: '"result for query"',
        name: "search_api",
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
      new FunctionMessage({
        content: '"result for another"',
        name: "search_api",
      }),
      new AIMessage("answer"),
    ]);
  });
});

it("Conditional edges is optional", async () => {
  type GraphState = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keys: Record<string, any>;
  };
  const graphState = {
    keys: {
      value: null,
    },
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

  const workflow = new StateGraph<GraphState>({
    channels: graphState,
  });
  workflow.addNode("one", nodeOne);
  workflow.addNode("two", nodeTwo);
  workflow.addNode("three", nodeThree);
  workflow.setEntryPoint("one");
  workflow.addConditionalEdges("one", decideNext);
  workflow.addEdge("two", "three");
  workflow.addEdge("three", END);

  const app = workflow.compile();

  // This will always return two, and two will always go to three
  // meaning keys.value will always be 3
  const result = await app.invoke({ keys: { value: 0 } });
  expect(result).toEqual({ keys: { value: 3 } });
});

it("In one fan out state graph waiting edge", async () => {
  const sortedAdd = jest.fn((x: string[], y: string[]): string[] =>
    [...x, ...y].sort()
  );

  type State = {
    query?: string;
    answer?: string;
    docs?: string[];
  };

  function rewriteQuery(data: State): State {
    return { query: `query: ${data.query}` };
  }

  function analyzerOne(data: State): State {
    return { query: `analyzed: ${data.query}` };
  }

  function retrieverOne(_data: State): State {
    return { docs: ["doc1", "doc2"] };
  }

  function retrieverTwo(_data: State): State {
    return { docs: ["doc3", "doc4"] };
  }

  function qa(data: State): State {
    return { answer: data.docs?.join(",") };
  }

  const schema = {
    query: { value: null },
    answer: { value: null },
    docs: { value: sortedAdd },
  };
  const workflow = new StateGraph({
    channels: schema,
  });

  workflow.addNode("rewrite_query", rewriteQuery);
  workflow.addNode("analyzer_one", analyzerOne);
  workflow.addNode("retriever_one", retrieverOne);
  workflow.addNode("retriever_two", retrieverTwo);
  workflow.addNode("qa", qa);

  workflow.setEntryPoint("rewrite_query");
  workflow.addEdge("rewrite_query", "analyzer_one");
  workflow.addEdge("analyzer_one", "retriever_one");
  workflow.addEdge("rewrite_query", "retriever_two");
  workflow.addEdge(["retriever_one", "retriever_two"], "qa");
  workflow.setFinishPoint("qa");

  const app = workflow.compile();

  expect(await app.invoke({ query: "what is weather in sf" })).toEqual({
    query: "analyzed: query: what is weather in sf",
    docs: ["doc1", "doc2", "doc3", "doc4"],
    answer: "doc1,doc2,doc3,doc4",
  });
});
