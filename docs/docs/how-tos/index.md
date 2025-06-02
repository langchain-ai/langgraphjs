---
title: How-to Guides
description: How to accomplish common tasks in LangGraph.js
---

# How-to guides

Here you’ll find answers to “How do I...?” types of questions. These guides are **goal-oriented** and concrete; they're meant to help you complete a specific task. For conceptual explanations see the [Conceptual guide](../concepts/index.md). For end-to-end walk-throughs see [Tutorials](../tutorials/index.md). For comprehensive descriptions of every class and function see the [API Reference](https://langchain-ai.github.io/langgraphjs/reference/).

## Installation

- [How to install and manage dependencies](manage-ecosystem-dependencies.ipynb)
- [How to use LangGraph.js in web environments](use-in-web-environments.ipynb)

## LangGraph

### Controllability

LangGraph.js is known for being a highly controllable agent framework.
These how-to guides show how to achieve that controllability.

- [How to create branches for parallel execution](branching.ipynb)
- [How to create map-reduce branches for parallel execution](map-reduce.ipynb)
- [How to defer node execution](defer-node-execution.ipynb)
- [How to combine control flow and state updates with Command](command.ipynb)
- [How to create and control loops with recursion limits](recursion-limit.ipynb)

### Persistence

LangGraph.js makes it easy to persist state across graph runs. The guides below shows how to add persistence to your graph.

- [How to add thread-level persistence to your graph](persistence.ipynb)
- [How to add thread-level persistence to subgraphs](subgraph-persistence.ipynb)
- [How to add cross-thread persistence](cross-thread-persistence.ipynb)
- [How to use a Postgres checkpointer for persistence](persistence-postgres.ipynb)

See the below guides for how-to add persistence to your workflow using the [Functional API](../concepts/functional_api.md):

- [How to add thread-level persistence (functional API)](persistence-functional.ipynb)
- [How to add cross-thread persistence (functional API)](cross-thread-persistence-functional.ipynb)

### Memory

LangGraph makes it easy to manage conversation [memory](../concepts/memory.md) in your graph. These how-to guides show how to implement different strategies for that.

- [How to manage conversation history](manage-conversation-history.ipynb)
- [How to delete messages](delete-messages.ipynb)
- [How to add summary of the conversation history](add-summary-conversation-history.ipynb)
- [How to add long-term memory (cross-thread)](cross-thread-persistence.ipynb)
- [How to use semantic search for long-term memory](semantic-search.ipynb)

### Human-in-the-loop

[Human-in-the-loop](/langgraphjs/concepts/human_in_the_loop) functionality allows
you to involve humans in the decision-making process of your graph. These how-to guides show how to implement human-in-the-loop workflows in your graph.

Key workflows:

- [How to wait for user input](wait-user-input.ipynb): A basic example that shows how to implement a human-in-the-loop workflow in your graph using the `interrupt` function.
- [How to review tool calls](review-tool-calls.ipynb): Incorporate human-in-the-loop for reviewing/editing/accepting tool call requests before they executed using the `interrupt` function.

Other methods:

- [How to add static breakpoints](breakpoints.ipynb): Use for debugging purposes. For [**human-in-the-loop**](/langgraphjs/concepts/human_in_the_loop) workflows, we recommend the [`interrupt` function](/langgraphjs/reference/functions/langgraph.interrupt-1.html) instead.
- [How to edit graph state](edit-graph-state.ipynb): Edit graph state using `graph.update_state` method. Use this if implementing a **human-in-the-loop** workflow via **static breakpoints**.
- [How to add dynamic breakpoints with `NodeInterrupt`](dynamic_breakpoints.ipynb): **Not recommended**: Use the [`interrupt` function](/langgraphjs/concepts/human_in_the_loop) instead.

See the below guides for how-to implement human-in-the-loop workflows with the [Functional API](../concepts/functional_api.md):

- [How to wait for user input (Functional API)](wait-user-input-functional.ipynb)
- [How to review tool calls (Functional API)](review-tool-calls-functional.ipynb)

### Time Travel

[Time travel](../concepts/time-travel.md) allows you to replay past actions in your LangGraph application to explore alternative paths and debug issues. These how-to guides show how to use time travel in your graph.

- [How to view and update past graph state](time-travel.ipynb)

### Streaming

LangGraph is built to be streaming first.
These guides show how to use different streaming modes.

- [How to stream the full state of your graph](stream-values.ipynb)
- [How to stream state updates of your graph](stream-updates.ipynb)
- [How to stream LLM tokens](stream-tokens.ipynb)
- [How to stream LLM tokens without LangChain models](streaming-tokens-without-langchain.ipynb)
- [How to stream custom data](streaming-content.ipynb)
- [How to configure multiple streaming modes](stream-multiple.ipynb)
- [How to stream events from within a tool](streaming-events-from-within-tools.ipynb)
- [How to stream from the final node](streaming-from-final-node.ipynb)

### Tool calling

- [How to call tools using ToolNode](tool-calling.ipynb)
- [How to force an agent to call a tool](force-calling-a-tool-first.ipynb)
- [How to handle tool calling errors](tool-calling-errors.ipynb)
- [How to pass runtime values to tools](pass-run-time-values-to-tools.ipynb)
- [How to update graph state from tools](update-state-from-tools.ipynb)

### Subgraphs

[Subgraphs](../concepts/low_level.md#subgraphs) allow you to reuse an existing graph from another graph. These how-to guides show how to use subgraphs:

- [How to add and use subgraphs](subgraph.ipynb)
- [How to view and update state in subgraphs](subgraphs-manage-state.ipynb)
- [How to transform inputs and outputs of a subgraph](subgraph-transform-state.ipynb)

### Multi-agent

- [How to build a multi-agent network](multi-agent-network.ipynb)
- [How to add multi-turn conversation in a multi-agent application](multi-agent-multi-turn-convo.ipynb)

See the [multi-agent tutorials](../tutorials/index.md#multi-agent-systems) for implementations of other multi-agent architectures.

See the below guides for how-to implement multi-agent workflows with the [Functional API](../concepts/functional_api.md):

- [How to build a multi-agent network (functional API)](multi-agent-network-functional.ipynb)
- [How to add multi-turn conversation in a multi-agent application (functional API)](multi-agent-multi-turn-convo-functional.ipynb)

### State management

- [How to define graph state](define-state.ipynb)
- [Have a separate input and output schema](input_output_schema.ipynb)
- [Pass private state between nodes inside the graph](pass_private_state.ipynb)

### Other

- [How to add runtime configuration to your graph](configuration.ipynb)
- [How to add node retries](node-retry-policies.ipynb)
- [How to cache expensive nodes](node-caching.ipynb)
- [How to let an agent return tool results directly](dynamically-returning-directly.ipynb)
- [How to have an agent respond in structured format](respond-in-format.ipynb)
- [How to manage agent steps](managing-agent-steps.ipynb)

### Prebuilt ReAct Agent

- [How to create a ReAct agent](create-react-agent.ipynb)
- [How to add memory to a ReAct agent](react-memory.ipynb)
- [How to add a system prompt to a ReAct agent](react-system-prompt.ipynb)
- [How to add Human-in-the-loop to a ReAct agent](react-human-in-the-loop.ipynb)
- [How to return structured output from a ReAct agent](react-return-structured-output.ipynb)

See the below guide for how-to build ReAct agents with the [Functional API](../concepts/functional_api.md):

- [How to create a ReAct agent from scratch (Functional API)](react-agent-from-scratch-functional.ipynb)

## LangGraph Platform

This section includes how-to guides for LangGraph Platform.

LangGraph Platform is a commercial solution for deploying agentic applications in production, built on the open-source LangGraph framework. It provides four deployment options to fit a range of needs: a free tier, a self-hosted version, a cloud SaaS, and a Bring Your Own Cloud (BYOC) option. You can explore these options in detail in the [deployment options guide](../concepts/deployment_options.md).

!!! tip

    * LangGraph is an MIT-licensed open-source library, which we are committed to maintaining and growing for the community.
    * You can always deploy LangGraph applications on your own infrastructure using the open-source LangGraph project without using LangGraph Platform.

### Application Structure

Learn how to set up your app for deployment to LangGraph Platform:

- [How to set up app for deployment (requirements.txt)](/langgraphjs/cloud/deployment/setup)
- [How to set up app for deployment (pyproject.toml)](/langgraphjs/cloud/deployment/setup_pyproject)
- [How to set up app for deployment (JavaScript)](/langgraphjs/cloud/deployment/setup_javascript)
- [How to customize Dockerfile](/langgraphjs/cloud/deployment/custom_docker)
- [How to test locally](/langgraphjs/cloud/deployment/test_locally)
- [How to integrate LangGraph into your React application](/langgraphjs/cloud/how-tos/use_stream_react)

### Deployment

LangGraph applications can be deployed using LangGraph Cloud, which provides a range of services to help you deploy, manage, and scale your applications.

- [How to deploy to LangGraph cloud](/langgraphjs/cloud/deployment/cloud)
- [How to deploy to a self-hosted environment](./deploy-self-hosted.md)
- [How to interact with the deployment using RemoteGraph](./use-remote-graph.md)

### Authentication & Access Control

- [How to add custom authentication](./auth/custom_auth.md)

### Modifying the API

- [How to add custom routes](./http/custom_routes.md)
- [How to add custom middleware](./http/custom_middleware.md)

### Assistants

[Assistants](../concepts/assistants.md) are a configured instance of a template.

- [How to configure agents](/langgraphjs/cloud/how-tos/configuration_cloud)
- [How to version assistants](/langgraphjs/cloud/how-tos/assistant_versioning)

### Threads

- [How to copy threads](/langgraphjs/cloud/how-tos/copy_threads)
- [How to check status of your threads](/langgraphjs/cloud/how-tos/check_thread_status)

### Runs

LangGraph Cloud supports multiple types of runs besides streaming runs.

- [How to run an agent in the background](/langgraphjs/cloud/how-tos/background_run)
- [How to run multiple agents in the same thread](/langgraphjs/cloud/how-tos/same-thread)
- [How to create cron jobs](/langgraphjs/cloud/how-tos/cron_jobs)
- [How to create stateless runs](/langgraphjs/cloud/how-tos/stateless_runs)

### Streaming

Streaming the results of your LLM application is vital for ensuring a good user experience, especially when your graph may call multiple models and take a long time to fully complete a run. Read about how to stream values from your graph in these how to guides:

- [How to stream values](/langgraphjs/cloud/how-tos/stream_values)
- [How to stream updates](/langgraphjs/cloud/how-tos/stream_updates)
- [How to stream messages](/langgraphjs/cloud/how-tos/stream_messages)
- [How to stream events](/langgraphjs/cloud/how-tos/stream_events)
- [How to stream in debug mode](/langgraphjs/cloud/how-tos/stream_debug)
- [How to stream multiple modes](/langgraphjs/cloud/how-tos/stream_multiple)

### Frontend & Generative UI

With LangGraph Platform you can integrate LangGraph agents into your React applications and colocate UI components with your agent code.

- [How to integrate LangGraph into your React application](/langgraphjs/cloud/how-tos/use_stream_react)
- [How to implement Generative User Interfaces with LangGraph](/langgraphjs/cloud/how-tos/generative_ui_react)

### Human-in-the-loop

When creating complex graphs, leaving every decision up to the LLM can be dangerous, especially when the decisions involve invoking certain tools or accessing specific documents. To remedy this, LangGraph allows you to insert human-in-the-loop behavior to ensure your graph does not have undesired outcomes. Read more about the different ways you can add human-in-the-loop capabilities to your LangGraph Cloud projects in these how-to guides:

- [How to add a breakpoint](/langgraphjs/cloud/how-tos/human_in_the_loop_breakpoint)
- [How to wait for user input](/langgraphjs/cloud/how-tos/human_in_the_loop_user_input)
- [How to edit graph state](/langgraphjs/cloud/how-tos/human_in_the_loop_edit_state)
- [How to replay and branch from prior states](/langgraphjs/cloud/how-tos/human_in_the_loop_time_travel)
- [How to review tool calls](/langgraphjs/cloud/how-tos/human_in_the_loop_review_tool_calls)

### Double-texting

Graph execution can take a while, and sometimes users may change their mind about the input they wanted to send before their original input has finished running. For example, a user might notice a typo in their original request and will edit the prompt and resend it. Deciding what to do in these cases is important for ensuring a smooth user experience and preventing your graphs from behaving in unexpected ways. The following how-to guides provide information on the various options LangGraph Cloud gives you for dealing with double-texting:

- [How to use the interrupt option](/langgraphjs/cloud/how-tos/interrupt_concurrent)
- [How to use the rollback option](/langgraphjs/cloud/how-tos/rollback_concurrent)
- [How to use the reject option](/langgraphjs/cloud/how-tos/reject_concurrent)
- [How to use the enqueue option](/langgraphjs/cloud/how-tos/enqueue_concurrent)

### Webhooks

- [How to integrate webhooks](/langgraphjs/cloud/how-tos/webhooks)

### Cron Jobs

- [How to create cron jobs](/langgraphjs/cloud/how-tos/cron_jobs)

### LangGraph Studio

LangGraph Studio is a built-in UI for visualizing, testing, and debugging your agents.

- [How to connect to a LangGraph Cloud deployment](/langgraphjs/cloud/how-tos/test_deployment)
- [How to connect to a local deployment](/langgraphjs/cloud/how-tos/test_local_deployment)
- [How to test your graph in LangGraph Studio](/langgraphjs/cloud/how-tos/invoke_studio)
- [How to interact with threads in LangGraph Studio](/langgraphjs/cloud/how-tos/threads_studio)

## Troubleshooting

These are the guides for resolving common errors you may find while building with LangGraph. Errors referenced below will have an `lc_error_code` property corresponding to one of the below codes when they are thrown in code.

- [GRAPH_RECURSION_LIMIT](../troubleshooting/errors/GRAPH_RECURSION_LIMIT.ipynb)
- [INVALID_CONCURRENT_GRAPH_UPDATE](../troubleshooting/errors/INVALID_CONCURRENT_GRAPH_UPDATE.ipynb)
- [INVALID_GRAPH_NODE_RETURN_VALUE](../troubleshooting/errors/INVALID_GRAPH_NODE_RETURN_VALUE.ipynb)
- [MULTIPLE_SUBGRAPHS](../troubleshooting/errors/MULTIPLE_SUBGRAPHS.ipynb)
- [UNREACHABLE_NODE](../troubleshooting/errors/UNREACHABLE_NODE.ipynb)
