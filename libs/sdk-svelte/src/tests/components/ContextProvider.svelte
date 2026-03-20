<script lang="ts">
  import { provideStream } from "../../index.js";
  import ContextMessageList from "./ContextMessageList.svelte";
  import ContextControls from "./ContextControls.svelte";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  provideStream({ assistantId, apiUrl });
</script>

<div>
  <ContextMessageList />
  <ContextControls />
</div>
