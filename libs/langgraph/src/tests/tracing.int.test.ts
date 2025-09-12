/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-process-env */

import { test } from "vitest";
import { pull } from "langchain/hub";
import { ChatOpenAI } from "@langchain/openai";
import { TavilySearch } from "@langchain/tavily";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { AgentAction, AgentFinish, AgentStep } from "@langchain/core/agents";
import { RunnableLambda } from "@langchain/core/runnables";
import {
  AgentExecutor,
  createOpenAIFunctionsAgent,
  createOpenAIToolsAgent,
} from "langchain/agents";
import {
  JsonOutputFunctionsParser,
  JsonOutputToolsParser,
} from "langchain/output_parsers";
import { createOpenAIFnRunnable } from "langchain/chains/openai_functions";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { ToolExecutor } from "../prebuilt/tool_executor.js";
import { createAgentExecutor } from "../prebuilt/agent_executor.js";
// Import from main `@langchain/langgraph` endpoint to turn on automatic config passing
import { StateGraph, END, START } from "../index.js";

test.skip("Can invoke with tracing", async () => {
  const tools = [new TavilySearch({ maxResults: 1 })];

  // Get the prompt to use - you can modify this!
  const prompt = await pull<ChatPromptTemplate>(
    "hwchase17/openai-functions-agent"
  );

  // Choose the LLM that will drive the agent
  const llm = new ChatOpenAI({
    modelName: "gpt-4-1106-preview",
    temperature: 0,
  });

  // Construct the OpenAI Functions agent
  const agentRunnable = await createOpenAIFunctionsAgent({
    llm,
    tools,
    prompt,
  });

  interface AgentState {
    agentOutcome?: AgentAction | AgentFinish;
    steps: Array<AgentStep>;
    input: string;
    chatHistory?: BaseMessage[];
  }

  const toolExecutor = new ToolExecutor({
    tools,
  });

  // Define logic that will be used to determine which conditional edge to go down
  const shouldContinue = (data: AgentState) => {
    if (data.agentOutcome && "returnValues" in data.agentOutcome) {
      return "end";
    }
    return "continue";
  };

  const runAgent = async (data: AgentState) => {
    const agentOutcome = await agentRunnable.invoke(data);
    return {
      agentOutcome,
    };
  };

  const executeTools = async (data: AgentState) => {
    const agentAction = data.agentOutcome;
    if (!agentAction || "returnValues" in agentAction) {
      throw new Error("Agent has not been run yet");
    }
    const output = await toolExecutor.invoke(agentAction);
    return {
      steps: [{ action: agentAction, observation: JSON.stringify(output) }],
    };
  };

  // Define a new graph
  const workflow = new StateGraph<AgentState>({
    channels: {
      input: null,
      steps: {
        value: (x: any, y: any) => x.concat(y),
        default: () => [],
      },
      agentOutcome: null,
    },
  })
    // Define the two nodes we will cycle between
    .addNode("agent", new RunnableLambda({ func: runAgent }))
    .addNode("action", new RunnableLambda({ func: executeTools }))
    // Set the entrypoint as `agent`
    // This means that this node is the first one called
    .addEdge(START, "agent")
    // We now add a conditional edge
    .addConditionalEdges(
      // First, we define the start node. We use `agent`.
      // This means these are the edges taken after the `agent` node is called.
      "agent",
      // Next, we pass in the function that will determine which node is called next.
      shouldContinue,
      // Finally we pass in a mapping.
      // The keys are strings, and the values are other nodes.
      // END is a special node marking that the graph should finish.
      // What will happen is we will call `should_continue`, and then the output of that
      // will be matched against the keys in this mapping.
      // Based on which one it matches, that node will then be called.
      {
        // If `tools`, then we call the tool node.
        continue: "action",
        // Otherwise we finish.
        end: END,
      }
    )
    // We now add a normal edge from `tools` to `agent`.
    // This means that after `tools` is called, `agent` node is called next.
    .addEdge("action", "agent");

  const app = workflow.compile();

  const inputs = { input: "what is the weather in sf" };
  for await (const s of await app.stream(inputs)) {
    console.log(s);
    console.log("----\n");
  }
});

test.skip("Can nest an agent executor", async () => {
  const tools = [new TavilySearch({ maxResults: 3 })];
  const llm = new ChatOpenAI({
    modelName: "gpt-4-1106-preview",
    temperature: 0,
  });
  const systemPrompt = `You are a web researcher. You may use the Tavily search engine to search the web for important information.`;
  // Each worker node will be given a name and some tools.
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    new MessagesPlaceholder("messages"),
    new MessagesPlaceholder("agent_scratchpad"),
  ]);
  const agent = await createOpenAIToolsAgent({ llm, tools, prompt });
  const executor = new AgentExecutor({ agent, tools });
  const researcherNode = async (state: any) => {
    console.log("STATE", state);
    const result = await executor.invoke(state);
    return {
      messages: [
        new HumanMessage({ content: result.output, name: "researcher" }),
      ],
    };
  };

  // Define the routing function
  const functionDef = {
    name: "route",
    description: "Select the next role.",
    parameters: {
      title: "routeSchema",
      type: "object",
      properties: {
        next: {
          title: "Next",
          anyOf: [{ enum: ["FINISH", "researcher"] }],
        },
      },
      required: ["next"],
    },
  };
  const toolDef = {
    type: "function",
    function: functionDef,
  } as const;

  const supervisorPrompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    new MessagesPlaceholder("messages"),
    [
      "system",
      "Given the conversation above, who should act next? Or should we FINISH? Select one of: {options}",
    ],
  ]);

  const formattedPrompt = await supervisorPrompt.partial({
    options: ["FINISH", "researcher"].join(", "),
  });

  const supervisorChain = formattedPrompt
    .pipe(
      llm.bind({
        tools: [toolDef],
        tool_choice: { type: "function", function: { name: "route" } },
      })
    )
    .pipe(new JsonOutputToolsParser())
    // select the first one
    .pipe((x) => x[0].args);

  interface State {
    next: string;
    messages: BaseMessage[];
  }

  // 1. Create the graph
  const workflow = new StateGraph<State>({
    channels: {
      messages: {
        value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
      },
      next: null,
    },
  })
    // 2. Add the nodes; these will do the work
    .addNode("researcher", researcherNode)
    .addNode("supervisor", supervisorChain)
    // 3. Define the edges. We will define both regular and conditional ones
    // After a worker completes, report to supervisor
    .addEdge("researcher", "supervisor")
    // When the supervisor returns, route to the agent identified in the supervisor's output
    .addConditionalEdges("supervisor", (x: State) => x.next, {
      researcher: "researcher",
      // Or end work if done
      FINISH: END,
    })
    .addEdge(START, "supervisor");

  const graph = workflow.compile();

  const streamResults = graph.stream(
    {
      messages: [
        new HumanMessage({
          content: "Who is the current prime minister of malaysia?",
        }),
      ],
    },
    { tags: ["outer_tag"], recursionLimit: 100 }
  );

  for await (const output of await streamResults) {
    if (!("__end__" in output)) {
      console.log(output);
      console.log("----");
    }
  }
});

test.skip("Can nest a graph within a graph", async () => {
  const tools = [new TavilySearch({ maxResults: 3 })];
  const llm = new ChatOpenAI({
    modelName: "gpt-4-1106-preview",
    temperature: 0,
  });
  const systemPrompt = `You are a web researcher. You may use the Tavily search engine to search the web for important information.`;
  // Each worker node will be given a name and some tools.
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    new MessagesPlaceholder("messages"),
    new MessagesPlaceholder("agent_scratchpad"),
  ]);
  const agent = await createOpenAIToolsAgent({ llm, tools, prompt });
  const executor = new AgentExecutor({ agent, tools });
  const researcherNode = async (state: any) => {
    const result = await executor.invoke(state);
    return {
      messages: [
        new HumanMessage({ content: result.output, name: "researcher" }),
      ],
    };
  };

  // Define the routing function
  const functionDef = {
    name: "route",
    description: "Select the next role.",
    parameters: {
      title: "routeSchema",
      type: "object",
      properties: {
        next: {
          title: "Next",
          anyOf: [{ enum: ["FINISH", "researcher"] }],
        },
      },
      required: ["next"],
    },
  };
  const toolDef = {
    type: "function",
    function: functionDef,
  } as const;

  const supervisorPrompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    new MessagesPlaceholder("messages"),
    [
      "system",
      "Given the conversation above, who should act next? Or should we FINISH? Select one of: {options}",
    ],
  ]);

  const formattedPrompt = await supervisorPrompt.partial({
    options: ["FINISH", "researcher"].join(", "),
  });

  const supervisorChain = formattedPrompt
    .pipe(
      llm.bind({
        tools: [toolDef],
        tool_choice: { type: "function", function: { name: "route" } },
      })
    )
    .pipe(new JsonOutputToolsParser())
    // select the first one
    .pipe((x) => x[0].args);

  interface State {
    next: string;
    messages: BaseMessage[];
  }

  // 1. Create the graph
  const workflow = new StateGraph<State>({
    channels: {
      messages: {
        value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
      },
      next: null,
    },
  })
    // 2. Add the nodes; these will do the work
    .addNode("researcher", researcherNode)
    .addNode("supervisor", supervisorChain)
    // 3. Define the edges. We will define both regular and conditional ones
    // After a worker completes, report to supervisor
    .addEdge("researcher", "supervisor")
    // When the supervisor returns, route to the agent identified in the supervisor's output
    .addConditionalEdges("supervisor", (x: State) => x.next, {
      researcher: "researcher",
      FINISH: END,
    })
    .addEdge(START, "supervisor");

  const graph = workflow.compile();

  const streamResults = graph.stream(
    {
      messages: [
        new HumanMessage({
          content: "Who is the current prime minister of malaysia?",
        }),
      ],
    },
    { tags: ["outer_tag"], recursionLimit: 100 }
  );

  for await (const output of await streamResults) {
    if (!("__end__" in output)) {
      console.log(output);
      console.log("----");
    }
  }
});

test.skip("Should trace plan and execute flow", async () => {
  const tools = [new TavilySearch({ maxResults: 3 })];
  // Get the prompt to use - you can modify this!
  const prompt = await pull<ChatPromptTemplate>(
    "hwchase17/openai-functions-agent"
  );
  // Choose the LLM that will drive the agent
  const llm = new ChatOpenAI({ modelName: "gpt-4-0125-preview" });
  // Construct the OpenAI Functions agent
  const agentRunnable = await createOpenAIFunctionsAgent({
    llm,
    tools,
    prompt,
  });
  const agentExecutor = createAgentExecutor({
    agentRunnable,
    tools,
  });

  const plan = zodToJsonSchema(
    z.object({
      steps: z
        .array(z.string())
        .describe("different steps to follow, should be in sorted order"),
    })
  );
  const planFunction = {
    name: "plan",
    description: "This tool is used to plan the steps to follow",
    parameters: plan,
  };
  const plannerPrompt =
    ChatPromptTemplate.fromTemplate(`For the given objective, come up with a simple step by step plan. \
This plan should involve individual tasks, that if executed correctly will yield the correct answer. Do not add any superfluous steps. \
The result of the final step should be the final answer. Make sure that each step has all the information needed - do not skip steps.

{objective}`);
  const model = new ChatOpenAI({
    modelName: "gpt-4-0125-preview",
  }).bind({
    functions: [planFunction],
    function_call: planFunction,
  });
  const parserSingle = new JsonOutputFunctionsParser<Record<string, any>>({
    argsOnly: true,
  });
  const planner = plannerPrompt.pipe(model).pipe(parserSingle);
  const response = zodToJsonSchema(
    z.object({
      response: z.string().describe("Response to user."),
    })
  );
  const responseFunction = {
    name: "response",
    description: "Response to user.",
    parameters: response,
  };
  const replannerPrompt =
    ChatPromptTemplate.fromTemplate(`For the given objective, come up with a simple step by step plan.
This plan should involve individual tasks, that if executed correctly will yield the correct answer. Do not add any superfluous steps.
The result of the final step should be the final answer. Make sure that each step has all the information needed - do not skip steps.

Your objective was this:
{input}

Your original plan was this:
{plan}

You have currently done the follow steps:
{pastSteps}

Update your plan accordingly. If no more steps are needed and you can return to the user, then respond with that and use the 'response' function.
Otherwise, fill out the plan.
Only add steps to the plan that still NEED to be done. Do not return previously done steps as part of the plan.`);
  const parser = new JsonOutputFunctionsParser<Record<string, any>>();
  const replanner = createOpenAIFnRunnable({
    functions: [planFunction, responseFunction],
    outputParser: parser,
    llm: new ChatOpenAI({
      modelName: "gpt-4-0125-preview",
    }),
    prompt: replannerPrompt as any,
  });

  interface PlanExecuteState {
    input: string | null;
    plan: Array<string>;
    pastSteps: Array<string>;
    response: string | null;
  }

  async function executeStep(
    state: PlanExecuteState
  ): Promise<Partial<PlanExecuteState>> {
    const task = state.input;
    const agentResponse = await agentExecutor.invoke({
      input: task ?? undefined,
    });

    const outcome = agentResponse.agentOutcome;
    if (!outcome || !("returnValues" in outcome)) {
      throw new Error("Agent did not return a valid outcome.");
    }

    return { pastSteps: [task, outcome.returnValues.output] };
  }

  async function planStep(
    state: PlanExecuteState
  ): Promise<Partial<PlanExecuteState>> {
    if (!state.input) {
      throw new Error("No input.");
    }
    const plan = await planner.invoke({ objective: state.input });
    return { plan: plan.steps };
  }

  async function replanStep(
    state: PlanExecuteState
  ): Promise<Partial<PlanExecuteState>> {
    const output = await replanner.invoke({
      input: state.input,
      plan: state.plan ? state.plan.join("\n") : "",
      pastSteps: state.pastSteps.join("\n"),
    });
    if (output.response !== undefined) {
      return { response: output.response };
    }

    return { plan: output.steps };
  }

  function shouldEnd(state: PlanExecuteState) {
    if (state.response) {
      return "true";
    }
    return "false";
  }

  const workflow = new StateGraph<PlanExecuteState>({
    channels: {
      input: null,
      plan: null,
      pastSteps: {
        reducer: (x, y) => x.concat(y),
        default: () => [],
      },
      response: null,
    },
  })
    // Add the plan node
    .addNode("planner", planStep)
    // Add the execution step
    .addNode("agent", executeStep)
    // Add a replan node
    .addNode("replan", replanStep)
    .addEdge(START, "planner")
    // From plan we go to agent
    .addEdge("planner", "agent")
    // From agent, we replan
    .addEdge("agent", "replan")
    .addConditionalEdges(
      "replan",
      // Next, we pass in the function that will determine which node is called next.
      shouldEnd,
      {
        true: END,
        false: "planner",
      }
    );

  // Finally, we compile it!
  // This compiles it into a LangChain Runnable,
  // meaning you can use it as you would any other runnable
  const app = workflow.compile();
  const config = { recursionLimit: 50 };
  const inputs = {
    input: "what is the hometown of the 2024 Australia open winner?",
  };

  for await (const event of await app.stream(inputs, config)) {
    console.log(event);
  }
});
