# AI Elements — Tool-Calling Agent Example

A self-contained chat interface built with [AI Elements](https://elements.ai-sdk.dev/) components and `@langchain/react`. It demonstrates how to build a production-quality agentic UI using AI Elements' composable component library.

## What it shows

- **Tool call rendering** — each tool invocation is displayed with `Tool` + `ToolHeader` + `ToolContent` + `ToolInput` + `ToolOutput`, updating live as the agent streams tool input and then the result.
- **Reasoning display** — when the model emits reasoning tokens, a collapsible `Reasoning` block auto-opens during streaming and collapses when done.
- **Streaming messages** — `Message` + `MessageContent` + `MessageResponse` renders streaming markdown via Streamdown with full GFM support.
- **Loading skeleton** — a `Shimmer` placeholder appears between the user's message and the first assistant token.
- **Conversation scroll** — `Conversation` + `ConversationContent` + `ConversationScrollButton` auto-scrolls and shows a jump-to-bottom button when you scroll up.
- **Message actions** — `MessageActions` + `MessageAction` with a copy button appears below the last assistant message once streaming completes.
- **Prompt input** — `PromptInput` + `PromptInputBody` + `PromptInputTextarea` + `PromptInputFooter` + `PromptInputSubmit` provides a full-featured input bar.
- **Suggestions** — `Suggestions` + `Suggestion` shows preset prompts before the first message.

## Agent

The backing LangGraph agent (`packages/agents/src/agents/ai-elements.ts`) is a `createReactAgent` with two simulated tools:

| Tool          | Description                                                 |
| ------------- | ----------------------------------------------------------- |
| `get_weather` | Returns deterministic simulated weather data for any city   |
| `web_search`  | Returns three simulated search result objects for any query |

No external API keys are required for the tools.

## Setup

Create a `.env` file in this folder (optional — defaults are provided):

```bash
VITE_LANGGRAPH_API_URL=http://localhost:2024   # default when running locally
VITE_LANGGRAPH_ASSISTANT_ID=ai_elements         # matches langgraph.json
```

## Run

Start the LangGraph agent server first:

```bash
bun run dev --filter=@langchain/playground-agents
```

Then start this preview app:

```bash
bun run dev --filter=@langchain/playground-preview-ai-elements
```

Open [http://localhost:4600](http://localhost:4600).

## AI Elements components used

| Component                                                                                         | Source file                                   |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `Conversation`, `ConversationContent`, `ConversationScrollButton`                                 | `src/components/ai-elements/conversation.tsx` |
| `Message`, `MessageContent`, `MessageResponse`, `MessageActions`, `MessageAction`                 | `src/components/ai-elements/message.tsx`      |
| `PromptInput`, `PromptInputBody`, `PromptInputTextarea`, `PromptInputFooter`, `PromptInputSubmit` | `src/components/ai-elements/prompt-input.tsx` |
| `Tool`, `ToolHeader`, `ToolContent`, `ToolInput`, `ToolOutput`                                    | `src/components/ai-elements/tool.tsx`         |
| `Reasoning`, `ReasoningTrigger`, `ReasoningContent`                                               | `src/components/ai-elements/reasoning.tsx`    |
| `Suggestions`, `Suggestion`                                                                       | `src/components/ai-elements/suggestion.tsx`   |
| `Shimmer`                                                                                         | `src/components/ai-elements/shimmer.tsx`      |

Components live in `src/components/ai-elements/` and are owned by this package (shadcn/AI Elements registry style — copy-paste, not a node_modules import).

## Vite path alias

AI Elements components use bare `src/` imports (e.g. `import { cn } from "src/lib/utils"`). The `vite.config.ts` maps `src` → `./src` to resolve these correctly in both dev and production builds.
