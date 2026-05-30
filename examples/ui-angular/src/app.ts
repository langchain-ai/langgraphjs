import { Component, computed, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { injectStream } from "@langchain/angular";
import type { Message } from "@langchain/langgraph-sdk";

@Component({
  selector: "app-root",
  imports: [FormsModule],
  template: `
    <main class="chat-shell" [class.light]="theme() === 'light'">
      <button
        class="theme-toggle"
        type="button"
        [attr.aria-label]="
          theme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
        "
        (click)="toggleTheme()"
      >
        @if (theme() === "dark") {
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="4" />
            <path
              d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
            />
          </svg>
        } @else {
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path
              class="moon-shape"
              d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"
            />
          </svg>
        }
      </button>

      <section class="hero-card">
        <div class="framework-logo" aria-label="Angular logo" role="img">
          <svg viewBox="0 0 128 128">
            <defs>
              <linearGradient
                id="angular-gradient-a"
                x1="14.704"
                x2="110.985"
                y1="83.73"
                y2="37.976"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stop-color="#e40035" />
                <stop offset=".24" stop-color="#f60a48" />
                <stop offset=".352" stop-color="#f20755" />
                <stop offset=".494" stop-color="#dc087d" />
                <stop offset=".745" stop-color="#9717e7" />
                <stop offset="1" stop-color="#6c00f5" />
              </linearGradient>
              <linearGradient
                id="angular-gradient-b"
                x1="28.733"
                x2="91.742"
                y1="12.929"
                y2="84.805"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stop-color="#ff31d9" />
                <stop offset="1" stop-color="#ff5be1" stop-opacity="0" />
              </linearGradient>
            </defs>
            <path
              fill="url(#angular-gradient-a)"
              d="m124.5 21.3-4.4 68.6L78.3 0l46.2 21.3zm-29 88.7L64 128l-31.5-18 6.4-15.5h50.3l6.3 15.5zM64 34.1l16.5 40.2h-33L64 34.1zM7.9 89.9 3.5 21.3 49.7 0 7.9 89.9z"
            />
            <path
              fill="url(#angular-gradient-b)"
              d="m124.5 21.3-4.4 68.6L78.3 0l46.2 21.3zm-29 88.7L64 128l-31.5-18 6.4-15.5h50.3l6.3 15.5zM64 34.1l16.5 40.2h-33L64 34.1zM7.9 89.9 3.5 21.3 49.7 0 7.9 89.9z"
            />
          </svg>
        </div>
        <div class="eyebrow">langgraph streaming</div>
        <div class="hero-copy">
          <h1>Angular Chat</h1>
          <p>
            A compact chat example powered by <code>@langchain/angular</code>
            and the streaming state exposed by <code>injectStream</code>.
          </p>
        </div>
      </section>

      <section class="chat-card" aria-label="Chat messages">
        @if (visibleMessages().length === 0) {
          <div class="empty-state">Ask the agent about LangGraph streaming.</div>
        }

        @for (message of visibleMessages(); track message.id ?? $index) {
          <div class="message" [class.user]="message.type === 'human'">
            <span>{{ getMessageRole(message.type) }}</span>
            <p>{{ message.text }}</p>
          </div>
        }

        @if (
          visibleMessages().length === 0 &&
          !stream.isLoading() &&
          stream.error()
        ) {
          <div class="error">
            Could not reach the LangGraph server. Check that
            <code>pnpm dev</code> is running, then try again.
          </div>
        }
      </section>

      <form class="composer" (ngSubmit)="onSubmit()">
        <textarea
          aria-label="Message"
          name="message"
          placeholder="Ask a follow-up..."
          rows="3"
          [ngModel]="message()"
          (ngModelChange)="message.set($event)"
        ></textarea>
        <button
          type="submit"
          [disabled]="message().trim() === ''"
        >
          Send
        </button>
      </form>
    </main>
  `,
})
export class App {
  protected readonly message = signal("");
  protected readonly theme = signal<"dark" | "light">("dark");

  protected stream = injectStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });
  protected readonly visibleMessages = computed(() =>
    this.stream.messages().filter((message) => message != null)
  );

  protected toggleTheme() {
    this.theme.update((current) => (current === "dark" ? "light" : "dark"));
  }

  protected getMessageRole(type: string) {
    return type === "human" ? "You" : "Assistant";
  }

  protected onSubmit() {
    const content = this.message().trim();
    if (content.length === 0) return;

    const newMessage = { content, type: "human" };
    void this.stream.submit(
      { messages: [newMessage] },
      {
        optimisticValues: (prev) => ({
          ...prev,
          messages: [...((prev["messages"] ?? []) as Message[]), newMessage],
        }),
      }
    );

    this.message.set("");
  }
}
