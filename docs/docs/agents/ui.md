# UI

You can use a prebuilt chat UI for interacting with any LangGraph agent through the [Agent Chat UI](https://github.com/langchain-ai/agent-chat-ui). Using the [deployed version](https://agentchat.vercel.app) is the quickest way to get started, and allows you to interact with both local and deployed graphs.

## Run agent in UI

First, set up LangGraph API server [locally](./deployment.md#launch-langgraph-server-locally) or deploy your agent on [LangSmith Deployment](https://langchain-ai.github.io/langgraph/cloud/quick_start/).

Then, navigate to [Agent Chat UI](https://agentchat.vercel.app), or clone the repository and [run the dev server locally](https://github.com/langchain-ai/agent-chat-ui?tab=readme-ov-file#setup):

<video controls src="../assets/base-chat-ui.mp4" type="video/mp4"></video>

!!! Tip

    UI has out-of-box support for rendering tool calls, and tool result messages. To customize what messages are shown, see the [Hiding Messages in the Chat](https://github.com/langchain-ai/agent-chat-ui?tab=readme-ov-file#hiding-messages-in-the-chat) section in the Agent Chat UI documentation.

## Generative UI

You can also use generative UI in the Agent Chat UI.

Generative UI allows you to define [React](https://react.dev/) components, and push them to the UI from the LangGraph server. For more documentation on building generative UI LangGraph agents, read [these docs](https://langchain-ai.github.io/langgraph/cloud/how-tos/generative_ui_react/).
