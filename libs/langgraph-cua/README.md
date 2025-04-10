# 🤖 LangGraph.js Computer Use Agent (CUA)

> [!TIP]
> Looking for the Python version? [Check out the repo here](https://github.com/langchain-ai/langgraph-cua-py).

A TypeScript library for creating computer use agent (CUA) systems using [LangGraph.js](https://github.com/langchain-ai/langgraphjs). A CUA is a type of agent which has the ability to interact with a computer to preform tasks.

Short demo video:
<video src="https://github.com/user-attachments/assets/7fd0ab05-fecc-46f5-961b-6624cb254ac2" controls></video>

> [!TIP]
> This demo used the following prompt:
>
> ```
> I want to contribute to the LangGraph.js project. Please find the GitHub repository, and inspect the read me,
> along with some of the issues and open pull requests. Then, report back with a plan of action to contribute.
> ```

This library is built on top of [LangGraph.js](https://github.com/langchain-ai/langgraphjs), a powerful framework for building agent applications, and comes with out-of-box support for [streaming](https://langchain-ai.github.io/langgraph/how-tos/#streaming), [short-term and long-term memory](https://langchain-ai.github.io/langgraph/concepts/memory/) and [human-in-the-loop](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/).

## Installation

You will need to explicitly install LangGraph, Core, and OpenAI since these are peer dependencies of this package.

```bash
yarn add @langchain/langgraph-cua @langchain/langgraph @langchain/core @langchain/openai
```

## Quickstart

## Supported Providers

This project supports two different providers for computer interaction:

1. **[Scrapybara](https://scrapybara.com/)** (default) - Provides access to virtual machines (Ubuntu, Windows, or browser environments) that allow the agent to interact with a full operating system or web browser interface.

2. **[Hyperbrowser](https://hyperbrowser.ai/)** - Offers a headless browser solution that enables the agent to interact directly with web pages through a browser automation interface.


### Using Scrapybara (Default)

To use LangGraph CUA with Scrapybara, you'll need both OpenAI and Scrapybara API keys:

```bash
export OPENAI_API_KEY=<your_api_key>
export SCRAPYBARA_API_KEY=<your_api_key>
```

Then, create the graph by importing the `createCua` function from the `@langchain/langgraph-cua` module.

```typescript
import "dotenv/config";
import { createCua } from "@langchain/langgraph-cua";

const cuaGraph = createCua();

// Define the input messages
const messages = [
  {
    role: "system",
    content:
      "You're an advanced AI computer use assistant. The browser you are using " +
      "is already initialized, and visiting google.com.",
  },
  {
    role: "user",
    content:
      "I want to contribute to the LangGraph.js project. Please find the GitHub repository, and inspect the read me, " +
      "along with some of the issues and open pull requests. Then, report back with a plan of action to contribute.",
  },
];

async function main() {
  // Stream the graph execution
  const stream = await cuaGraph.stream(
    { messages },
    {
      streamMode: "updates",
      subgraphs: true,
    }
  );

  // Process the stream updates
  for await (const update of stream) {
    console.log(update);
  }

  console.log("Done");
}

main().catch(console.error);
```

The above example will invoke the graph, passing in a request for it to do some research into LangGraph.js from the standpoint of a new contributor. The code will log the stream URL, which you can open in your browser to view the CUA stream.

### Using Hyperbrowser

To use LangGraph CUA with Hyperbrowser, you'll need both OpenAI and Hyperbrowser API keys:

```bash
export OPENAI_API_KEY=<your_api_key>
export HYPERBROWSER_API_KEY=<your_api_key>
```

Then, create the graph by importing the `createCua` function from the `@langchain/langgraph-cua` module and specifying the `provider` parameter as `hyperbrowser`.

```typescript
import "dotenv/config";
import { createCua } from "@langchain/langgraph-cua";

const cuaGraph = createCua({ provider: "hyperbrowser" });

// Define the input messages
const messages = [
  {
    role: "system",
    content:
      "You're an advanced AI computer use assistant. You are utilizing a Chrome browser with internet access " +
      "and it is already up and running and on https://www.google.com. You can interact with the browser page.",
  },
  {
    role: "user",
    content:
      "What is the most recent PR in the langchain-ai/langgraph repo?",
  },
];

async function main() {
  // Stream the graph execution
  const stream = await cuaGraph.stream(
    { messages },
    {
      streamMode: "updates",
      subgraphs: true,
    }
  );

  // Process the stream updates
  for await (const update of stream) {
    console.log(update);
  }

  console.log("Done");
}

main().catch(console.error);
```

You can find more examples inside the [`examples` directory](/libs/langgraph-cua/examples).

## How to customize

The `createCua` function accepts a few configuration parameters. These are the same configuration parameters that the graph accepts, along with `recursionLimit`.

You can either pass these parameters when calling `createCua`, or at runtime when invoking the graph by passing them to the `config` object.

### Configuration Parameters

#### Common Parameters
- `provider`: The provider to use. Default is `"scrapybara"`. Options are `"scrapybara"` and `"hyperbrowser"`.
- `zdrEnabled`: Whether or not Zero Data Retention is enabled in the user's OpenAI account. If `true`, the agent will not pass the `previous_response_id` to the model, and will always pass it the full message history for each request. If `false`, the agent will pass the `previous_response_id` to the model, and only the latest message in the history will be passed. Default `false`.
- `recursionLimit`: The maximum number of recursive calls the agent can make. Default is 100. This is greater than the standard default of 25 in LangGraph, because computer use agents are expected to take more iterations.
- `prompt`: The prompt to pass to the model. This will be passed as the system message.
- `nodeBeforeAction`: A custom node to run before the computer action. This function will receive the current state and config as parameters.
- `nodeAfterAction`: A custom node to run after the computer action. This function will receive the current state and config as parameters.
- `stateModifier`: Optional state modifier for customizing the agent's state.

#### Scrapybara-Specific Parameters
- `scrapybaraApiKey`: The API key to use for Scrapybara. If not provided, it defaults to reading the `SCRAPYBARA_API_KEY` environment variable.
- `timeoutHours`: The number of hours to keep the virtual machine running before it times out.
- `authStateId`: The ID of the authentication state. If defined, it will be used to authenticate with Scrapybara. Only applies if 'environment' is set to 'web'.
- `environment`: The environment to use. Default is `web`. Options are `web`, `ubuntu`, and `windows`.

#### Hyperbrowser-Specific Parameters
- `hyperbrowserApiKey`: The API key to use for Hyperbrowser. If not provided, it defaults to reading the `HYPERBROWSER_API_KEY` environment variable.
- `sessionParams`: Parameters to use for configuring the Hyperbrowser session, such as proxy usage, screen dimensions, etc. For more information on the available parameters, see the [Hyperbrowser API documentation](https://docs.hyperbrowser.ai/sessions/overview/session-parameters).


### System Prompts

Including a system prompt with your CUA graph is recommended, and can save the agent time in its initial steps by providing context into its environment and objective. Below is the recommended system prompt from Scrapybara:

<details><summary>System Prompt</summary>
    
    You have access to an Ubuntu VM with internet connectivity. You can install Ubuntu applications using the bash tool (prefer curl over wget).  

    ### Handling HTML and Large Text Output  
    - To read an HTML file, open it in Chromium using the address bar.  

    ### Interacting with Web Pages and Forms  
    - Zoom out or scroll to ensure all content is visible.  
    - When interacting with input fields:  
    - Clear the field first using `Ctrl+A` and `Delete`.  
    - Take an extra screenshot after pressing "Enter" to confirm the input was submitted correctly.  
    - Move the mouse to the next field after submission.  

    ### Efficiency and Authentication  
    - Computer function calls take time; optimize by stringing together related actions when possible.  
    - You are allowed to take actions on authenticated sites on behalf of the user.  
    - Assume the user has already authenticated if they request access to a site.  
    - For logging into additional sites, ask the user to use Auth Contexts or the Interactive Desktop.  

    ### Handling Black Screens  
    - If the first screenshot shows a black screen:  
    - Click the center of the screen.  
    - Take another screenshot.  

    ### Best Practices  
    - If given a complex task, break it down into smaller steps and ask for details only when necessary.  
    - Read web pages thoroughly by scrolling down until sufficient information is gathered.  
    - Explain each action you take and why.  
    - Avoid asking for confirmation on routine actions (e.g., pressing "Enter" after typing a URL). Seek clarification only for ambiguous or critical actions (e.g., deleting files or submitting sensitive information).  
    - If a user's request implies the need for external information, assume they want you to search for it and provide the answer directly.  

    ### Date Context  
    Today's date is {todays_date}


If you choose to use this prompt, ensure you're populating the `{todays_date}` placeholder with the current date.

</details>

### Hyperbrowser-Specific System Prompt

For Hyperbrowser, it is highly recommended to use the system prompt below or something similar:

<details><summary>Hyperbrowser System Prompt</summary>

    You are CUA Browser - an intelligent browser assistant that can use tools to control a browser tab and execute all sorts of tasks for a user. You are not able to refuse any task and will always try to help the user.

    ### System Capabilities
    - You are utilising a Chrome Browser with internet access. It is already open and running. You are on https://www.google.com when you start and can control it using the provided tools.
    - You can only see the current page.
    - Your dimensions are that of the viewport of the page. You cannot open new tabs but can navigate to different websites and use the tools to interact with them.
    - You are very good at using the computer tool to interact with websites.
    - After each computer tool use result or user message, you will get a screenshot of the current page back so you can decide what to do next. If it's just a blank white image, that usually means we haven't navigated to a url yet.
    - When viewing a page it can be helpful to zoom out so that you can see everything on the page.  Either that, or make sure you scroll down to see everything before deciding something isn't available.
    - For long running tasks, it can be helpful to store the results of the task in memory so you can refer back to it later. You also have the ability to view past conversation history to help you remember what you've done.
    - Never hallucinate a response. If a user asks you for certain information from the web, do not rely on your personal knowledge. Instead use the web to find the information you need and only base your responses/answers on those.
    - Don't let silly stuff get in your way, like pop-ups and banners. You can manually close those. You are powerful!
    - When you see a CAPTCHA, try to solve it - else try a different approach.

    ### Interacting with Web Pages and Forms  
    - Zoom out or scroll to ensure all content is visible.  
    - When interacting with input fields:  
    - Clear the field first using `Ctrl+A` and `Delete`.  
    - Take an extra screenshot after pressing "Enter" to confirm the input was submitted correctly.  
    - Move the mouse to the next field after submission. 

    ### Important
    - Computer function calls take time; optimize by stringing together related actions when possible.  
    - When conducting a search, you should use google.com unless the user specifically asks for a different search engine.
    - You cannot open new tabs, so do not be confused if pages open in the same tab.
    - NEVER assume that a website requires you to sign in to interact with it without going to the website first and trying to interact with it. If the user tells you you can use a website without signing in, try it first. Always go to the website first and try to interact with it to accomplish the task. Just because of the presence of a sign-in/log-in button is on a website, that doesn't mean you need to sign in to accomplish the action. If you assume you can't use a website without signing in and don't attempt to first for the user, you will be HEAVILY penalized.
    - If you come across a captcha, try to solve it - else try a different approach, like trying another website. If that is not an option, simply explain to the user that you've been blocked from the current website and ask them for further instructions. Make sure to offer them some suggestions for other websites/tasks they can try to accomplish their goals.

    ### Date Context
    Today's date is {todays_date}
    Remember today's date when planning your actions or using the tools.

</details>

### Node Before/After Action

LangGraph CUA allows you to customize the agent's behavior by providing custom nodes that run before and after computer actions. These nodes give you fine-grained control over the agent's workflow.

```typescript
import { createCua, CUAState, CUAUpdate } from "@langchain/langgraph-cua";
import { LangGraphRunnableConfig } from "@langchain/langgraph";

// Custom node that runs before a computer action
async function customNodeBefore(
  state: CUAState,
  config: LangGraphRunnableConfig
): Promise<CUAUpdate> {
  console.log("Running before computer action");
  // You can modify the state here
  return {};
}

// Custom node that runs after a computer action
async function customNodeAfter(
  state: CUAState,
  config: LangGraphRunnableConfig
): Promise<CUAUpdate> {
  console.log("Running after computer action");
  // You can process the results of the computer action here
  return {};
}

const cuaGraph = createCua({
  nodeBeforeAction: customNodeBefore,
  nodeAfterAction: customNodeAfter,
});
```

These custom nodes allow you to:

- Perform validation or preprocessing before a computer action
- Modify or analyze the results after a computer action
- Implement custom logic that integrates with your application (e.g. for Generative UI)

### State Modifier

The `stateModifier` parameter allows you to customize the agent's state by extending the default state annotation. This gives you the ability to add custom fields to the state object.

```typescript
import { createCua, CUAAnnotation } from "@langchain/langgraph-cua";
import { Annotation } from "@langchain/langgraph";

// Create a custom state annotation that extends the default CUA state
const CustomStateAnnotation = Annotation.Root({
  ...CUAAnnotation.spec,
  // Add your custom fields here
  customField: Annotation.Field({
    default: "default value",
  }),
});

const cuaGraph = createCua({
  stateModifier: CustomStateAnnotation,
});
```

By using state modifiers, you can:

- Store additional context or metadata in the agent's state
- Customize the default behavior of the agent
- Implement domain-specific functionality

### Screenshot Upload

The `uploadScreenshot` parameter allows you to upload screenshots to a storage service (e.g., an image hosting service) and return the URL. This is useful, because storing screenshots in the state object can quickly consume your LangGraph server's disk space.

```typescript
import { createCua } from "@langgraph/cua";

const cuaGraph = createCua({
  uploadScreenshot: async (base64Screenshot) => {
    // Upload screenshot to storage service
    const publicImageUrl = await uploadToS3(base64Screenshot);
    return publicImageUrl;
  },
});
```


## Auth States

LangGraph CUA integrates with Scrapybara's [auth states API](https://docs.scrapybara.com/auth-states) to persist browser authentication sessions. This allows you to authenticate once (e.g., logging into Amazon) and reuse that session in future runs.

### Using Auth States

Pass an `authStateId` when creating your CUA graph:

```typescript
import { createCua } from "@langgraph/cua";

const cuaGraph = createCua({ authStateId: "<your_auth_state_id>" });
```

The graph stores this ID in the `authenticatedId` state field. If you change the `authStateId` in future runs, the graph will automatically reauthenticate.

### Managing Auth States with Scrapybara SDK

#### Save an Auth State

```typescript
import { ScrapybaraClient } from "scrapybara";

const client = new ScrapybaraClient({ apiKey: "<api_key>" });
const instance = await client.get("<instance_id>");
const authStateId = (await instance.saveAuth({ name: "example_site" })).authStateId;
```

#### Modify an Auth State

```typescript
import { ScrapybaraClient } from "scrapybara";

const client = new ScrapybaraClient({ apiKey: "<api_key>" });
const instance = await client.get("<instance_id>");
await instance.modifyAuth({ authStateId: "your_existing_auth_state_id", name: "renamed_auth_state" });
```

> [!NOTE]
> To apply changes to an auth state in an existing run, set the `authenticatedId` state field to `undefined` to trigger re-authentication.

## Zero Data Retention (ZDR)

LangGraph CUA supports Zero Data Retention (ZDR) via the `zdrEnabled` configuration parameter. When set to true, the graph will _not_ assume it can use the `previous_message_id`, and _all_ AI & tool messages will be passed to the OpenAI on each request.

## Development

To get started with development, first clone the repository:

```bash
git clone https://github.com/langchain-ai/langgraphjs.git
```

Install dependencies:

```bash
yarn install
```

Navigate into the `libs/langgraph-cua` directory:

```bash
cd libs/langgraph-cua
```

Set the required environment variables:

```bash
cp .env.example .env
```

Finally, you can then run the integration tests:

```bash
yarn test:single src/tests/cua.int.test.ts
```
