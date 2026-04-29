<script lang="ts">
  import { useChannel, useExtension, useStream, useValues } from "../../index.js";

  interface Props {
    apiUrl: string;
  }

  interface StreamState {
    messages: unknown[];
  }

  const { apiUrl }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream<StreamState>({
    assistantId: "customChannelAgent",
    apiUrl,
  });

  const extension = useExtension<{ label: string; params?: unknown }>(
    stream,
    "status",
  );
  const customEvents = useChannel(stream, ["custom"]);
  const values = useValues<StreamState>(stream);

  const extensionJson = $derived(
    extension.current == null ? "" : JSON.stringify(extension.current),
  );
</script>

<div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="extension-label">{extension.current?.label ?? ""}</div>
  <div data-testid="extension-json">{extensionJson}</div>
  <div data-testid="custom-event-count">{customEvents.current.length}</div>
  <div data-testid="custom-event-types">
    {customEvents.current.map((event) => event.method ?? "").join(",")}
  </div>
  <div data-testid="values-message-count">{values.current?.messages?.length ?? 0}</div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { messages: [{ type: "human", content: "Trigger custom writer" }] } as any,
      )}
  >
    Submit
  </button>
</div>
