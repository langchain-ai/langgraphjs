/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `wrangler dev src/index.ts` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `wrangler deploy src/index.ts --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

// import all entrypoints to test, do not do this in your own app
import "./entrypoints.js";

// Import a few things we'll use to test the exports
import { END, START, StateGraph, StateGraphArgs } from "@langchain/langgraph/web";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { HumanMessage } from "@langchain/core/messages";
import { Tool } from "@langchain/core/tools";
import { FakeListChatModel } from "@langchain/core/utils/testing";

export default {
  async fetch(
    request: Request,
  ): Promise<Response> {
    // Define the graph state
    const graphState: StateGraphArgs<any>["channels"] = {
      messages: {
        value: (x: HumanMessage[], y: HumanMessage[]) => x.concat(y),
        default: () => [],
      },
    };
    const graph = new StateGraph({ channels: graphState })
      .addNode("test", async () => {})
      .addEdge(START, "test")
      .addEdge("test", END);;
    const compiledGraph = graph.compile();
    const graphRes = await compiledGraph.invoke({ messages: [] });

    const weatherResponse = `Not too cold, not too hot 😎`;
    const model = new FakeListChatModel({
      responses: ["test response"],
    });
    class SanFranciscoWeatherTool extends Tool {
      name = "current_weather";

      description = "Get the current weather report for San Francisco, CA";

      constructor() {
        super();
      }

      async _call(_: string): Promise<string> {
        return weatherResponse;
      }
    }
    const tools = [new SanFranciscoWeatherTool()];

    const reactAgent = createReactAgent({ llm: model, tools });

    const stream = await reactAgent.stream(
      {
        messages: [new HumanMessage("What's the weather like in SF?")],
      },
      { streamMode: "values" }
    );
    const fullResponse = [];
    for await (const item of stream) {
      fullResponse.push(item);
    }

    return new Response(
      `Hello, from Cloudflare Worker at ${request.url}. Assistant says: ${JSON.stringify(graphRes)}, ${JSON.stringify(fullResponse)}`
    );
  },
};
