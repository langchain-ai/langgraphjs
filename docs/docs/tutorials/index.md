---
title: Tutorials
---

# Tutorials

Welcome to the LangGraph.js Tutorials! These notebooks introduce LangGraph through building various language agents and applications.

> 🧠 **Looking for a structured learning experience?** Check out our [Learning Path](/langgraphjs/learning-path/) that guides you from beginner to expert through carefully sequenced content.

> 🔄 **API Style Options**: LangGraph.js offers two ways to build applications: the original **StateGraph API** with explicit nodes and edges, and the more concise **Functional API**. Most tutorials use the StateGraph API, but you can learn about both approaches in our [concepts documentation](/langgraphjs/concepts/functional_api.md#comparison-with-stategraph). Best of all, you can mix both approaches in a single project - each style can call graphs built with the other!

## Quick Start

Learn the basics of LangGraph through a comprehensive quick start in which you will build an agent from scratch.

- [Quick Start](quickstart.ipynb)
- [Common Workflows](workflows/index.md): Overview of the most common workflows using LLMs implemented with LangGraph.
- [LangGraph Cloud Quick Start](/langgraphjs/cloud/quick_start/): In this tutorial, you will build and deploy an agent to LangGraph Cloud.

## Use cases

Learn from example implementations of graphs designed for specific scenarios and that implement common design patterns.

#### Chatbots

- [Customer support with a small model](chatbots/customer_support_small_model.ipynb)

#### RAG

- [Agentic RAG](rag/langgraph_agentic_rag.ipynb)
- [Corrective RAG](rag/langgraph_crag.ipynb)
- [Self-RAG](rag/langgraph_self_rag.ipynb)

#### Multi-Agent Systems

- [Collaboration](multi_agent/multi_agent_collaboration.ipynb): Enabling two agents to collaborate on a task
- [Supervision](multi_agent/agent_supervisor.ipynb): Using an LLM to orchestrate and delegate to individual agents
- [Hierarchical Teams](multi_agent/hierarchical_agent_teams.ipynb): Orchestrating nested teams of agents to solve problems

#### Planning Agents

- [Plan-and-Execute](plan-and-execute/plan-and-execute.ipynb): Implementing a basic planning and execution agent

#### Reflection & Critique

- [Basic Reflection](reflection/reflection.ipynb): Prompting the agent to reflect on and revise its outputs
- [Rewoo](rewoo/rewoo.ipynb): Reducing re-planning by saving observations as variables

### Evaluation

- [Agent-based](chatbot-simulation-evaluation/agent-simulation-evaluation.ipynb): Evaluate chatbots via simulated user interactions
