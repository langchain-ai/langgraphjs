import type {
  CompiledGraphType,
  ProtocolEvent,
  StreamChannel,
  StreamTransformer,
} from "@langchain/langgraph";
import type {
  Command,
  CommandResponse,
  ErrorResponse,
  SubscribeParams,
} from "@langchain/protocol";

import type { A2AStreamEvent } from "./transformer.js";

/**
 * Compiled graph shape used by this example server.
 *
 * The graph is configured with an A2A stream transformer that emits a
 * `StreamChannel.remote("a2a")` projection. LangGraph's v3 stream machinery
 * forwards that remote projection into the Agent Streaming Protocol event log
 * as a non-standard event method, which {@link normalizeEvent} maps onto the
 * protocol's `custom:<name>` subscription convention.
 *
 * @see https://github.com/langchain-ai/agent-protocol/tree/main/streaming
 */
export type LocalProtocolGraph = CompiledGraphType<{
  streamTransformers: [
    StreamTransformer<{ a2a: StreamChannel<A2AStreamEvent> }>,
  ];
}>;

/**
 * Event methods defined by the Agent Streaming Protocol CDDL.
 *
 * These methods map directly to subscription channels such as `messages`,
 * `values`, `tools`, `lifecycle`, and `tasks`. Any other method is treated as
 * a custom extension stream and wrapped into the protocol's `custom` event
 * envelope, where `params.data.name` carries the extension channel name and
 * `params.data.payload` carries the original payload.
 *
 * @see /streaming/protocol.cddl in langchain-ai/agent-protocol
 */
const PROTOCOL_METHODS = new Set([
  "values",
  "checkpoints",
  "updates",
  "messages",
  "tools",
  "custom",
  "lifecycle",
  "input.requested",
  "tasks",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Compare a subscription namespace segment with an emitted event namespace.
 *
 * The Agent Streaming Protocol models `namespace` as a hierarchical path where
 * `[]` is the root graph and child arrays identify nested agents or subgraphs.
 * LangGraph namespace segments can include dynamic suffixes after `:`. A
 * filter segment without a suffix intentionally matches the static prefix, so
 * a filter for `"agent"` matches emitted segments like `"agent:run-uuid"`.
 */
function segmentMatches(filterSegment: string, eventSegment: string) {
  if (filterSegment.includes(":")) return filterSegment === eventSegment;
  return eventSegment.split(":")[0] === filterSegment;
}

/**
 * Infer the Agent Protocol subscription channel for an event.
 *
 * Most protocol methods are already channel names. The exception is custom
 * extension traffic: per the SDK convention, a `custom` event whose payload is
 * `{ name, payload }` is addressable through the named channel
 * `custom:<name>`, while subscribing to `custom` receives all custom events.
 */
function getEventChannel(event: ProtocolEvent) {
  if (event.method !== "custom") return event.method;
  const data = event.params.data;
  return isRecord(data) && typeof data.name === "string"
    ? `custom:${data.name}`
    : "custom";
}

/**
 * Return whether an event should be delivered to a connection-scoped SSE
 * subscription.
 *
 * In the Agent Streaming Protocol, `POST /threads/:thread_id/stream` opens an
 * SSE connection whose request body is a filtered subscription. The key fields
 * are:
 *
 * - `channels`: event concerns such as `messages`, `values`, `tools`,
 *   `lifecycle`, or named custom channels like `custom:a2a`.
 * - `namespaces`: namespace prefixes that scope delivery to the root graph,
 *   a subgraph, or a nested child.
 * - `depth`: optional maximum distance below a matched namespace prefix.
 *
 * This example implements the same matching server-side so the stock
 * `HttpAgentServerAdapter` can rotate and replay filtered streams without a
 * custom browser transport.
 */
function matchesSubscription(event: ProtocolEvent, params: SubscribeParams) {
  const channel = getEventChannel(event);
  if (
    params.channels?.length &&
    !params.channels.includes(channel as SubscribeParams["channels"][number]) &&
    !(channel.startsWith("custom:") && params.channels.includes("custom"))
  ) {
    return false;
  }

  if (!params.namespaces?.length) return true;

  const namespace = Array.isArray(event.params.namespace)
    ? event.params.namespace
    : [];

  return params.namespaces.some((prefix) => {
    if (prefix.length > namespace.length) return false;
    const prefixMatches = prefix.every((segment, index) =>
      segmentMatches(segment, namespace[index] ?? "")
    );
    if (!prefixMatches) return false;
    return (
      params.depth == null || namespace.length - prefix.length <= params.depth
    );
  });
}

/**
 * Return whether an event is newer than the subscription replay cursor.
 *
 * Agent Protocol replay is sequence-based: clients can pass `since` to request
 * buffered events after the last sequence number they observed. This example
 * stores events in memory and compares against the protocol `seq` field when
 * present.
 */
function isAfterReplayCursor(event: ProtocolEvent, params: SubscribeParams) {
  const since = (params as SubscribeParams & { since?: unknown }).since;
  return typeof since !== "number" || (event.seq ?? -1) > since;
}

/**
 * Normalize LangGraph remote extension events into the Agent Protocol custom
 * event envelope.
 *
 * The protocol reserves `custom` as the extension method. Named custom streams
 * are represented as `method: "custom"` plus `params.data.name`, enabling
 * clients to subscribe to `custom:a2a` while still allowing broad `custom`
 * subscriptions. LangGraph `StreamChannel.remote("a2a")` emits method `"a2a"`;
 * this helper adapts that stream into the documented envelope.
 */
function normalizeEvent(event: ProtocolEvent): ProtocolEvent {
  if (PROTOCOL_METHODS.has(event.method)) return event;

  return {
    ...event,
    method: "custom",
    params: {
      ...event.params,
      data: {
        name: event.method,
        payload: event.params.data,
      },
    },
  } as ProtocolEvent;
}

/**
 * Encode an Agent Protocol event as a Server-Sent Event frame.
 *
 * SSE delivery uses a JSON protocol event in `data:`. When available,
 * `event_id` is mirrored into the SSE `id:` field for transport-level
 * reconnection. The SDK primarily deduplicates by `event_id` and replays by
 * `seq`; if an event has no `event_id`, this example falls back to `seq` as a
 * stable frame id.
 */
function encodeSse(event: ProtocolEvent) {
  const eventId = (event as { event_id?: string }).event_id;
  const id = eventId ?? (typeof event.seq === "number" ? `${event.seq}` : "");
  const idLine = id ? `id: ${id}\n` : "";
  return new TextEncoder().encode(
    `${idLine}event: message\ndata: ${JSON.stringify(event)}\n\n`
  );
}

/**
 * Minimal in-memory Agent Streaming Protocol session for the local demo.
 *
 * This class is the server-side counterpart to `HttpAgentServerAdapter`.
 * It implements the SSE/HTTP transport model documented by the Agent
 * Streaming Protocol:
 *
 * - `POST /threads/:thread_id/commands` sends a JSON `Command` and receives a
 *   `CommandResponse` or `ErrorResponse`.
 * - `POST /threads/:thread_id/stream` opens a connection-scoped SSE
 *   subscription described by `SubscribeParams`.
 * - Events are buffered by `seq` and replayed to later subscriptions, enabling
 *   the SDK to rotate streams as subscriptions widen or narrow.
 *
 * The implementation is intentionally small and process-local. It is suitable
 * for this example and for understanding the protocol shape, but production
 * servers should persist threads, enforce concurrency policies, and coordinate
 * replay buffers across workers.
 *
 * @see https://github.com/langchain-ai/agent-protocol/tree/main/streaming
 */
export class LocalThreadSession {
  readonly #graph: LocalProtocolGraph;
  readonly #buffer: ProtocolEvent[] = [];
  readonly #sinks = new Set<{
    params: SubscribeParams;
    controller: ReadableStreamDefaultController<Uint8Array>;
  }>();

  #activeRun:
    | {
        abort(reason?: unknown): void;
      }
    | undefined;

  constructor(graph: LocalProtocolGraph) {
    this.#graph = graph;
  }

  /**
   * Handle a thread command sent to the Agent Protocol `/commands` endpoint.
   *
   * The SDK sends `run.start` to start or resume a graph run on the current
   * thread. This demo starts the LangGraph in-process v3 stream and immediately
   * returns a success response containing a generated `run_id`, while streamed
   * events flow asynchronously through active `/stream` subscriptions.
   *
   * Other Agent Protocol commands, such as subscription commands used by the
   * WebSocket transport, are rejected here because SSE subscriptions are carried
   * by independent HTTP connections rather than in-band commands.
   */
  async handleCommand(
    command: Command
  ): Promise<CommandResponse | ErrorResponse> {
    if (command.method !== "run.start") {
      return {
        type: "error",
        id: command.id,
        error: "unknown_command",
        message: `Unsupported command: ${command.method}`,
      } as ErrorResponse;
    }

    const params = isRecord(command.params)
      ? (command.params as { input?: unknown })
      : {};
    void this.#startRun(params.input);

    return {
      type: "success",
      id: command.id,
      result: { run_id: crypto.randomUUID() },
    } as CommandResponse;
  }

  /**
   * Open a connection-scoped SSE subscription for this thread.
   *
   * The returned `ReadableStream` first replays buffered events matching the
   * requested `channels`, `namespaces`, `depth`, and optional `since` cursor,
   * then stays attached for live events. Closing the HTTP connection removes
   * the sink, matching the Agent Protocol SSE unsubscribe model.
   */
  stream(params: SubscribeParams) {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const sink = { params, controller };
        this.#sinks.add(sink);

        for (const event of this.#buffer) {
          if (
            isAfterReplayCursor(event, params) &&
            matchesSubscription(event, params)
          ) {
            controller.enqueue(encodeSse(event));
          }
        }
      },
      cancel: () => {
        for (const sink of this.#sinks) {
          if (sink.params === params) {
            this.#sinks.delete(sink);
          }
        }
      },
    });
  }

  async #startRun(input: unknown) {
    this.#activeRun?.abort("Starting a new run.");
    const run = await this.#graph.streamEvents(input, { version: "v3" });
    this.#activeRun = run;

    try {
      for await (const rawEvent of run) {
        this.#publish(normalizeEvent(rawEvent));
      }
    } catch (error) {
      console.error(error);
    } finally {
      if (this.#activeRun === run) {
        this.#activeRun = undefined;
      }
    }
  }

  #publish(event: ProtocolEvent) {
    this.#buffer.push(event);
    const chunk = encodeSse(event);

    for (const sink of this.#sinks) {
      if (matchesSubscription(event, sink.params)) {
        sink.controller.enqueue(chunk);
      }
    }
  }
}
