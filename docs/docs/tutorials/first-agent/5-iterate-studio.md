# Part 5: Iterate in LangGraph Studio (beta)

In the previous tutorials, we built a chatbot that can answer user questions using a Large Language Model (LLM) and tools. We added memory to the chatbot to enable multi-turn conversations. Now, we will use LangGraph Studio, a specialized agent IDE that enables visualization, interaction, and debugging of complex agentic applications.

> **Note:** LangGraph Studio is currently in beta and only available for MacOS. If you encounter any issues or have feedback, please let us know!

## Step 1: Setup LangGraph Studio (beta)

Before you can open your agent in LangGraph Studio, you'll have to complete a few setup steps:

1. [Sign up for a free LangSmith account](https://smith.langchain.com/).
2. Download the latest release of LangGraph Studio [from here](https://github.com/langchain-ai/langgraph-studio/releases) and install it on your machine.
3. Open the LangGraph Studio app and log in with your LangSmith account.

The LangGraph Studio beta currently only supports Node.js version 20. You can check your current node version using the command `node -v`. If you have a newer version of node installed, or need a different version for any reason, we recommend using [nvm](https://github.com/nvm-sh/nvm?tab=readme-ov-file) to install multiple node versions side-by-side. When using LangGraph Studio, you will need to use nvm to set the default node version to v20. You can use the following commands to install Node v20 and set is as default using nvm:

```bash
nvm install 20
nvm alias default 20
```

You will need to have Docker Desktop running on your machine for LangGraph Studio to be able to run your agent. If you don't have Docker installed on your machine, you can [download Docker from the official website](https://www.docker.com/products/docker-desktop/). Studio will automatically use Docker to pull the container image used to run your agent.

Additionally, you'll need to tell LangGraph Studio where your agent is located. To do this, you'll need to create a `langgraph.json` file in the root of your project. This file should contain the following information:

```json
{
  "node_version": "20",
  "dockerfile_lines": [],
  "dependencies": ["."],
  "graphs": {
    "agent": "./chatbot.ts:app"
  },
  "env": ".env"
}
```
