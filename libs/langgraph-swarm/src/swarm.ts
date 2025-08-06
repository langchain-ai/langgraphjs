import {
  START,
  StateGraph,
  CompiledStateGraph,
  AnnotationRoot,
  MessagesAnnotation,
  Annotation,
} from "@langchain/langgraph";
import { getHandoffDestinations } from "./handoff.js";

/**
 * State schema for the multi-agent swarm.
 */
const SwarmState = Annotation.Root({
  ...MessagesAnnotation.spec,
  activeAgent: Annotation<string>,
});

/**
 * Add a router to the currently active agent to the StateGraph.
 *
 * @param builder The graph builder (StateGraph) to add the router to.
 * @param routeTo A list of agent (node) names to route to.
 * @param defaultActiveAgent Name of the agent to route to by default (if no agents are currently active).
 * @returns StateGraph with the router added.
 */
const addActiveAgentRouter = <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AnnotationRootT extends AnnotationRoot<any> = typeof SwarmState
>(
  builder: StateGraph<
    AnnotationRootT["spec"],
    AnnotationRootT["State"],
    AnnotationRootT["Update"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    AnnotationRootT["spec"],
    AnnotationRootT["spec"]
  >,
  {
    routeTo,
    defaultActiveAgent,
  }: {
    routeTo: string[];
    defaultActiveAgent: string;
  }
): StateGraph<
  AnnotationRootT["spec"],
  AnnotationRootT["State"],
  AnnotationRootT["Update"],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  AnnotationRootT["spec"],
  AnnotationRootT["spec"]
> => {
  if (!routeTo.includes(defaultActiveAgent)) {
    throw new Error(
      `Default active agent '${defaultActiveAgent}' not found in routes ${routeTo}`
    );
  }

  const routeToActiveAgent = (state: typeof SwarmState.State) => {
    return state.activeAgent || defaultActiveAgent;
  };

  builder.addConditionalEdges(START, routeToActiveAgent, routeTo);
  return builder;
};

export type CreateSwarmParams<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AnnotationRootT extends AnnotationRoot<any> = typeof SwarmState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AgentAnnotationRootT extends AnnotationRoot<any> = typeof MessagesAnnotation
> = {
  agents: CompiledStateGraph<
    AgentAnnotationRootT["State"],
    AgentAnnotationRootT["Update"],
    string,
    AgentAnnotationRootT["spec"],
    AgentAnnotationRootT["spec"]
  >[];
  defaultActiveAgent: string;
  stateSchema?: AnnotationRootT;
};

/**
 * Create a multi-agent swarm.
 *
 * @param agents List of agents to add to the swarm
 * @param defaultActiveAgent Name of the agent to route to by default (if no agents are currently active).
 * @param stateSchema State schema to use for the multi-agent graph.
 * @returns A multi-agent swarm StateGraph.
 */
const createSwarm = <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AnnotationRootT extends AnnotationRoot<any> = typeof SwarmState
>({
  agents,
  defaultActiveAgent,
  stateSchema,
}: CreateSwarmParams<AnnotationRootT>) => {
  if (stateSchema && !("activeAgent" in stateSchema.spec)) {
    throw new Error("Missing required key 'activeAgent' in stateSchema");
  }

  const agentNames = new Set<string>();

  for (const agent of agents) {
    if (!agent.name || agent.name === "LangGraph") {
      throw new Error(
        "Please specify a name when you create your agent, either via `createReactAgent({ ..., name: agentName })` " +
          "or via `graph.compile({ name: agentName })`."
      );
    }

    if (agentNames.has(agent.name)) {
      throw new Error(
        `Agent with name '${agent.name}' already exists. Agent names must be unique.`
      );
    }

    agentNames.add(agent.name);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder = new StateGraph<any>(stateSchema ?? SwarmState);

  addActiveAgentRouter(builder, {
    routeTo: [...agentNames],
    defaultActiveAgent,
  });

  for (const agent of agents) {
    builder.addNode(agent.name!, agent, {
      ends: getHandoffDestinations(agent),
      subgraphs: [agent],
    });
  }

  return builder as StateGraph<
    AnnotationRootT["spec"],
    AnnotationRootT["State"],
    AnnotationRootT["Update"],
    string,
    AnnotationRootT["spec"],
    AnnotationRootT["spec"]
  >;
};

export { createSwarm, addActiveAgentRouter, SwarmState };
