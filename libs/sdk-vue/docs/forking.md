# Forking from a message (branching)

The legacy `branch` / `setBranch` / `fetchStateHistory` trio has been
replaced by **per-message metadata + `submit({ forkFrom })`**.

Mount `useMessageMetadata` next to the message you want to fork
from, read its `parentCheckpointId`, and pass it to `submit`:

```vue
<script setup lang="ts">
import { computed, type PropType } from "vue";
import type { BaseMessage } from "@langchain/core/messages";
import { useMessageMetadata, useStreamContext } from "@langchain/vue";

const props = defineProps({
  message: { type: Object as PropType<BaseMessage>, required: true },
});

const stream = useStreamContext();
const messageId = computed(() => props.message.id);
const metadata = useMessageMetadata(stream, messageId);

function editFromHere() {
  const checkpointId = metadata.value?.parentCheckpointId;
  if (!checkpointId) return;
  void stream.submit(
    { messages: [{ type: "human", content: "…revised prompt…" }] },
    { forkFrom: { checkpointId } },
  );
}
</script>

<template>
  <button
    :disabled="!metadata?.parentCheckpointId"
    @click="editFromHere"
  >
    Edit from here
  </button>
</template>
```

## Notes

- `useMessageMetadata(stream, msgId)` accepts a plain value, a ref,
  or a getter — change the id and it rebinds to the new message.
- `parentCheckpointId` is `undefined` for messages whose parent
  checkpoint hasn't been reported yet (e.g. optimistic messages
  before the server has responded). Disable the "edit" affordance
  while it's missing.
- Each `forkFrom` submit spawns a new run against the parent
  checkpoint without discarding the existing thread history on the
  server side.
