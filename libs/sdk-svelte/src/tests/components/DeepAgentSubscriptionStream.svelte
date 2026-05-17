<script lang="ts">
  import { onDestroy } from "svelte";
  import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
  import { STREAM_CONTROLLER, useStream } from "../../index.js";
  import SubscriptionRootMessages from "./SubscriptionRootMessages.svelte";
  import SubscriptionScopedMessages from "./SubscriptionScopedMessages.svelte";
  import SubscriptionScopedToolCalls from "./SubscriptionScopedToolCalls.svelte";

  interface InitialMounts {
    rootMessages?: boolean;
    researcherMessagesA?: boolean;
    researcherMessagesB?: boolean;
    researcherToolCalls?: boolean;
    analystMessages?: boolean;
  }

  interface Props {
    apiUrl: string;
    assistantId?: string;
    initialMounts?: InitialMounts;
  }

  const {
    apiUrl,
    assistantId = "deepAgent",
    initialMounts = {},
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = useStream<{ messages: BaseMessage[] }>({
    assistantId,
    apiUrl,
  });

  // svelte-ignore state_referenced_locally
  let mounts = $state({
    rootMessages: initialMounts.rootMessages ?? false,
    researcherMessagesA: initialMounts.researcherMessagesA ?? false,
    researcherMessagesB: initialMounts.researcherMessagesB ?? false,
    researcherToolCalls: initialMounts.researcherToolCalls ?? false,
    analystMessages: initialMounts.analystMessages ?? false,
  });

  let tick = $state(0);
  const interval = setInterval(() => {
    tick += 1;
  }, 25);
  onDestroy(() => clearInterval(interval));

  const subagents = $derived(
    [...stream.subagents.values()].sort((a, b) => a.name.localeCompare(b.name)),
  );
  const researcher = $derived(
    subagents.find((subagent) => subagent.name === "researcher"),
  );
  const analyst = $derived(
    subagents.find((subagent) => subagent.name === "data-analyst"),
  );
  const registrySize = $derived.by(() => {
    void tick;
    return stream[STREAM_CONTROLLER].registry.size;
  });

  function toggle(key: keyof typeof mounts) {
    mounts = { ...mounts, [key]: !mounts[key] };
  }
</script>

<div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="subagent-count">{subagents.length}</div>
  <div data-testid="registry-size">{registrySize}</div>

  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({
        messages: [new HumanMessage("Run analysis")],
      })}
  >
    Run
  </button>

  <button
    data-testid="toggle-root-messages"
    onclick={() => toggle("rootMessages")}
  >
    Toggle root messages observer
  </button>
  <button
    data-testid="toggle-researcher-messages-a"
    onclick={() => toggle("researcherMessagesA")}
  >
    Toggle researcher messages observer A
  </button>
  <button
    data-testid="toggle-researcher-messages-b"
    onclick={() => toggle("researcherMessagesB")}
  >
    Toggle researcher messages observer B
  </button>
  <button
    data-testid="toggle-researcher-toolcalls"
    onclick={() => toggle("researcherToolCalls")}
  >
    Toggle researcher tool-calls observer
  </button>
  <button
    data-testid="toggle-analyst-messages"
    onclick={() => toggle("analystMessages")}
  >
    Toggle analyst messages observer
  </button>

  {#if mounts.rootMessages}
    <SubscriptionRootMessages {stream} />
  {/if}

  {#if mounts.researcherMessagesA && researcher}
    <SubscriptionScopedMessages
      {stream}
      subagent={researcher}
      id="researcher-a"
    />
  {/if}

  {#if mounts.researcherMessagesB && researcher}
    <SubscriptionScopedMessages
      {stream}
      subagent={researcher}
      id="researcher-b"
    />
  {/if}

  {#if mounts.researcherToolCalls && researcher}
    <SubscriptionScopedToolCalls
      {stream}
      subagent={researcher}
      id="researcher-tc"
    />
  {/if}

  {#if mounts.analystMessages && analyst}
    <SubscriptionScopedMessages {stream} subagent={analyst} id="analyst" />
  {/if}
</div>
