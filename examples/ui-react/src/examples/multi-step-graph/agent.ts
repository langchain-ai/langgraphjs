import { ChatOpenAI } from "@langchain/openai";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { BaseMessage, AIMessage } from "langchain";

const model = new ChatOpenAI({ model: "gpt-4o-mini" });

/**
 * Content Writer Pipeline - A multi-node LangGraph that demonstrates
 * state transitions and branching logic.
 * 
 * Workflow:
 * 1. research_node - Gathers information about the topic
 * 2. analyze_node - Analyzes the research for key insights
 * 3. decide_node - Decides if we have enough info or need more research
 * 4. draft_node - Creates a draft based on the analysis
 * 5. review_node - Reviews and refines the draft
 */

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
  research: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
  analysis: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
  draft: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
  finalContent: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
  researchIterations: Annotation<number>({
    reducer: (_, right) => right,
    default: () => 0,
  }),
  currentNode: Annotation<string>({
    reducer: (_, right) => right,
    default: () => "",
  }),
});

type State = typeof StateAnnotation.State;

/**
 * Extract the topic from the user's message
 */
async function extractTopicNode(state: State): Promise<Partial<State>> {
  const lastMessage = state.messages[state.messages.length - 1];
  const userInput = typeof lastMessage.content === "string" 
    ? lastMessage.content 
    : "";

  const response = await model.invoke([
    {
      role: "system",
      content: "Extract the main topic or subject the user wants to write about. Return only the topic, nothing else."
    },
    { role: "user", content: userInput }
  ]);

  return {
    topic: typeof response.content === "string" ? response.content : "",
    currentNode: "extract_topic",
    messages: [new AIMessage({ 
      content: `📌 **Topic Identified:** ${response.content}`,
      name: "extract_topic"
    })]
  };
}

/**
 * Research node - Gathers information about the topic
 */
async function researchNode(state: State): Promise<Partial<State>> {
  const iteration = state.researchIterations + 1;
  
  const response = await model.invoke([
    {
      role: "system",
      content: `You are a research assistant. Gather key facts, statistics, and interesting points about the topic. 
Be thorough but concise. This is research iteration ${iteration}.
${state.research ? `Previous research: ${state.research}` : ""}`
    },
    { role: "user", content: `Research the topic: ${state.topic}` }
  ]);

  const researchContent = typeof response.content === "string" ? response.content : "";

  return {
    research: state.research ? `${state.research}\n\n--- Additional Research ---\n${researchContent}` : researchContent,
    researchIterations: iteration,
    currentNode: "research_node",
    messages: [new AIMessage({ 
      content: `🔍 **Research (Iteration ${iteration}):**\n${researchContent}`,
      name: "research_node"
    })]
  };
}

/**
 * Analyze node - Analyzes the research for key insights
 */
async function analyzeNode(state: State): Promise<Partial<State>> {
  const response = await model.invoke([
    {
      role: "system",
      content: "You are an analyst. Review the research and identify the most important insights, themes, and angles for content creation. Be structured and insightful."
    },
    { role: "user", content: `Analyze this research about "${state.topic}":\n\n${state.research}` }
  ]);

  const analysisContent = typeof response.content === "string" ? response.content : "";

  return {
    analysis: analysisContent,
    currentNode: "analyze",
    messages: [new AIMessage({ 
      content: `🧠 **Analysis:**\n${analysisContent}`,
      name: "analyze"
    })]
  };
}

/**
 * Decide if we need more research or can proceed to drafting
 */
function shouldContinueResearch(state: State): "research_node" | "draft_node" {
  // If we've done less than 2 iterations and the analysis suggests gaps, do more research
  if (state.researchIterations < 2 && state.analysis.toLowerCase().includes("need more") ||
      state.analysis.toLowerCase().includes("insufficient") ||
      state.analysis.toLowerCase().includes("gaps")) {
    return "research_node";
  }
  return "draft_node";
}

/**
 * Draft node - Creates a draft based on the analysis
 */
async function draftNode(state: State): Promise<Partial<State>> {
  const response = await model.invoke([
    {
      role: "system",
      content: `You are a skilled content writer. Create a compelling, well-structured draft based on the research and analysis provided. 
Write in an engaging, professional tone. Include:
- A catchy opening
- Clear main points
- Supporting details
- A strong conclusion`
    },
    { 
      role: "user", 
      content: `Create a draft about "${state.topic}"\n\nResearch:\n${state.research}\n\nAnalysis:\n${state.analysis}` 
    }
  ]);

  const draftContent = typeof response.content === "string" ? response.content : "";

  return {
    draft: draftContent,
    currentNode: "draft_node",
    messages: [new AIMessage({ 
      content: `✍️ **Draft:**\n${draftContent}`,
      name: "draft_node"
    })]
  };
}

/**
 * Review node - Reviews and refines the draft
 */
async function reviewNode(state: State): Promise<Partial<State>> {
  const response = await model.invoke([
    {
      role: "system",
      content: `You are a senior editor. Review the draft and provide an improved, polished version.
Focus on:
- Clarity and flow
- Grammar and style
- Impact and engagement
- Overall coherence

Return the final polished content.`
    },
    { role: "user", content: `Review and improve this draft:\n\n${state.draft}` }
  ]);

  const finalContent = typeof response.content === "string" ? response.content : "";

  return {
    finalContent,
    currentNode: "review",
    messages: [new AIMessage({ 
      content: `✅ **Final Content:**\n${finalContent}`,
      name: "review"
    })]
  };
}

// Build the graph
const workflow = new StateGraph(StateAnnotation)
  // Add all nodes
  .addNode("extract_topic", extractTopicNode)
  .addNode("research_node", researchNode)
  .addNode("analyze", analyzeNode)
  .addNode("draft_node", draftNode)
  .addNode("review", reviewNode)
  
  // Define the flow
  .addEdge(START, "extract_topic")
  .addEdge("extract_topic", "research_node")
  .addEdge("research_node", "analyze")
  
  // Conditional edge: decide if we need more research
  .addConditionalEdges(
    "analyze",
    shouldContinueResearch,
    {
      research_node: "research_node",
      draft_node: "draft_node"
    }
  )
  
  .addEdge("draft_node", "review")
  .addEdge("review", END);

// Compile and export
export const agent = workflow.compile();

