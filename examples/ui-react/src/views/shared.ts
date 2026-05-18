import { useMemo } from "react";

import {
  useChannel,
  type AnyStream,
  type Channel,
  type Event,
} from "@langchain/react";

import type { TraceEntry } from "../components/ProtocolPlayground.types";
import { formatNamespace, isRecord } from "../utils";

const ROOT_CHANNELS: readonly Channel[] = ["values", "tools", "lifecycle"];

/**
 * Subscribe to the last N raw protocol events on a thread and project
 * them into trace entries for the sidebar log. `useChannel` is
 * ref-counted, so mounting this hook in several views on the same
 * channel + namespace pair shares one server subscription.
 */
export function useEventTrace(
  stream: unknown,
  options: { channels?: readonly Channel[]; bufferSize?: number } = {}
): TraceEntry[] {
  const channels = options.channels ?? ROOT_CHANNELS;
  const events = useChannel(stream as AnyStream, channels, undefined, {
    bufferSize: options.bufferSize ?? 120,
  });
  return useMemo(() => toTraceEntries(events), [events]);
}

function toTraceEntries(events: Event[]): TraceEntry[] {
  const entries: TraceEntry[] = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const entry = entryFromEvent(events[i], i);
    if (entry != null) entries.push(entry);
  }
  return entries.slice(0, 20);
}

function entryFromEvent(event: Event, index: number): TraceEntry | null {
  const namespace = [...event.params.namespace];
  const ns = formatNamespace(namespace);

  if (event.method === "tools") {
    return build(index, "tool", toolLabel(event.params.data), `${ns}`, {
      data: event.params.data,
      namespace,
    });
  }
  if (event.method === "values") {
    const data = event.params.data;
    const keys = isRecord(data) ? Object.keys(data) : [];
    const label =
      keys.length > 0 ? `Updated ${keys.join(", ")}` : "Updated state";
    return build(index, "update", label, `Namespace: ${ns}`, {
      data,
      namespace,
    });
  }
  if (event.method === "lifecycle") {
    const data = event.params.data;
    const phase =
      isRecord(data) && typeof data.event === "string" ? data.event : "event";
    return build(
      index,
      "lifecycle",
      `Lifecycle: ${phase}`,
      `Namespace: ${ns}`,
      { data, namespace }
    );
  }

  return null;
}

function toolLabel(data: unknown): string {
  if (!isRecord(data) || typeof data.event !== "string") return "Tool event";
  const name = typeof data.name === "string" ? data.name : "tool";
  switch (data.event) {
    case "on_tool_start":
      return `Started ${name}`;
    case "on_tool_end":
      return `Finished ${name}`;
    case "on_tool_error":
      return `Errored ${name}`;
    default:
      return `${data.event} ${name}`;
  }
}

function build(
  index: number,
  kind: string,
  label: string,
  detail: string,
  raw: unknown
): TraceEntry {
  return {
    id: `event-${index}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    label,
    detail,
    timestamp: new Date().toLocaleTimeString(),
    raw,
  };
}
