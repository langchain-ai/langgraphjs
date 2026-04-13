import { useCallback, useState } from "react";

import type { StreamProtocol } from "@langchain/langgraph-sdk";

import type { PlaygroundTransportMode } from "../components/ProtocolSwitcher";
import type { TraceEntry } from "../components/ProtocolPlayground";
import { formatNamespace, isRecord } from "../utils";

export const API_URL =
  import.meta.env.VITE_LANGGRAPH_API_URL ?? "http://localhost:2024";

export const summarizeToolEvent = (data: unknown) => {
  if (!isRecord(data) || typeof data.event !== "string") {
    return {
      label: "Tool event",
      detail: "Received a tool lifecycle event.",
    };
  }

  switch (data.event) {
    case "on_tool_start":
      return {
        label:
          typeof data.name === "string"
            ? `Started ${data.name}`
            : "Started tool",
        detail: "The tool call has started.",
      };
    case "on_tool_end":
      return {
        label:
          typeof data.name === "string"
            ? `Finished ${data.name}`
            : "Finished tool",
        detail: "The tool call completed successfully.",
      };
    case "on_tool_error":
      return {
        label:
          typeof data.name === "string" ? `Errored ${data.name}` : "Tool error",
        detail:
          typeof data.error === "string" ? data.error : "The tool call failed.",
      };
    case "on_tool_event":
      return {
        label:
          typeof data.name === "string"
            ? `Updated ${data.name}`
            : "Tool update",
        detail: "The tool emitted an intermediate event.",
      };
    default:
      return {
        label: "Tool event",
        detail: `Received ${data.event}.`,
      };
  }
};

export const summarizeUpdateEvent = (data: unknown, namespace?: string[]) => {
  if (isRecord(data)) {
    const keys = Object.keys(data);
    return {
      label: `Updated ${keys.length > 0 ? keys.join(", ") : "state"}`,
      detail: `Namespace: ${formatNamespace(namespace)}`,
    };
  }

  return {
    label: "Updated state",
    detail: `Namespace: ${formatNamespace(namespace)}`,
  };
};

export const isProtocolTransportMode = (
  mode: PlaygroundTransportMode
): mode is Exclude<PlaygroundTransportMode, "legacy"> => mode !== "legacy";

export const getStreamProtocol = (
  mode: PlaygroundTransportMode
): StreamProtocol =>
  mode === "websocket"
    ? "v2-websocket"
    : mode === "http-sse"
      ? "v2-sse"
      : "legacy";

export const getTransportLabel = (mode: PlaygroundTransportMode) => {
  switch (mode) {
    case "legacy":
      return "legacy";
    case "websocket":
      return "v2 websocket";
    default:
      return "v2 http+sse";
  }
};

export function useTraceLog() {
  const [eventLog, setEventLog] = useState<TraceEntry[]>([]);

  const push = useCallback(
    (kind: string, label: string, detail: string, raw: unknown) => {
      const next: TraceEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        label,
        detail,
        timestamp: new Date().toLocaleTimeString(),
        raw,
      };

      setEventLog((previous) => [next, ...previous].slice(0, 20));
    },
    []
  );

  return { eventLog, push };
}
