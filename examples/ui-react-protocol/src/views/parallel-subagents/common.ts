import type { Message } from "@langchain/langgraph-sdk";
import {
  type MessageTupleManager,
  toMessageDict,
} from "@langchain/langgraph-sdk/ui";
import type { ProtocolEventMessage } from "@langchain/langgraph-sdk/utils";

import type { TraceEntry } from "../../components/ProtocolPlayground";
import { isRecord } from "../../utils";

export type SubagentRow = {
  key: string;
  namespace: string[];
  graphName: string;
  status: string;
  eventCount: number;
  hasModelActivity: boolean;
  order: number;
  toolCallId: string;
};

export type ModalState = {
  key: string;
  namespace: string[];
  graphName: string;
  status: string;
  messages: Message[];
  toolEvents: TraceEntry[];
  isConnecting: boolean;
  error?: string;
};

export const SESSION_ASSISTANT_ID = "parallel-subagents";

export const SUGGESTIONS = [
  "Write short poems for the first 2 customers in the CSV fixture.",
  "Write short poems for the first 16 customers and summarize the fan-out.",
  "Write a tiny poem for every customer in the 100-row fixture.",
];

export const createTraceEntry = (
  kind: string,
  label: string,
  detail: string,
  raw: unknown
): TraceEntry => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  kind,
  label,
  detail,
  timestamp: new Date().toLocaleTimeString(),
  raw,
});

export const getMessagesFromManager = (manager: MessageTupleManager) =>
  Object.values(manager.chunks)
    .filter(
      (
        entry
      ): entry is {
        chunk: Parameters<typeof toMessageDict>[0];
      } => entry.chunk != null
    )
    .map((entry) => toMessageDict(entry.chunk) as Message);

export const getLifecycleStatus = (event: ProtocolEventMessage) => {
  const data = event.params.data;
  return isRecord(data) && typeof data.event === "string" ? data.event : "running";
};

export const getLifecycleGraphName = (event: ProtocolEventMessage) => {
  const data = event.params.data;
  if (isRecord(data) && typeof data.graphName === "string") {
    return data.graphName;
  }

  return event.params.namespace.at(-1) ?? "subagent";
};

export const getCanonicalSubagentNamespace = (namespace: string[]) => {
  let lastToolIndex = -1;
  for (let index = 0; index < namespace.length; index += 1) {
    if (namespace[index]?.startsWith("tools:")) {
      lastToolIndex = index;
    }
  }
  return lastToolIndex === -1 ? null : namespace.slice(0, lastToolIndex + 1);
};

export const hasModelRequestActivity = (namespace: string[]) =>
  namespace.some((segment) => segment.startsWith("model_request:"));

export const isToolCallNamespace = (toolCallId: string) =>
  toolCallId.startsWith("call_") ||
  toolCallId.startsWith("synthetic_subagent_");

export const isNamespacePrefix = (prefix: string[], namespace?: string[]) => {
  if (namespace == null) return false;
  return prefix.every((segment, index) => namespace[index] === segment);
};

export const isToolExecutionNamespace = (namespace: string[]) =>
  namespace.at(-1)?.startsWith("tools:") ?? false;

const getToolResultContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value) && "content" in value) {
    const content = value.content;
    if (typeof content === "string") {
      return content;
    }
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const createSyntheticToolResultMessage = (event: unknown): Message | null => {
  if (!isRecord(event) || typeof event.toolCallId !== "string") {
    return null;
  }

  if (event.event !== "on_tool_end" && event.event !== "on_tool_error") {
    return null;
  }

  const rawPayload = event.event === "on_tool_end" ? event.output : event.error;
  const payload = isRecord(rawPayload) ? rawPayload : undefined;
  const status =
    event.event === "on_tool_error" || payload?.status === "error"
      ? "error"
      : "success";
  const content = getToolResultContent(rawPayload);
  const name =
    typeof payload?.name === "string"
      ? payload.name
      : typeof event.name === "string"
        ? event.name
        : undefined;

  return {
    id: `synthetic-tool-${event.toolCallId}`,
    type: "tool",
    tool_call_id: event.toolCallId,
    status,
    content,
    ...(name != null ? { name } : {}),
  };
};

export const getLegacySubagentTitle = (
  toolCallId: string,
  toolCall?: {
    args?: Record<string, unknown>;
  }
) => {
  const args = toolCall?.args;
  const firstName =
    typeof args?.firstName === "string" ? args.firstName : undefined;
  const lastName =
    typeof args?.lastName === "string" ? args.lastName : undefined;
  if (firstName || lastName) {
    return [firstName, lastName].filter(Boolean).join(" ");
  }

  if (typeof args?.customerName === "string") {
    return args.customerName;
  }

  if (typeof args?.description === "string") {
    return args.description.length > 48
      ? `${args.description.slice(0, 45)}...`
      : args.description;
  }

  return toolCallId;
};

export const isTerminalLifecycleStatus = (
  status: string | undefined
): status is "completed" | "failed" | "interrupted" =>
  status === "completed" ||
  status === "failed" ||
  status === "interrupted";

export const resolveProtocolSubagentStatus = (
  previousStatus: string | undefined,
  lifecycleStatus: string,
  namespace: string[],
  toolCallId?: string
) => {
  if (isTerminalLifecycleStatus(previousStatus)) {
    return previousStatus;
  }

  if (isTerminalLifecycleStatus(lifecycleStatus)) {
    return lifecycleStatus;
  }

  if (
    lifecycleStatus === "running" ||
    hasModelRequestActivity(namespace) ||
    previousStatus === "running" ||
    (lifecycleStatus === "spawned" &&
      toolCallId != null &&
      isToolCallNamespace(toolCallId))
  ) {
    return "running";
  }

  return previousStatus ?? lifecycleStatus;
};

const sortSubagents = (subagents: SubagentRow[]) =>
  [...subagents].sort((left, right) => {
    if (left.status === right.status) {
      return left.order - right.order;
    }

    if (left.status === "running") return -1;
    if (right.status === "running") return 1;
    return left.status.localeCompare(right.status);
  });

export const getSortedSubagents = (subagents: Record<string, SubagentRow>) => {
  const allSubagents = Object.values(subagents);
  const protocolToolCalls = allSubagents.filter((subagent) =>
    isToolCallNamespace(subagent.toolCallId)
  );

  if (protocolToolCalls.length > 0) {
    return sortSubagents(protocolToolCalls);
  }

  return sortSubagents(
    allSubagents.filter((subagent) => subagent.hasModelActivity)
  );
};
