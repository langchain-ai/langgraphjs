import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
import { Tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { ToolExecutor } from "./prebuilt/tool_executor.js";

const tools: Tool[] = [new TavilySearchResults({ maxResults: 1 })];

const toolExecutor = new ToolExecutor({
  tools,
});

// We will set streaming=True so that we can stream tokens
// See the streaming section for more information on this.
const model = new ChatOpenAI({
  temperature: 0,
  streaming: true,
});
