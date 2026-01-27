import z from "zod";
import { tool, type ToolRuntime, createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";

import type { ProgressData, StatusData, FileStatusData } from "./types";

/**
 * The model to use for the agent
 */
const model = new ChatOpenAI({
  model: "gpt-4o-mini",
});

const analyzeDataSchema = z.object({
  dataSource: z
    .enum(["sales", "inventory", "customers", "transactions"])
    .describe("The data source to analyze"),
  analysisType: z
    .enum(["trends", "anomalies", "correlations", "summary"])
    .describe("The type of analysis to perform"),
});

/**
 * Data analysis tool - demonstrates custom streaming events
 * Emits progress updates during execution using typed custom events
 */
const analyzeDataTool = tool(
  async (input, config: ToolRuntime): Promise<string> => {
    const { dataSource, analysisType } = input;
    const steps = [
      { step: "connecting", message: `Connecting to ${dataSource}...` },
      { step: "fetching", message: "Fetching data records..." },
      { step: "processing", message: `Running ${analysisType} analysis...` },
      { step: "generating", message: "Generating insights..." },
    ];

    /**
     * Use a unique ID for this analysis to make progress parts persistent
     * Parts with an 'id' field are added to message.parts (not transient)
     */
    const analysisId = `analysis-${Date.now()}`;

    for (let i = 0; i < steps.length; i++) {
      /**
       * Emit progress events with typed custom data
       */
      config.writer?.({
        type: "progress",
        id: analysisId, // Same ID to update the progress in place
        step: steps[i].step,
        message: steps[i].message,
        progress: Math.round(((i + 1) / steps.length) * 100),
        totalSteps: steps.length,
        currentStep: i + 1,
        toolCall: config.toolCall,
      } satisfies ProgressData);

      /**
       * Simulate processing time
       */
      await new Promise((resolve) =>
        setTimeout(resolve, 500 + Math.random() * 500)
      );
    }

    /**
     * Emit completion event with unique ID
     */
    config.writer?.({
      type: "status",
      id: `${analysisId}-status`,
      status: "complete",
      message: "Analysis finished successfully",
      toolCall: config.toolCall,
    } satisfies StatusData);

    /**
     * Return the result to the LLM
     */
    const results = {
      dataSource,
      analysisType,
      recordsProcessed: Math.floor(Math.random() * 10000) + 1000,
      insights: [
        "Key trend: 23% increase in Q4",
        "Anomaly detected in region B",
        "Correlation found between X and Y metrics",
      ],
      confidence: 0.94,
    };

    return JSON.stringify(results, null, 2);
  },
  {
    name: "analyze_data",
    description:
      "Analyze data from various sources. Streams progress updates during analysis.",
    schema: analyzeDataSchema,
  }
);

const processFileSchema = z.object({
  filename: z.string().describe("The filename to process"),
  operation: z
    .enum(["read", "compress", "validate", "transform"])
    .describe("The operation to perform"),
});

/**
 * File processing tool - demonstrates status updates
 */
const processFileTool = tool(
  async (input, config: ToolRuntime) => {
    const { filename, operation } = input;
    /**
     * Use a unique ID for this file operation to make it persistent
     */
    const fileOpId = `file-${filename}-${Date.now()}`;

    /**
     * Emit file operation status with ID for persistence
     */
    config.writer?.({
      type: "file-status",
      id: fileOpId,
      filename,
      operation,
      status: "started",
      toolCall: config.toolCall,
    } satisfies FileStatusData);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    /**
     * Update the same part with completed status
     */
    config.writer?.({
      type: "file-status",
      id: fileOpId,
      filename,
      operation,
      status: "completed",
      size: `${Math.floor(Math.random() * 1000) + 100}KB`,
      toolCall: config.toolCall,
    } satisfies FileStatusData);

    return `Successfully ${operation}ed file: ${filename}`;
  },
  {
    name: "process_file",
    description: "Process a file with various operations",
    schema: processFileSchema,
  }
);

/**
 * Compile the graph with a memory checkpointer
 */
export const agent = createAgent({
  model,
  tools: [analyzeDataTool, processFileTool],
  checkpointer: new MemorySaver(),
  systemPrompt: `You are a helpful assistant that can analyze data and process files.`,
});
