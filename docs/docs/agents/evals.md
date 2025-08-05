# Evals

To evaluate your agent's performance you can use `LangSmith` [evaluations](https://docs.smith.langchain.com/evaluation). You would need to first define an evaluator function to judge the results from an agent, such as final outputs or trajectory. Depending on your evaluation technique, this may or may not involve a reference output:

```ts
const evaluator = async (params: {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  referenceOutputs?: Record<string, unknown>;
}) => {
  // compare agent outputs against reference outputs
  const outputMessages = params.outputs.messages;
  const referenceMessages = params.referenceOutputs.messages;
  const score = compareMessages(outputMessages, referenceMessages);
  return { key: "evaluator_score", score: score };
};
```

To get started, you can use prebuilt evaluators from `AgentEvals` package:

```bash
npm install agentevals @langchain/core
```

## Create evaluator

A common way to evaluate agent performance is by comparing its trajectory (the order in which it calls its tools) against a reference trajectory:

```ts
// highlight-next-line
import { createTrajectoryMatchEvaluator } from "agentevals";

const outputs = [
  {
    role: "assistant",
    tool_calls: [
      {
        function: {
          name: "get_weather",
          arguments: JSON.stringify({ city: "san francisco" }),
        },
      },
      {
        function: {
          name: "get_directions",
          arguments: JSON.stringify({ destination: "presidio" }),
        },
      },
    ],
  },
];

const referenceOutputs = [
  {
    role: "assistant",
    tool_calls: [
      {
        function: {
          name: "get_weather",
          arguments: JSON.stringify({ city: "san francisco" }),
        },
      },
    ],
  },
];

// Create the evaluator
const evaluator = createTrajectoryMatchEvaluator({
  // highlight-next-line
  trajectoryMatchMode: "superset",  // (1)!
})

// Run the evaluator
const result = await evaluator({
  outputs,
  referenceOutputs,
});
```

1. Specify how the trajectories will be compared. `superset` will accept output trajectory as valid if it's a superset of the reference one. Other options include: [strict](https://github.com/langchain-ai/agentevals?tab=readme-ov-file#strict-match), [unordered](https://github.com/langchain-ai/agentevals?tab=readme-ov-file#unordered-match) and [subset](https://github.com/langchain-ai/agentevals?tab=readme-ov-file#subset-and-superset-match)


As a next step, learn more about how to [customize trajectory match evaluator](https://github.com/langchain-ai/agentevals?tab=readme-ov-file#agent-trajectory-match).

### LLM-as-a-judge

You can use LLM-as-a-judge evaluator that uses an LLM to compare the trajectory against the reference outputs and output a score:

```ts
import {
  // highlight-next-line
  createTrajectoryLLMAsJudge,
  TRAJECTORY_ACCURACY_PROMPT_WITH_REFERENCE
} from "agentevals";

const evaluator = createTrajectoryLLMAsJudge({
  prompt: TRAJECTORY_ACCURACY_PROMPT_WITH_REFERENCE,
  model: "openai:o3-mini",
});
```

## Run evaluator

To run an evaluator, you will first need to create a [LangSmith dataset](https://docs.smith.langchain.com/evaluation/concepts#datasets). To use the prebuilt AgentEvals evaluators, you will need a dataset with the following schema:

- **input**: `{ messages: [...] }` input messages to call the agent with.
- **output**: `{ messages": [...] }` expected message history in the agent output. For trajectory evaluation, you can choose to keep only assistant messages.

```ts
import { evaluate } from "langsmith/evaluation";
import { createTrajectoryMatchEvaluator } from "agentevals";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const agent = createReactAgent({ ... })
const evaluator = createTrajectoryMatchEvaluator({ ... })
await evaluate(
  async (inputs) => await agent.invoke(inputs),
  {
    // replace with your dataset name
    data: "<Name of your dataset>",
    evaluators: [evaluator],
  }
);
```