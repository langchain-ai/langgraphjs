import type { ToolCallWithResult } from "@langchain/react";

import { isRecord, safeStringify } from "../../utils";
import type { MessageFeedToolCall } from "./toolCalls";

const TOOL_PREVIEW_LIMIT = 220;
export const TOOL_CODE_PREVIEW_LINES = 8;

export const truncateText = (
  value: string,
  maxLength = TOOL_PREVIEW_LIMIT
) => {
  const normalized = value.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
};

export const formatToolName = (name: string) =>
  name
    .split(/[_-]/)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");

export const parseToolPayload = (value: unknown) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const pickFirstString = (
  record: Record<string, unknown>,
  keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
};

const getCustomerLabel = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.customerName === "string" &&
    value.customerName.trim().length > 0
  ) {
    return value.customerName.trim();
  }

  const firstName =
    typeof value.firstName === "string" ? value.firstName.trim() : "";
  const lastName =
    typeof value.lastName === "string" ? value.lastName.trim() : "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  return fullName.length > 0 ? fullName : undefined;
};

export const getToolTheme = (name: string) => {
  if (name === "task") return "theme-task";
  if (name === "js_eval") return "theme-code";
  if (name.startsWith("validate_poem_")) return "theme-validator";
  return "theme-generic";
};

export const getToolTitle = (name: string) => {
  if (name === "task") return "Subagent Task";
  if (name === "js_eval") return "QuickJS Eval";
  if (name.startsWith("validate_poem_")) {
    return `${formatToolName(name.replace("validate_", ""))} Validator`;
  }

  return formatToolName(name);
};

export const getToolTagValues = (
  name: string,
  args: unknown,
  result: unknown
) => {
  const tags: string[] = [];
  const parsedArgs = parseToolPayload(args);
  const parsedResult = parseToolPayload(result);
  const customerLabel =
    getCustomerLabel(parsedArgs) ?? getCustomerLabel(parsedResult);

  if (name === "task" && isRecord(parsedArgs)) {
    const subagentType = pickFirstString(parsedArgs, [
      "subagent_type",
      "subagentType",
      "agent",
      "worker",
    ]);
    if (subagentType != null) tags.push(subagentType);
  }

  if (customerLabel != null) {
    tags.push(customerLabel);
  }

  if (name === "js_eval" && isRecord(parsedArgs)) {
    const code = pickFirstString(parsedArgs, ["code", "javascript", "script"]);
    if (code != null) {
      tags.push(`${code.split("\n").length} line${code.includes("\n") ? "s" : ""}`);
    }
  }

  const validatorAttempt =
    isRecord(parsedArgs) && typeof parsedArgs.attempt === "number"
      ? parsedArgs.attempt
      : isRecord(parsedResult) && typeof parsedResult.attempt === "number"
        ? parsedResult.attempt
        : undefined;
  if (validatorAttempt != null) {
    tags.push(`Attempt ${validatorAttempt + 1}`);
  }

  return tags.slice(0, 3);
};

export const getToolInputPreview = (name: string, args: unknown) => {
  const parsedArgs = parseToolPayload(args);
  if (!isRecord(parsedArgs)) {
    return typeof parsedArgs === "string"
      ? { label: "Input", value: truncateText(parsedArgs), isCode: false }
      : undefined;
  }

  if (name === "js_eval") {
    const code = pickFirstString(parsedArgs, ["code", "javascript", "script"]);
    if (code != null) {
      return {
        label: "Code",
        value: code.split("\n").slice(0, TOOL_CODE_PREVIEW_LINES).join("\n"),
        isCode: true,
      };
    }
  }

  if (name === "task") {
    const prompt = pickFirstString(parsedArgs, [
      "description",
      "prompt",
      "task",
      "instructions",
      "input",
    ]);
    if (prompt != null) {
      return { label: "Task", value: truncateText(prompt), isCode: false };
    }
  }

  if (name.startsWith("validate_poem_")) {
    const poem = pickFirstString(parsedArgs, ["poem"]);
    if (poem != null) {
      return { label: "Draft", value: truncateText(poem), isCode: false };
    }
  }

  const summary = pickFirstString(parsedArgs, [
    "description",
    "prompt",
    "input",
    "query",
    "title",
    "location",
    "topic",
    "expression",
  ]);
  if (summary != null) {
    return { label: "Input", value: truncateText(summary), isCode: false };
  }

  return {
    label: "Input",
    value: truncateText(safeStringify(parsedArgs)),
    isCode: false,
  };
};

export const getToolResultPreview = (
  name: string,
  result: ToolCallWithResult<MessageFeedToolCall>["result"]
) => {
  if (result == null) return undefined;

  const parsedContent = parseToolPayload(result.content);
  if (name.startsWith("validate_poem_") && isRecord(parsedContent)) {
    const feedback =
      typeof parsedContent.feedback === "string"
        ? parsedContent.feedback
        : undefined;
    const passed =
      typeof parsedContent.passed === "boolean" ? parsedContent.passed : undefined;
    if (feedback != null) {
      return {
        label: passed ? "Passed" : result.status === "error" ? "Error" : "Feedback",
        value: truncateText(feedback),
      };
    }
  }

  if (isRecord(parsedContent)) {
    const preview = pickFirstString(parsedContent, [
      "summary",
      "message",
      "result",
      "output",
      "content",
      "feedback",
      "answer",
    ]);
    if (preview != null) {
      return {
        label: result.status === "error" ? "Error" : "Result",
        value: truncateText(preview),
      };
    }
  }

  if (typeof parsedContent === "string" && parsedContent.trim().length > 0) {
    return {
      label: result.status === "error" ? "Error" : "Result",
      value: truncateText(parsedContent),
    };
  }

  return {
    label: result.status === "error" ? "Error" : "Result",
    value: truncateText(safeStringify(parsedContent)),
  };
};
