# LangGraph for Agentic Applications

## What does it mean to be agentic?

Other people may talk about a system being an "agent" - we prefer to talk about systems being "agentic". But what does this actually mean?

When we talk about systems being "agentic", we are talking about systems that use an LLM to decide the control flow of an application. There are different levels that an LLM can be used to decide the control flow, and this spectrum of "agentic" makes more sense to us than defining an arbitrary cutoff for what is or isn't an agent.

Examples of using an LLM to decide the control of an application:

- Using an LLM to route between two potential paths
- Using an LLM to decide which of many tools to call
- Using an LLM to decide whether the generated answer is sufficient or more work is need

The more times these types of decisions are made inside an application, the more agentic it is.
If these decisions are being made in a loop, then its even more agentic!

There are other concepts often associated with being agentic, but we would argue these are a by-product of the above definition:

- [Tool calling](agentic_concepts.md#tool-calling): this is often how LLMs make decisions
- Action taking: often times, the LLMs' outputs are used as the input to an action
- [Memory](agentic_concepts.md#memory): reliable systems need to have knowledge of things that occurred
- [Planning](agentic_concepts.md#planning): planning steps (either explicit or implicit) are useful for ensuring that the LLM, when making decisions, makes them in the highest fidelity way.

## Why LangGraph?

LangGraph has several core principles that we believe make it the most suitable framework for building agentic applications:

- [Controllability](../how-tos/index.md#controllability)
- [Human-in-the-Loop](../how-tos/index.md#human-in-the-loop)
- [Streaming First](../how-tos/index.md#streaming)

**Controllability**

LangGraph is extremely low level. This gives you a high degree of control over what the system you are building actually does. We believe this is important because it is still hard to get agentic systems to work reliably, and we've seen that the more control you exercise over them, the more likely it is that they will "work".

**Human-in-the-Loop**

LangGraph comes with a built-in persistence layer as a first-class concept. This enables several different human-in-the-loop interaction patterns. We believe that "Human-Agent Interaction" patterns will be the new "Human-Computer Interaction", and have built LangGraph with built in persistence to enable this.

**Streaming First**

LangGraph comes with first class support for streaming. Agentic applications often take a while to run, and so giving the user some idea of what is happening is important, and streaming is a great way to do that. LangGraph supports streaming of both events ([like a tool call being taken](../how-tos/stream-updates.ipynb)) as well as of tokens that an LLM may emit.

## Deployment

So you've built your graph - now what?

Now you need to deploy it. There are many ways to deploy LangGraph.js objects, and the right solution depends on your needs and use case. We'll highlight two ways here: using [LangGraph Cloud](https://langchain-ai.github.io/langgraph/cloud) or rolling your own solution.

[LangGraph Cloud](https://langchain-ai.github.io/langgraph/cloud) is an opinionated way to deploy LangGraph objects from the LangChain team. Please see the [LangGraph Cloud documentation](https://langchain-ai.github.io/langgraph/cloud/) for all the details about what it involves, to see if it is a good fit for you.

If it is not a good fit, you'll need to roll your own deployment. We've taken as much care as possible to make LangGraph.js portable with a [wide variety of JavaScript environments and frameworks](../how-tos/use-in-web-environments.ipynb). Some options include evergreen frameworks like [Express.js](https://expressjs.com/) or newer ones like [Next.js](https://nextjs.org/) and [Hono](https://hono.dev/).