<script lang="ts">
  import type { Message } from "@langchain/langgraph-sdk";
  import { useStream } from "@langchain/svelte";

  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  let content = $state("");
  let theme = $state<"dark" | "light">("dark");
  const visibleMessages = $derived(
    stream.messages.filter((message) => message != null)
  );

  function getMessageRole(type: string) {
    return type === "human" ? "You" : "Assistant";
  }

  function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    const nextContent = content.trim();
    if (nextContent.length === 0) return;

    stream.submit(
      { messages: [{ content: nextContent, type: "human" }] },
      {
        optimisticValues: (prev) => ({
          ...prev,
          messages: [
            ...((prev.messages ?? []) as Message[]),
            { content: nextContent, type: "human" },
          ],
        }),
      }
    );
    content = "";
  }
</script>

<main class:light={theme === "light"} class="chat-shell">
  <button
    aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    class="theme-toggle"
    type="button"
    onclick={() => (theme = theme === "dark" ? "light" : "dark")}
  >
    {#if theme === "dark"}
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
        />
      </svg>
    {:else}
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path class="moon-shape" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      </svg>
    {/if}
  </button>

  <section class="hero-card">
    <div class="framework-logo" aria-label="Svelte logo" role="img">
      <svg viewBox="0 0 128 128">
        <path
          d="M110.43 16.94C98.55-.08 75.09-5.12 58.13 5.7l-29.79 19c-4.03 2.53-7.49 5.87-10.15 9.81a31.58 31.58 0 0 0-5.33 13.08 30.64 30.64 0 0 0-.57 6.4 35.8 35.8 0 0 0 4.16 16.73 31.4 31.4 0 0 0-5.11 12.78 30.48 30.48 0 0 0 .35 14.41 34.64 34.64 0 0 0 5.9 13.15c11.88 17.01 35.39 22.05 52.3 11.24l29.76-19c4.03-2.53 7.48-5.88 10.14-9.82a31.6 31.6 0 0 0 5.3-13.09c.38-2.11.57-4.24.57-6.39a35.68 35.68 0 0 0-4.11-16.71 31.27 31.27 0 0 0 5.11-12.77c.37-2.11.56-4.25.56-6.39a35.8 35.8 0 0 0-6.79-21.19z"
          fill="#ff3e00"
        />
        <path
          d="M55.22 112.66a34.23 34.23 0 0 1-5.95.76 23.18 23.18 0 0 1-10.97-2.7 24.02 24.02 0 0 1-8.47-7.49 21.93 21.93 0 0 1-4.08-12.74c0-1.28.11-2.56.33-3.83.18-.95.42-1.88.72-2.78l.56-1.71 1.52 1.16a44.78 44.78 0 0 0 11.66 5.83l1.1.33-.1 1.1v.58a6.63 6.63 0 0 0 1.23 3.85 6.42 6.42 0 0 0 2.54 2.29 8.26 8.26 0 0 0 3.31.84 8.25 8.25 0 0 0 1.79-.23 7.27 7.27 0 0 0 1.83-.8L82 78.03a6.3 6.3 0 0 0 2.14-2.28 6.18 6.18 0 0 0 .77-3.03 6.68 6.68 0 0 0-1.26-3.84 6.49 6.49 0 0 0-2.55-2.25 8.31 8.31 0 0 0-3.31-.81 8.25 8.25 0 0 0-1.79.23 6.94 6.94 0 0 0-1.82.8l-11.35 7.25a29.31 29.31 0 0 1-6.05 2.66c-1.95.5-3.95.76-5.95.76a23.13 23.13 0 0 1-10.97-2.7 24.03 24.03 0 0 1-8.47-7.48 21.93 21.93 0 0 1-4.08-12.74c0-1.29.11-2.57.33-3.83a20.32 20.32 0 0 1 3.2-7.87 22.37 22.37 0 0 1 6.09-5.91l29.79-18.99a29.23 29.23 0 0 1 6.05-2.67 34.3 34.3 0 0 1 5.95-.75 23.3 23.3 0 0 1 11 2.68 24.08 24.08 0 0 1 8.5 7.49 21.92 21.92 0 0 1 4.03 12.75c0 1.29-.11 2.57-.33 3.84-.18.95-.42 1.88-.72 2.78l-.56 1.71-1.52-1.11a44.82 44.82 0 0 0-11.66-5.84l-1.1-.34.1-1.11v-.57a6.65 6.65 0 0 0-1.23-3.86 6.49 6.49 0 0 0-2.55-2.25 8.3 8.3 0 0 0-3.3-.81 8.22 8.22 0 0 0-1.77.27 6.82 6.82 0 0 0-1.83.8L46.18 48a7.07 7.07 0 0 0-1.84 1.79 5.71 5.71 0 0 0-.96 2.38 6.06 6.06 0 0 0-.14 1.1c0 1.38.43 2.72 1.23 3.84a6.48 6.48 0 0 0 2.55 2.25 8.3 8.3 0 0 0 3.3.81 8.25 8.25 0 0 0 1.79-.23 6.94 6.94 0 0 0 1.83-.8l11.37-7.29a29.13 29.13 0 0 1 6.05-2.66 34.3 34.3 0 0 1 5.95-.76 23.2 23.2 0 0 1 10.97 2.7 24.05 24.05 0 0 1 8.47 7.48 21.93 21.93 0 0 1 4.08 12.74c0 1.3-.11 2.6-.34 3.87a20.34 20.34 0 0 1-3.19 7.87 22.35 22.35 0 0 1-6.09 5.91l-29.74 18.99a29.23 29.23 0 0 1-6.06 2.67z"
          fill="#f2faff"
        />
      </svg>
    </div>
    <div class="eyebrow">langgraph streaming</div>
    <div class="hero-copy">
      <h1>Svelte Chat</h1>
      <p>
        A compact chat example powered by <code>@langchain/svelte</code> and the
        streaming state exposed by <code>useStream</code>.
      </p>
    </div>
  </section>

  <section class="chat-card" aria-label="Chat messages">
    {#if visibleMessages.length === 0}
      <div class="empty-state">Ask the agent about LangGraph streaming.</div>
    {/if}

    {#each visibleMessages as message}
      <div class:user={message.type === "human"} class="message">
        <span>{getMessageRole(message.type)}</span>
        <p>{message.text}</p>
      </div>
    {/each}

    {#if visibleMessages.length === 0 && !stream.isLoading && stream.error}
      <div class="error">
        Could not reach the LangGraph server. Check that <code>pnpm dev</code>
        is running, then try again.
      </div>
    {/if}
  </section>

  <form class="composer" onsubmit={handleSubmit}>
    <textarea
      aria-label="Message"
      name="content"
      placeholder="Ask a follow-up..."
      rows="3"
      bind:value={content}
    ></textarea>
    <button type="submit" disabled={content.trim() === ""}>
      Send
    </button>
  </form>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #030710;
    font-family:
      Inter,
      ui-sans-serif,
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;
  }

  .chat-shell {
    --bg-primary: #030710;
    --bg-secondary: #0d1322;
    --bg-card: #161f34;
    --text-primary: #f2faff;
    --text-secondary: #99d3ff;
    --accent: #7fc8ff;
    --accent-bright: #006ddd;

    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 22px;
    min-height: 100vh;
    padding: 48px;
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .chat-shell.light {
    --bg-primary: #f2faff;
    --bg-secondary: #e5f4ff;
    --bg-card: #cce9ff;
    --text-primary: #030710;
    --text-secondary: #161f34;
    --accent: #7fc8ff;
    --accent-bright: #006ddd;
  }

  .hero-card,
  .chat-card,
  .composer {
    box-sizing: border-box;
    width: min(920px, 100%);
    margin: 0 auto;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: 28px;
    background: var(--bg-secondary);
  }

  .hero-card {
    position: relative;
    display: grid;
    grid-template-columns: 1fr;
    gap: 24px;
    padding: 32px 112px 32px 32px;
  }

  .framework-logo {
    position: absolute;
    top: 28px;
    right: 28px;
    display: grid;
    width: 58px;
    height: 58px;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: 18px;
    background: var(--bg-card);
  }

  .framework-logo svg {
    width: 34px;
    height: 34px;
  }

  .eyebrow,
  .message span,
  .error,
  .composer button {
    font-family:
      "IBM Plex Mono",
      ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    letter-spacing: -0.02em;
  }

  .eyebrow {
    grid-column: 1 / -1;
    color: var(--accent);
    font-size: 0.78rem;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(2.8rem, 8vw, 6rem);
    font-weight: 300;
    letter-spacing: -0.04em;
    line-height: 0.95;
  }

  p {
    margin: 0;
  }

  .hero-copy p {
    max-width: 620px;
    margin-top: 18px;
    color: var(--text-secondary);
    font-size: 1.05rem;
    line-height: 1.55;
  }

  code {
    font-family:
      "IBM Plex Mono",
      ui-monospace,
      monospace;
  }

  .composer button {
    align-self: start;
    border: 0;
    border-radius: 999px;
    background: var(--accent);
    color: #030710;
    cursor: pointer;
    padding: 12px 18px;
  }

  .theme-toggle {
    position: fixed;
    top: 24px;
    right: 24px;
    z-index: 10;
    display: grid;
    width: 44px;
    height: 44px;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: 999px;
    background: var(--bg-secondary);
    color: var(--accent);
    cursor: pointer;
    padding: 0;
  }

  .theme-toggle svg {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.8;
  }

  .theme-toggle svg circle {
    fill: currentColor;
    stroke: none;
  }

  .theme-toggle .moon-shape {
    stroke: #7fc8ff;
    stroke-width: 2.2;
  }

  .light .theme-toggle {
    color: #030710;
  }

  .chat-card {
    min-height: 360px;
    padding: 28px;
  }

  .empty-state {
    color: var(--text-secondary);
  }

  .message {
    max-width: 74%;
    margin-bottom: 16px;
    padding: 18px;
    border-radius: 22px;
    background: var(--bg-card);
  }

  .message.user {
    margin-left: auto;
    background: var(--accent);
    color: #030710;
  }

  .message span {
    display: block;
    margin-bottom: 8px;
    color: inherit;
    font-size: 0.72rem;
    text-transform: uppercase;
  }

  .message p {
    white-space: pre-wrap;
    line-height: 1.5;
  }

  .error {
    color: var(--text-secondary);
  }

  .composer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 16px;
    padding: 18px;
  }

  textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 84px;
    resize: vertical;
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: 18px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font: inherit;
    line-height: 1.5;
    padding: 16px;
  }

  textarea::placeholder {
    color: var(--text-secondary);
  }

  .composer button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  @media (max-width: 720px) {
    .chat-shell {
      padding: 24px;
    }

    .hero-card,
    .composer {
      grid-template-columns: 1fr;
    }

    .hero-card {
      padding: 96px 24px 24px;
    }

    .framework-logo {
      top: 24px;
      left: 24px;
      right: auto;
    }

    .message {
      max-width: 100%;
    }
  }
</style>
