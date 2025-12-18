import { ChatOpenAI } from "@langchain/openai";
import { StateGraph, Annotation, START, END, Send } from "@langchain/langgraph";
import { BaseMessage, AIMessage, HumanMessage } from "langchain";

/**
 * Parallel Research Pipeline - A LangGraph that demonstrates
 * parallel node execution where 3 different "research models" analyze
 * a topic simultaneously and stream their results.
 * 
 * Workflow:
 * 1. dispatcher - Receives the topic and fans out to 3 parallel researchers
 * 2. researcher_analytical - Analytical/data-driven research style
 * 3. researcher_creative - Creative/storytelling research style  
 * 4. researcher_practical - Practical/actionable research style
 * 5. All stream in parallel, user picks their preferred result
 */

// Use different model instances to get variety in responses
const analyticalModel = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.3 });
const creativeModel = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.9 });
const practicalModel = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.5 });

// Define the state annotation with reducer for messages
const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left: BaseMessage[], right: BaseMessage | BaseMessage[]) => {
      return Array.isArray(right) ? left.concat(right) : left.concat([right]);
    },
    default: () => [],
  }),
  topic: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
  analyticalResearch: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
  creativeResearch: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
  practicalResearch: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
  selectedResearch: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
  currentNode: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
});

type State = typeof StateAnnotation.State;

/**
 * Dispatcher node - Extracts topic and triggers parallel research
 */
async function dispatcherNode(state: State): Promise<Partial<State>> {
  const lastMessage = state.messages[state.messages.length - 1];
  const userInput = typeof lastMessage.content === "string" 
    ? lastMessage.content 
    : "";

  return {
    topic: userInput,
    currentNode: "dispatcher",
    messages: [new AIMessage({ 
      content: `🎯 **Research Topic:** ${userInput}\n\nDispatching to 3 parallel research models...`,
      name: "dispatcher"
    })]
  };
}

/**
 * Fan-out function to trigger parallel researchers
 */
function fanOutToResearchers(state: State): Send[] {
  return [
    new Send("researcher_analytical", state),
    new Send("researcher_creative", state),
    new Send("researcher_practical", state),
  ];
}

/**
 * Analytical Researcher - Data-driven, structured approach
 */
async function analyticalResearcherNode(state: State): Promise<Partial<State>> {
  const response = await analyticalModel.invoke([
    {
      role: "system",
      content: `You are an analytical research expert. Your approach is data-driven, methodical, and structured.

When researching a topic, you focus on:
- Statistics and hard data
- Logical frameworks and models
- Evidence-based conclusions
- Structured analysis with clear sections
- Pros/cons and trade-offs

Write a comprehensive but concise research summary (about 200-300 words).
Use markdown formatting with headers, bullet points, and emphasis where appropriate.`
    },
    { role: "user", content: `Research this topic with your analytical approach: ${state.topic}` }
  ]);

  const content = typeof response.content === "string" ? response.content : "";

  return {
    analyticalResearch: content,
    currentNode: "researcher_analytical",
    messages: [new AIMessage({ 
      content: content,
      name: "researcher_analytical"
    })]
  };
}

/**
 * Creative Researcher - Narrative-driven, imaginative approach
 */
async function creativeResearcherNode(state: State): Promise<Partial<State>> {
  const response = await creativeModel.invoke([
    {
      role: "system",
      content: `You are a creative research storyteller. Your approach is narrative-driven, engaging, and imaginative.

When researching a topic, you focus on:
- Compelling narratives and stories
- Human impact and emotional connections
- Unexpected angles and perspectives
- Metaphors and vivid descriptions
- Future possibilities and "what ifs"

Write a compelling research narrative (about 200-300 words).
Use markdown formatting with creative headers and engaging prose.`
    },
    { role: "user", content: `Research this topic with your creative storytelling approach: ${state.topic}` }
  ]);

  const content = typeof response.content === "string" ? response.content : "";

  return {
    creativeResearch: content,
    currentNode: "researcher_creative",
    messages: [new AIMessage({ 
      content: content,
      name: "researcher_creative"
    })]
  };
}

/**
 * Practical Researcher - Action-oriented, hands-on approach
 */
async function practicalResearcherNode(state: State): Promise<Partial<State>> {
  const response = await practicalModel.invoke([
    {
      role: "system",
      content: `You are a practical research advisor. Your approach is action-oriented, hands-on, and immediately useful.

When researching a topic, you focus on:
- Actionable insights and next steps
- Real-world applications
- Common pitfalls to avoid
- Quick wins and long-term strategies
- Tools, resources, and recommendations

Write a practical research guide (about 200-300 words).
Use markdown formatting with clear action items and recommendations.`
    },
    { role: "user", content: `Research this topic with your practical, actionable approach: ${state.topic}` }
  ]);

  const content = typeof response.content === "string" ? response.content : "";

  return {
    practicalResearch: content,
    currentNode: "researcher_practical",
    messages: [new AIMessage({ 
      content: content,
      name: "researcher_practical"
    })]
  };
}

/**
 * Collector node - Gathers all research and presents options
 */
async function collectorNode(state: State): Promise<Partial<State>> {
  return {
    currentNode: "collector",
    messages: [new AIMessage({ 
      content: `✅ **All research complete!**\n\nThree different perspectives are now available. Review each approach and select the one that best fits your needs.`,
      name: "collector"
    })]
  };
}

// Build the graph
const workflow = new StateGraph(StateAnnotation)
  // Add all nodes
  .addNode("dispatcher", dispatcherNode)
  .addNode("researcher_analytical", analyticalResearcherNode)
  .addNode("researcher_creative", creativeResearcherNode)
  .addNode("researcher_practical", practicalResearcherNode)
  .addNode("collector", collectorNode)
  
  // Start with dispatcher
  .addEdge(START, "dispatcher")
  
  // Fan out to parallel researchers
  .addConditionalEdges(
    "dispatcher",
    fanOutToResearchers
  )
  
  // All researchers lead to collector
  .addEdge("researcher_analytical", "collector")
  .addEdge("researcher_creative", "collector")
  .addEdge("researcher_practical", "collector")
  
  // Collector ends the flow
  .addEdge("collector", END);

// Compile and export
export const agent = workflow.compile();

