<script lang="ts">
  import { useStream } from "../../index.js";
  import type { ToolEvent } from "@langchain/langgraph-sdk";
  import { getLocationTool } from "../fixtures/browser-fixtures.js";

  interface Props {
    apiUrl: string;
    execute?: Parameters<typeof getLocationTool.implement>[0];
  }

  const { apiUrl, execute }: Props = $props();

  let toolEvents = $state<ToolEvent[]>([]);

  const tool = getLocationTool.implement(
    execute ??
      (async () => ({
        latitude: 37.7749,
        longitude: -122.4194,
      })),
  );

  const stream = useStream({
    assistantId: "headlessToolAgent",
    apiUrl,
    tools: [tool],
    onTool: (event) => {
      toolEvents = [...toolEvents, event];
    },
  });
</script>

<div>
  <div data-testid="messages">
    {#each stream.messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
    {#if stream.messages.length > 0}
      <div data-testid="message-last">
        {(() => {
          const last = stream.messages[stream.messages.length - 1];
          return typeof last.content === "string"
            ? last.content
            : JSON.stringify(last.content);
        })()}
      </div>
    {/if}
  </div>

  <div data-testid="loading">{stream.isLoading ? "loading" : "idle"}</div>

  <div data-testid="tool-events">
    {#each toolEvents as event, i}
      <div data-testid={`tool-event-${i}`}>
        {event.phase}:{event.name}{event.phase === "error" && event.error
          ? `:${event.error.message}`
          : ""}
      </div>
    {/each}
  </div>

  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit(
        { messages: [{ type: "human", content: "Where am I?" }] } as any,
      )}
  >
    Send
  </button>
</div>
