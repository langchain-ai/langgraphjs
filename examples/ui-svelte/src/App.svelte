<script lang="ts">
  import type { Message } from "@langchain/langgraph-sdk";
  import { useStream } from "@langchain/svelte";

  const { messages, submit } = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  let content = $state("");
  function handleSubmit(event: SubmitEvent) {
    event.preventDefault();

    submit(
      { messages: [{ content, type: "human" }] },
      {
        optimisticValues: (prev) => ({
          ...prev,
          messages: [
            ...((prev.messages ?? []) as Message[]),
            { content, type: "human" },
          ],
        }),
      }
    );
  }
</script>

<main>
  <h1>Vite + Svelte</h1>

  <div>
    {#each $messages as message}
      <div>{message.content}</div>
    {/each}

    <form onsubmit={handleSubmit}>
      <textarea name="content" bind:value={content}></textarea>
      <button type="submit">Submit</button>
    </form>
  </div>
</main>
