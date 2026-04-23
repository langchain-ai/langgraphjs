<script lang="ts">
  import type { SubagentDiscoverySnapshot } from "@langchain/langgraph-sdk/stream";
  import {
    useMessages,
    useToolCalls,
    type AnyStream,
  } from "../../index.js";

  interface Props {
    stream: AnyStream;
    subagent: SubagentDiscoverySnapshot;
  }

  const { stream, subagent }: Props = $props();

  /* eslint-disable svelte/valid-compile */
  // svelte-ignore state_referenced_locally
  const messages = useMessages(stream, subagent);
  // svelte-ignore state_referenced_locally
  const toolCalls = useToolCalls(stream, subagent);

  // svelte-ignore state_referenced_locally
  const testId = `subagent-${subagent.name}`;
  // svelte-ignore state_referenced_locally
  const namespaceKey = subagent.namespace.join("/");
  /* eslint-enable svelte/valid-compile */
</script>

<div data-testid={testId}>
  <div data-testid={`${testId}-status`}>{subagent.status}</div>
  <div data-testid={`${testId}-namespace`}>{namespaceKey}</div>
  <div data-testid={`${testId}-messages-count`}>{messages.current.length}</div>
  <div data-testid={`${testId}-toolcalls-count`}>
    {toolCalls.current.length}
  </div>
  <div data-testid={`${testId}-toolcall-names`}>
    {toolCalls.current.map((tc) => tc.name).join(",")}
  </div>
</div>
