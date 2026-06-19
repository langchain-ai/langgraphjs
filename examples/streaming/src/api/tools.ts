/**
 * Tool channel + toolCalls projection coverage against the Python
 * `langgraph-api` server.
 *
 * Drives the ``agent_tool_stream`` fixture graph (``agent → tools →
 * agent``). On the first turn the fake chat model requests a
 * ``get_weather`` tool call; ``ToolNode`` invokes the
 * ``@tool``-decorated function, which triggers LangChain's
 * ``on_tool_start`` / ``on_tool_end`` callbacks.
 * ``langgraph_api.stream_tools.StreamToolsHandler`` picks those up and
 * publishes ``tools`` channel events; ``RunProtocolSession`` normalizes
 * them into the protocol's ``tool-started`` / ``tool-finished``
 * payloads so the SDK's ``ToolCallAssembler`` can surface an
 * ``AssembledToolCall``.
 *
 * What this exercises on the server:
 *
 *   - ``StreamToolsHandler`` attachment on the Path 2 streaming code
 *     path (``stream.py :: use_streaming_handler``).
 *   - ``tools`` channel delivery via SSE with correct ``params.node``
 *     and ``params.namespace`` propagation from
 *     ``langgraph_checkpoint_ns`` / ``langgraph_node`` metadata.
 *   - Protocol normalization in ``RunProtocolSession._handle_source_event``
 *     mapping ``on_tool_start`` → ``tool-started`` and ``on_tool_end``
 *     → ``tool-finished`` with the ``tool_call_id`` threaded through.
 *   - ``thread.toolCalls`` SDK projection producing one
 *     ``AssembledToolCall`` per ``get_weather`` invocation.
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 *   The fixture ``agent_tool_stream`` must be registered in
 *   ``api/tests/graphs/langgraph-3.13.json`` (etc). Restart the server
 *   after adding the fixture so the new assistant loads.
 *
 * Run:
 *   npx tsx src/api/tools.ts
 */

import { Client } from "@langchain/langgraph-sdk";

import { apiUrl, requireServer, short } from "./_shared.js";

interface ToolsEvent {
  seq?: number;
  method: "tools";
  params: {
    namespace: readonly string[];
    node?: string;
    data: {
      event: "tool-started" | "tool-finished" | "tool-error";
      tool_call_id: string;
      tool_name?: string;
      input?: unknown;
      output?: unknown;
      error?: string;
    };
  };
}

async function main() {
  const url = apiUrl();
  await requireServer(url);

  const thread = new Client({ apiUrl: url }).threads.stream({
    assistantId: "agent_tool_stream",
  });

  // Raw `tools` subscription — captures the wire-level payloads
  // straight off the SSE stream so we can inspect the envelope shape.
  const rawToolsSub = await thread.subscribe({
    channels: ["tools", "lifecycle"],
  });
  const rawEvents: ToolsEvent[] = [];
  const rawDrain = (async () => {
    for await (const raw of rawToolsSub) {
      const event = raw as unknown as {
        method: string;
        params: { namespace: readonly string[]; data: { event?: string } };
      };
      if (event.method === "tools") {
        rawEvents.push(raw as unknown as ToolsEvent);
      }
      if (
        event.method === "lifecycle" &&
        event.params.namespace.length === 0 &&
        ["completed", "failed", "interrupted"].includes(
          event.params.data.event ?? ""
        )
      ) {
        break;
      }
    }
  })();

  // High-level assembled tool-call projection.
  const assembled: Array<{
    name: string;
    callId: string;
    input: unknown;
    output: unknown;
  }> = [];
  const toolCallsDrain = (async () => {
    for await (const tc of thread.toolCalls) {
      const output = await tc.output;
      assembled.push({
        name: tc.name,
        callId: tc.callId,
        input: tc.input,
        output,
      });
    }
  })();

  console.log("--- Driving agent_tool_stream ---\n");
  await thread.run.start({
    input: {
      messages: [{ role: "user", content: "what is the weather?" }],
    },
  });

  await Promise.all([rawDrain, toolCallsDrain]);
  await thread.close();

  console.log(`Raw tools events (${rawEvents.length}):`);
  for (const ev of rawEvents) {
    const d = ev.params.data;
    console.log(
      `  ns=${ev.params.namespace.join("/") || "(root)"} node=${
        ev.params.node ?? "(none)"
      } event=${d.event} name=${d.tool_name ?? "?"} ` +
        `callId=${d.tool_call_id} payload=${short(
          d.output ?? d.input ?? d.error ?? ""
        )}`
    );
  }

  console.log(`\nAssembled tool calls (${assembled.length}):`);
  for (const tc of assembled) {
    console.log(
      `  name=${tc.name} callId=${tc.callId} input=${short(tc.input)} output=${short(
        tc.output
      )}`
    );
  }

  // Assertions
  const startCount = rawEvents.filter(
    (e) => e.params.data.event === "tool-started"
  ).length;
  const finishCount = rawEvents.filter(
    (e) => e.params.data.event === "tool-finished"
  ).length;
  console.log();
  console.log(
    `assertion — at least one tool-started wire event: ${
      startCount >= 1 ? "✓" : "✗"
    }`
  );
  console.log(
    `assertion — every tool-started has a matching tool-finished: ${
      finishCount === startCount ? "✓" : `✗ (${startCount} start vs ${finishCount} finish)`
    }`
  );
  const hasNodeField = rawEvents.every(
    (e) => typeof e.params.node === "string" && e.params.node.length > 0
  );
  console.log(
    `assertion — every tools event carries params.node: ${hasNodeField ? "✓" : "✗"}`
  );
  console.log(
    `assertion — toolCalls projection assembled exactly one call: ${
      assembled.length === 1 ? "✓" : `✗ (got ${assembled.length})`
    }`
  );
  const tc = assembled[0];
  const outputString = typeof tc?.output === "string" ? tc.output : String(tc?.output);
  const outputLooksRight = outputString.toLowerCase().includes("sunny");
  console.log(
    `assertion — tool output contains "sunny" (fixture reply): ${
      outputLooksRight ? "✓" : `✗ (got ${JSON.stringify(tc?.output)})`
    }`
  );
}

await main();
