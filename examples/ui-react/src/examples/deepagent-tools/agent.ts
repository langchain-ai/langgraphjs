import { tool } from "langchain";
import { z } from "zod/v3";
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";

// ============================================================================
// Research Agent Tools
// ============================================================================

export const searchWeb = tool(
  async ({ query, maxResults }) => {
    // Simulate web search
    await new Promise((r) => setTimeout(r, 800));

    const results = [
      {
        title: `Research finding: ${query}`,
        url: "https://example.com/research/1",
        snippet: `Key insights about ${query} based on recent studies...`,
      },
      {
        title: `Academic paper on ${query}`,
        url: "https://example.com/paper/2",
        snippet: `Peer-reviewed research discussing ${query} and its implications...`,
      },
      {
        title: `Expert analysis: ${query}`,
        url: "https://example.com/analysis/3",
        snippet: `Industry expert perspectives on ${query} trends and developments...`,
      },
    ].slice(0, maxResults);

    return JSON.stringify({
      status: "success",
      query,
      results,
      totalFound: results.length,
    });
  },
  {
    name: "search_web",
    description: "Search the web for information on a topic",
    schema: z.object({
      query: z.string().describe("The search query"),
      maxResults: z
        .number()
        .min(1)
        .max(10)
        .default(3)
        .describe("Maximum number of results to return"),
    }),
  }
);

export const analyzeSentiment = tool(
  async () => {
    await new Promise((r) => setTimeout(r, 500));

    // Simulate sentiment analysis
    const sentiments = ["positive", "neutral", "negative"];
    const sentiment = sentiments[Math.floor(Math.random() * 3)];
    const confidence = 0.75 + Math.random() * 0.2;

    return JSON.stringify({
      status: "success",
      sentiment,
      confidence: confidence.toFixed(2),
      summary: `The text has a predominantly ${sentiment} tone with ${(
        confidence * 100
      ).toFixed(0)}% confidence.`,
    });
  },
  {
    name: "analyze_sentiment",
    description: "Analyze the sentiment of a piece of text",
    schema: z.object({
      text: z.string().describe("The text to analyze"),
    }),
  }
);

export const extractKeywords = tool(
  async ({ text, count }) => {
    await new Promise((r) => setTimeout(r, 400));

    // Generate some plausible keywords from the text
    const words = text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4);
    const keywords = [...new Set(words)].slice(0, count);

    return JSON.stringify({
      status: "success",
      keywords,
      relevanceScores: keywords.map(() =>
        (0.7 + Math.random() * 0.3).toFixed(2)
      ),
    });
  },
  {
    name: "extract_keywords",
    description: "Extract key topics and keywords from text",
    schema: z.object({
      text: z.string().describe("The text to extract keywords from"),
      count: z
        .number()
        .min(1)
        .max(10)
        .default(5)
        .describe("Number of keywords to extract"),
    }),
  }
);

// ============================================================================
// Data Agent Tools
// ============================================================================

export const queryDatabase = tool(
  async ({ table, filters }) => {
    await new Promise((r) => setTimeout(r, 600));

    // Simulate database query
    const mockData = [
      { id: 1, name: "Record A", value: 42, category: "alpha" },
      { id: 2, name: "Record B", value: 87, category: "beta" },
      { id: 3, name: "Record C", value: 23, category: "alpha" },
    ];

    return JSON.stringify({
      status: "success",
      table,
      filters,
      records: mockData,
      count: mockData.length,
    });
  },
  {
    name: "query_database",
    description: "Query a database table with optional filters",
    schema: z.object({
      table: z.string().describe("The table name to query"),
      filters: z.string().optional().describe("Optional filter conditions"),
    }),
  }
);

export const aggregateData = tool(
  async ({ operation }) => {
    await new Promise((r) => setTimeout(r, 300));

    // Simulate data aggregation
    const result = {
      sum: 152,
      average: 50.67,
      count: 3,
      max: 87,
      min: 23,
    };

    return JSON.stringify({
      status: "success",
      operation,
      result: result[operation as keyof typeof result] || result.sum,
      details: `Applied ${operation} aggregation to the dataset`,
    });
  },
  {
    name: "aggregate_data",
    description: "Perform aggregation operations on data",
    schema: z.object({
      data: z.string().describe("Reference to the data to aggregate"),
      operation: z
        .enum(["sum", "average", "count", "max", "min"])
        .describe("The aggregation operation to perform"),
    }),
  }
);

export const generateChart = tool(
  async ({ chartType, title }) => {
    await new Promise((r) => setTimeout(r, 700));

    return JSON.stringify({
      status: "success",
      chartType,
      title,
      chartUrl: `https://charts.example.com/${chartType}/${Date.now()}`,
      message: `Generated a ${chartType} chart titled "${title}"`,
    });
  },
  {
    name: "generate_chart",
    description: "Generate a visualization chart from data",
    schema: z.object({
      chartType: z
        .enum(["bar", "line", "pie", "scatter"])
        .describe("The type of chart to generate"),
      title: z.string().describe("The chart title"),
    }),
  }
);

// ============================================================================
// Writer Agent Tools
// ============================================================================

export const draftSection = tool(
  async ({ topic, style, wordCount }) => {
    await new Promise((r) => setTimeout(r, 900));

    return JSON.stringify({
      status: "success",
      topic,
      style,
      targetWordCount: wordCount,
      draft: `[Draft section about "${topic}" in ${style} style, approximately ${wordCount} words. This would contain substantive content based on the research and data analysis.]`,
    });
  },
  {
    name: "draft_section",
    description: "Draft a section of content on a topic",
    schema: z.object({
      topic: z.string().describe("The topic to write about"),
      style: z
        .enum(["formal", "casual", "technical", "persuasive"])
        .default("formal")
        .describe("The writing style"),
      wordCount: z
        .number()
        .min(50)
        .max(1000)
        .default(200)
        .describe("Target word count"),
    }),
  }
);

export const editContent = tool(
  async ({ content, instructions }) => {
    await new Promise((r) => setTimeout(r, 500));

    return JSON.stringify({
      status: "success",
      originalLength: content.length,
      instructions,
      editedContent: `[Edited version applying: ${instructions}]`,
      changesSummary: "Applied requested edits to improve clarity and flow.",
    });
  },
  {
    name: "edit_content",
    description: "Edit and refine written content",
    schema: z.object({
      content: z.string().describe("The content to edit"),
      instructions: z.string().describe("Editing instructions"),
    }),
  }
);

export const checkGrammar = tool(
  async () => {
    await new Promise((r) => setTimeout(r, 400));

    return JSON.stringify({
      status: "success",
      issues: [
        { type: "grammar", suggestion: "Consider using active voice" },
        { type: "style", suggestion: "Sentence could be more concise" },
      ],
      overallScore: 85,
      message: "Text is mostly well-written with minor suggestions.",
    });
  },
  {
    name: "check_grammar",
    description: "Check text for grammar and style issues",
    schema: z.object({
      text: z.string().describe("The text to check"),
    }),
  }
);

// ============================================================================
// Create Deep Agent with Subagents
// ============================================================================

const checkpointer = new MemorySaver();

export const agent = createDeepAgent({
  model: "gpt-5.2",
  checkpointer,
  subagents: [
    {
      name: "researcher",
      description:
        "Research specialist that searches the web, analyzes content sentiment, and extracts key topics. Use this agent to gather information and insights on any topic.",
      systemPrompt: `You are a research specialist. Your job is to:
1. Search the web for relevant information
2. Analyze the sentiment of content you find
3. Extract key topics and themes

Always use multiple tools to provide comprehensive research. Start with a search, then analyze what you find.`,
      tools: [searchWeb, analyzeSentiment, extractKeywords],
    },
    {
      name: "data-analyst",
      description:
        "Data analysis expert that queries databases, performs aggregations, and creates visualizations. Use this agent for any data-related tasks.",
      systemPrompt: `You are a data analysis expert. Your job is to:
1. Query relevant data sources
2. Perform aggregations and calculations
3. Generate visualizations to present findings

Always provide quantitative insights backed by data.`,
      tools: [queryDatabase, aggregateData, generateChart],
    },
    {
      name: "content-writer",
      description:
        "Professional content writer that drafts, edits, and polishes written content. Use this agent to create well-written reports and summaries.",
      systemPrompt: `You are a professional content writer. Your job is to:
1. Draft clear, engaging sections based on provided information
2. Edit and refine content for clarity
3. Ensure grammar and style are polished

Create content that is informative and easy to read.`,
      tools: [draftSection, editContent, checkGrammar],
    },
  ],
  systemPrompt: `You are an AI Project Coordinator that orchestrates specialized agents to complete complex tasks.

When a user provides a task, you should delegate to the appropriate subagents in PARALLEL when possible:

1. **researcher** - For gathering information, analyzing content, and identifying key topics
2. **data-analyst** - For querying data, performing calculations, and creating visualizations
3. **content-writer** - For drafting, editing, and polishing written content

IMPORTANT: Launch multiple agents simultaneously when their tasks are independent! This gives users real-time visibility into each specialist's progress.

After all agents complete, synthesize their work into a cohesive final deliverable.

Example workflow for "Create a market analysis report":
- Launch researcher to gather market information
- Launch data-analyst to query market data and create charts
- After research is done, launch content-writer to draft the report

Always explain what each subagent is doing and synthesize their outputs.`,
});
