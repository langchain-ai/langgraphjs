---
hide:
  - toc
---

# How-to guides

Here you’ll find answers to “How do I...?” types of questions. These guides are **goal-oriented** and concrete; they're meant to help you complete a specific task. For conceptual explanations see the [Conceptual guide](../concepts). For end-to-end walk-throughs see [Tutorials](../tutorials). For comprehensive descriptions of every class and function see the [API Reference](../reference).

## Installation

- [How to install and manage dependencies](manage-ecosystem-dependencies.ipynb)
- [How to use LangGraph.js in web environments](use-in-web-environments.ipynb)

## LangGraph

### Controllability

LangGraph.js is known for being a highly controllable agent framework.
These how-to guides show how to achieve that controllability.

- [How to define graph state](define-state.ipynb)
- [How to create subgraphs](subgraph.ipynb)
- [How to create branches for parallel execution](branching.ipynb)
- [How to create map-reduce branches for parallel execution](map-reduce.ipynb)

### Persistence

LangGraph.js makes it easy to persist state across graph runs. The guides below shows how to add persistence to your graph.

- [How to add thread-level persistence to your graph](persistence.ipynb)
- [How to add thread-level persistence to subgraphs](subgraph-persistence.ipynb)
- [How to add cross-thread persistence](cross-thread-persistence.ipynb)
- [How to use a Postgres checkpointer for persistence](persistence-postgres.ipynb)
- [How to manage conversation history](manage-conversation-history.ipynb)
- [How to view and update past graph state](time-travel.ipynb)
- [How to delete messages](delete-messages.ipynb)
- [How to add summary of the conversation history](add-summary-conversation-history.ipynb)

### Human-in-the-loop

One of LangGraph.js's main benefits is that it makes human-in-the-loop workflows easy.
These guides cover common examples of that.

- [How to add breakpoints](breakpoints.ipynb)
- [How to add dynamic breakpoints](dynamic_breakpoints.ipynb)
- [How to wait for user input](wait-user-input.ipynb)
- [How to edit graph state](edit-graph-state.ipynb)
- [How to review tool calls](review-tool-calls.ipynb)

### Streaming

LangGraph is built to be streaming first.
These guides show how to use different streaming modes.

- [How to stream full state of your graph](stream-values.ipynb)
- [How to stream state updates of your graph](stream-updates.ipynb)
- [How to configure multiple streaming modes](stream-multiple.ipynb)
- [How to stream LLM tokens](stream-tokens.ipynb)
- [How to stream LLM tokens without LangChain models](streaming-tokens-without-langchain.ipynb)
- [How to stream events from within a tool](streaming-events-from-within-tools.ipynb)
- [How to stream from the final node](streaming-from-final-node.ipynb)

### Tool calling

- [How to call tools using ToolNode](tool-calling.ipynb)
- [How to force an agent to call a tool](force-calling-a-tool-first.ipynb)
- [How to handle tool calling errors](tool-calling-errors.ipynb)
- [How to pass runtime values to tools](pass-run-time-values-to-tools.ipynb)

### Subgraphs

- [How to add and use subgraphs](subgraph.ipynb)
- [How to view and update state in subgraphs](subgraphs-manage-state.ipynb)
- [How to transform inputs and outputs of a subgraph](subgraph-transform-state.ipynb)

### State management

- [Have a separate input and output schema](input_output_schema.ipynb)
- [Pass private state between nodes inside the graph](pass_private_state.ipynb)

### Prebuilt ReAct Agent

- [How to create a ReAct agent](create-react-agent.ipynb)
- [How to add memory to a ReAct agent](react-memory.ipynb)
- [How to add a system prompt to a ReAct agent](react-system-prompt.ipynb)
- [How to add Human-in-the-loop to a ReAct agent](react-human-in-the-loop.ipynb)

### Prebuilt ReAct Agent

- [How to create a ReAct agent](create-react-agent.ipynb)
- [How to add memory to a ReAct agent](react-memory.ipynb)
- [How to add a system prompt to a ReAct agent](react-system-prompt.ipynb)
- [How to add Human-in-the-loop to a ReAct agent](react-human-in-the-loop.ipynb)

### Other

- [How to add runtime configuration to your graph](configuration.ipynb)
- [How to let agent return tool results directly](dynamically-returning-directly.ipynb)
- [How to have agent respond in structured format](respond-in-format.ipynb)
- [How to manage agent steps](managing-agent-steps.ipynb)
- [How to add node retry policies](node-retry-policies.ipynb)

## LangGraph Platform

This section includes how-to guides for LangGraph Platform.

LangGraph Platform is a commercial solution for deploying agentic applications in production, built on the open-source LangGraph framework. It provides four deployment options to fit a range of needs: a free tier, a self-hosted version, a cloud SaaS, and a Bring Your Own Cloud (BYOC) option. You can explore these options in detail in the [deployment options guide](../concepts/deployment_options.md).

!!! tip

    * LangGraph is an MIT-licensed open-source library, which we are committed to maintaining and growing for the community.
    * You can always deploy LangGraph applications on your own infrastructure using the open-source LangGraph project without using LangGraph Platform.

### Application Structure

Learn how to set up your app for deployment to LangGraph Platform:

- [How to set up app for deployment (requirements.txt)](../cloud/deployment/setup.md)
- [How to set up app for deployment (pyproject.toml)](../cloud/deployment/setup_pyproject.md)
- [How to set up app for deployment (JavaScript)](../cloud/deployment/setup_javascript.md)
- [How to customize Dockerfile](../cloud/deployment/custom_docker.md)
- [How to test locally](../cloud/deployment/test_locally.md)

### Deployment

LangGraph applications can be deployed using LangGraph Cloud, which provides a range of services to help you deploy, manage, and scale your applications.

- [How to deploy to LangGraph cloud](../cloud/deployment/cloud.md)
- [How to deploy to a self-hosted environment](./deployment/self_hosted.md)
- [How to interact with the deployment using RemoteGraph](../cloud/how-tos/remote_graph.md)

### Assistants

[Assistants](../concepts/assistants.md) is a configured instance of a template.

- [How to configure agents](../cloud/how-tos/configuration_cloud.md)
- [How to version assistants](../cloud/how-tos/assistant_versioning.md)

### Threads

- [How to copy threads](../cloud/how-tos/copy_threads.md)
- [How to check status of your threads](../cloud/how-tos/check_thread_status.md)

### Runs

LangGraph Cloud supports multiple types of runs besides streaming runs.

- [How to run an agent in the background](../cloud/how-tos/background_run.md)
- [How to run multiple agents in the same thread](../cloud/how-tos/same-thread.md)
- [How to create cron jobs](../cloud/how-tos/cron_jobs.md)
- [How to create stateless runs](../cloud/how-tos/stateless_runs.md)

### Streaming

Streaming the results of your LLM application is vital for ensuring a good user experience, especially when your graph may call multiple models and take a long time to fully complete a run. Read about how to stream values from your graph in these how to guides:

- [How to stream values](../cloud/how-tos/stream_values.md)
- [How to stream updates](../cloud/how-tos/stream_updates.md)
- [How to stream messages](../cloud/how-tos/stream_messages.md)
- [How to stream events](../cloud/how-tos/stream_events.md)
- [How to stream in debug mode](../cloud/how-tos/stream_debug.md)
- [How to stream multiple modes](../cloud/how-tos/stream_multiple.md)

### Human-in-the-loop

When creating complex graphs, leaving every decision up to the LLM can be dangerous, especially when the decisions involve invoking certain tools or accessing specific documents. To remedy this, LangGraph allows you to insert human-in-the-loop behavior to ensure your graph does not have undesired outcomes. Read more about the different ways you can add human-in-the-loop capabilities to your LangGraph Cloud projects in these how-to guides:

- [How to add a breakpoint](../cloud/how-tos/human_in_the_loop_breakpoint.md)
- [How to wait for user input](../cloud/how-tos/human_in_the_loop_user_input.md)
- [How to edit graph state](../cloud/how-tos/human_in_the_loop_edit_state.md)
- [How to replay and branch from prior states](../cloud/how-tos/human_in_the_loop_time_travel.md)
- [How to review tool calls](../cloud/how-tos/human_in_the_loop_review_tool_calls.md)

### Double-texting

Graph execution can take a while, and sometimes users may change their mind about the input they wanted to send before their original input has finished running. For example, a user might notice a typo in their original request and will edit the prompt and resend it. Deciding what to do in these cases is important for ensuring a smooth user experience and preventing your graphs from behaving in unexpected ways. The following how-to guides provide information on the various options LangGraph Cloud gives you for dealing with double-texting:

- [How to use the interrupt option](../cloud/how-tos/interrupt_concurrent.md)
- [How to use the rollback option](../cloud/how-tos/rollback_concurrent.md)
- [How to use the reject option](../cloud/how-tos/reject_concurrent.md)
- [How to use the enqueue option](../cloud/how-tos/enqueue_concurrent.md)

### Webhooks

- [How to integrate webhooks](../cloud/how-tos/webhooks.md)

### Cron Jobs

- [How to create cron jobs](../cloud/how-tos/cron_jobs.md)

### LangGraph Studio

LangGraph Studio is a built-in UI for visualizing, testing, and debugging your agents.

- [How to connect to a LangGraph Cloud deployment](../cloud/how-tos/test_deployment.md)
- [How to connect to a local deployment](../cloud/how-tos/test_local_deployment.md)
- [How to test your graph in LangGraph Studio](../cloud/how-tos/invoke_studio.md)
- [How to interact with threads in LangGraph Studio](../cloud/how-tos/threads_studio.md)

## Troubleshooting

### Errors

- [Error reference](../troubleshooting/errors/index.md)
