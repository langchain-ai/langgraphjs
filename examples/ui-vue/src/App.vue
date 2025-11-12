<script setup lang="ts">
import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "@langchain/vue";
import { ref } from "vue";

const input = ref("");
const { messages, submit } = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});

function handleSubmit() {
  const newMessage = { content: input.value, type: "human" };

  submit(
    { messages: [newMessage] },
    {
      optimisticValues: (prev) => ({
        ...prev,
        messages: [...((prev.messages ?? []) as Message[]), newMessage],
      }),
    }
  );
  input.value = "";
}
</script>

<template>
  <div v-for="message in messages">
    {{ message.content }}
  </div>

  <form @submit.prevent="handleSubmit">
    <textarea v-model="input" />
    <button type="submit">Submit</button>
  </form>
</template>
