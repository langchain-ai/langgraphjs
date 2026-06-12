<script lang="ts">
  import {
    useStream,
    useMessages,
    useToolCalls,
    useValues,
    useChannel,
  } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream({ assistantId, apiUrl });

  const messages = useMessages(stream);
  const toolCalls = useToolCalls(stream);
  const values = useValues(stream);
  const customEvents = useChannel(stream, ["custom"]);
</script>

<div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="messages-count">{messages.current.length}</div>
  <div data-testid="messages-first">
    {messages.current[0]
      ? typeof messages.current[0].content === "string"
        ? messages.current[0].content
        : JSON.stringify(messages.current[0].content)
      : ""}
  </div>
  <div data-testid="toolcalls-count">{toolCalls.current.length}</div>
  <div data-testid="values-messages-count">
    {Array.isArray((values.current as { messages?: unknown[] }).messages)
      ? (values.current as { messages: unknown[] }).messages.length
      : 0}
  </div>
  <div data-testid="custom-event-count">{customEvents.current.length}</div>
  <div data-testid="custom-event-types">
    {customEvents.current.map((event) => event.method ?? "").join(",")}
  </div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { messages: [{ type: "human", content: "Hi" }] } as any,
      )}
  >
    Submit
  </button>
</div>
