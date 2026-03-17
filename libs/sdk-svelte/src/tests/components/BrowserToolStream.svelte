<script lang="ts">
  import { useStream } from "../../index.js";
  import type { BrowserTool, BrowserToolEvent } from "@langchain/langgraph-sdk";

  interface Props {
    apiUrl: string;
    execute?: BrowserTool["execute"];
  }

  const { apiUrl, execute }: Props = $props();

  let toolEvents = $state<BrowserToolEvent[]>([]);

  const defaultExecute: BrowserTool["execute"] = async (_args) => ({
    latitude: 37.7749,
    longitude: -122.4194,
  });

  const { messages, isLoading, submit } = useStream({
    assistantId: "browserToolAgent",
    apiUrl,
    browserTools: [{ name: "get_location", execute: execute ?? defaultExecute }],
    onBrowserTool: (event) => {
      toolEvents = [...toolEvents, event];
    },
  });
</script>

<div>
  <div data-testid="messages">
    {#each $messages as msg, i (msg.id ?? i)}
      <div data-testid={`message-${i}`}>
        {typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content)}
      </div>
    {/each}
    {#if $messages.length > 0}
      <div data-testid="message-last">
        {(() => {
          const last = $messages[$messages.length - 1];
          return typeof last.content === "string"
            ? last.content
            : JSON.stringify(last.content);
        })()}
      </div>
    {/if}
  </div>

  <div data-testid="loading">{$isLoading ? "loading" : "idle"}</div>

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
      void submit(
        { messages: [{ type: "human", content: "Where am I?" }] } as any,
      )}
  >
    Send
  </button>
</div>
