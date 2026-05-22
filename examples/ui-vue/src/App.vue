<script setup lang="ts">
import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "@langchain/vue";
import { computed, ref } from "vue";

const input = ref("");
const theme = ref<"dark" | "light">("dark");
const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
const visibleMessages = computed(() =>
  stream.messages.value.filter((message) => message != null)
);

function getMessageRole(type: string) {
  return type === "human" ? "You" : "Assistant";
}

function handleSubmit() {
  const content = input.value.trim();
  if (content.length === 0) return;

  const newMessage = { content, type: "human" };

  void stream.submit(
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
  <main class="chat-shell" :class="{ light: theme === 'light' }">
    <button
      class="theme-toggle"
      type="button"
      :aria-label="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
      @click="theme = theme === 'dark' ? 'light' : 'dark'"
    >
      <svg
        v-if="theme === 'dark'"
        aria-hidden="true"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
        />
      </svg>
      <svg v-else aria-hidden="true" viewBox="0 0 24 24">
        <path class="moon-shape" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      </svg>
    </button>

    <section class="hero-card">
      <div class="framework-logo" aria-label="Vue logo" role="img">
        <svg viewBox="0 0 128 128">
          <path
            d="M25.997 9.393l23.002.009L64.035 34.36 79.018 9.404 102 9.398 64.15 75.053z"
            fill="#35495e"
          />
          <path
            d="M.91 9.569l25.067-.172 38.15 65.659L101.98 9.401l25.11.026-62.966 108.06z"
            fill="#41b883"
          />
        </svg>
      </div>
      <div class="eyebrow">langgraph streaming</div>
      <div class="hero-copy">
        <h1>Vue Chat</h1>
        <p>
          A compact chat example powered by <code>@langchain/vue</code> and the
          streaming state exposed by <code>useStream</code>.
        </p>
      </div>
    </section>

    <section class="chat-card" aria-label="Chat messages">
      <div v-if="visibleMessages.length === 0" class="empty-state">
        Ask the agent about LangGraph streaming.
      </div>

      <div
        v-for="(message, index) in visibleMessages"
        :key="message.id ?? index"
        class="message"
        :class="{ user: message.type === 'human' }"
      >
        <span>{{ getMessageRole(message.type) }}</span>
        <p>{{ message.text }}</p>
      </div>

      <div
        v-if="visibleMessages.length === 0 && !stream.isLoading && stream.error"
        class="error"
      >
        Could not reach the LangGraph server. Check that
        <code>pnpm dev</code> is running, then try again.
      </div>
    </section>

    <form class="composer" @submit.prevent="handleSubmit">
      <textarea
        v-model="input"
        aria-label="Message"
        placeholder="Ask a follow-up..."
        rows="3"
      />
      <button type="submit" :disabled="input.trim() === ''">
        Send
      </button>
    </form>
  </main>
</template>

<style scoped>
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
