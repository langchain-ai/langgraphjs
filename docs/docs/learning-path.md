# Learning Path for LangGraph.js

This learning path provides a structured way to learn LangGraph.js, from beginner to advanced topics. Follow this path to gain mastery of building stateful, multi-actor applications with LLMs.

## 🔰 Beginner: Getting Started

Start here if you're new to LangGraph.js:

1. [Introduction to LangGraph.js](index.md) - Understand what LangGraph.js is and its core concepts
2. [Quickstart Tutorial](tutorials/quickstart.ipynb) - Build your first graph in minutes
3. [Core Concepts](concepts/high_level.md) - Learn about graphs, nodes, edges, and state

### Choose Your API Style

LangGraph.js offers two different API styles for building graphs. Understanding the differences will help you choose the right approach for your project:

- [StateGraph vs Functional API](concepts/functional_api.md#comparison-with-stategraph) - Learn the key differences between the two approaches
  - **StateGraph API** - Object-oriented approach with explicit graph construction
  - **Functional API** - Cleaner, more concise approach using JavaScript functions

> **Which should you choose?** If you prefer a more explicit, visual representation of your graph with clearly defined nodes and edges, use StateGraph. If you prefer a more concise, functional programming style with less boilerplate, choose the Functional API. 
>
> **Good news**: You can mix both approaches! Graphs built with StateGraph can call Functional API graphs, and vice versa. This flexibility allows you to use whichever approach works best for each particular component of your application.

## 🌱 Intermediate: Building Foundations

Once you understand the basics, start exploring these foundational topics:

### StateGraph API Path

1. **State Management**
   - [Define State](how-tos/define-state.ipynb) - Learn how to define and structure your graph state
   - [Input/Output Schema](how-tos/input_output_schema.ipynb) - Define schemas for your graph inputs and outputs

2. **Tool Integration**
   - [Tool Calling](how-tos/tool-calling.ipynb) - Integrate tools with your agents
   - [Handle Tool Errors](how-tos/tool-calling-errors.ipynb) - Learn to handle errors from tools gracefully

3. **Memory & Persistence**
   - [Persistence](how-tos/persistence.ipynb) - Add memory to your graphs
   - [Managing Conversation History](how-tos/manage-conversation-history.ipynb) - Maintain and work with chat history

4. **Streaming**
   - [Stream Values](how-tos/stream-values.ipynb) - Learn how to stream results from your graphs
   - [Stream Updates](how-tos/stream-updates.ipynb) - Stream state updates

### Functional API Path

1. **Core Functional Patterns**
   - [Functional API Concepts](concepts/functional_api.md) - Understand the functional API approach
   - [Persistence (Functional API)](how-tos/persistence-functional.ipynb) - Add memory to graphs using the functional API
   
2. **Advanced Functional Patterns**
   - [Wait for User Input (Functional API)](how-tos/wait-user-input-functional.ipynb) - Incorporate user input into flows
   - [Multi-Agent Networks (Functional API)](how-tos/multi-agent-network-functional.ipynb) - Create networks of specialized agents
   - [ReAct Agent (Functional API)](how-tos/react-agent-from-scratch-functional.ipynb) - Build ReAct agents using the functional API

## 🚀 Advanced: Building Powerful Workflows

Ready to build more complex applications? Explore these advanced topics:

1. **Human-in-the-Loop**
   - [Breakpoints](how-tos/breakpoints.ipynb) - Pause execution for human input
   - [Dynamic Breakpoints](how-tos/dynamic_breakpoints.ipynb) - Create conditional breakpoints
   - [Wait for User Input](how-tos/wait-user-input.ipynb) - Incorporate user input into your flows

2. **Multi-Agent Systems**
   - [Multi-Agent Networks](how-tos/multi-agent-network.ipynb) - Create networks of specialized agents
   - [Multi-Turn Conversations](how-tos/multi-agent-multi-turn-convo.ipynb) - Build multi-turn conversations between agents

3. **Graph Composition**
   - [Subgraphs](how-tos/subgraph.ipynb) - Compose graphs from other graphs
   - [Branching](how-tos/branching.ipynb) - Create complex, branching workflows

## 🏆 Expert: Production & Deployment

For production-ready applications:

1. **Deployment**
   - [Deployment Options](concepts/deployment_options.md) - Understand different ways to deploy
   - [Self-Hosting](how-tos/deploy-self-hosted.md) - Learn to self-host your graphs
   - [Use Remote Graphs](how-tos/use-remote-graph.md) - Connect to remotely deployed graphs

2. **LangGraph Platform**
   - [LangGraph Platform Overview](concepts/langgraph_platform.md) - Understand the platform offerings
   - [Application Structure](concepts/application_structure.md) - Best practices for structuring apps
   - [Platform Deployment](cloud/deployment/cloud.md) - Deploy to LangGraph Cloud

3. **Advanced Patterns**
   - [State Management](how-tos/edit-graph-state.ipynb) - Advanced state management techniques
   - [Time Travel](how-tos/time-travel.ipynb) - Implement time travel debugging

## 🔧 Special Topics

Explore specific use cases:

1. **Building ReAct Agents**
   - [Create ReAct Agent](how-tos/create-react-agent.ipynb) - Build ReAct-style agents
   - [ReAct Memory](how-tos/react-memory.ipynb) - Add memory to ReAct agents
   - [ReAct System Prompts](how-tos/react-system-prompt.ipynb) - Customize ReAct agent behavior

2. **Web App Integration**
   - [Use in Web Environments](how-tos/use-in-web-environments.ipynb) - Integrate with web applications

3. **Performance Optimization**
   - [Configuration](how-tos/configuration.ipynb) - Configure for performance
   - [Node Retry Policies](how-tos/node-retry-policies.ipynb) - Implement retries for reliability

## 📚 Additional Resources

- [API Reference](reference/) - Complete API documentation
- [Concepts Index](concepts/) - Deep dives into key concepts
- [How-to Index](how-tos/) - Task-oriented guides for specific needs 