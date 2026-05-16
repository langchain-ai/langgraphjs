import { Component, effect, signal } from "@angular/core";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { inject } from "vitest";
import { injectStream } from "../../inject-stream.js";
import {
  injectChannel,
  injectExtension,
  injectValues,
} from "../../selectors.js";

const serverUrl = inject("serverUrl");

interface StreamState {
  messages: BaseMessage[];
}

@Component({
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="extension-label">{{ extension()?.label ?? "" }}</div>
      <div data-testid="extension-json">{{ extensionJson() }}</div>
      <div data-testid="custom-event-count">{{ customEvents().length }}</div>
      <div data-testid="custom-event-types">{{ customEventTypes() }}</div>
      <div data-testid="values-message-count">
        {{ values().messages.length }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class ExtensionSelectorsStreamComponent {
  readonly stream = injectStream<StreamState>({
    assistantId: "customChannelAgent",
    apiUrl: serverUrl,
    initialValues: { messages: [] },
  });

  readonly extension = injectExtension<{ label: string; params?: unknown }>(
    this.stream,
    "status",
  );

  readonly customEvents = injectChannel(this.stream, ["custom"]);

  readonly values = injectValues(this.stream);

  customEventTypes(): string {
    return this.customEvents()
      .map((event) => event.method ?? "")
      .join(",");
  }

  extensionJson(): string {
    const extension = this.extension();
    if (extension == null) return "";
    return JSON.stringify(extension);
  }

  onSubmit(): void {
    void this.stream.submit({
      messages: [new HumanMessage("Trigger custom writer")],
    });
  }
}

@Component({
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? "Loading..." : "Not loading" }}
      </div>
      <div data-testid="extension-label">{{ extension()?.label ?? "" }}</div>
      <div data-testid="extension-json">{{ extensionJson() }}</div>
      <div data-testid="extension-count">{{ extensionCount() }}</div>
      <div data-testid="values-message-count">
        {{ values().messages.length }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
    </div>
  `,
})
export class NamedExtensionSelectorsStreamComponent {
  readonly stream = injectStream<StreamState>({
    assistantId: "namedCustomChannelAgent",
    apiUrl: serverUrl,
    initialValues: { messages: [] },
  });

  readonly extension = injectExtension<{ label: string; params?: unknown }>(
    this.stream,
    "status",
  );

  readonly values = injectValues(this.stream);
  readonly extensionCount = signal(0);

  constructor() {
    effect(() => {
      if (this.extension() == null) return;
      this.extensionCount.update((count) => count + 1);
    });
  }

  extensionJson(): string {
    const extension = this.extension();
    if (extension == null) return "";
    return JSON.stringify(extension);
  }

  onSubmit(): void {
    void this.stream.submit({
      messages: [new HumanMessage("Trigger named custom writer")],
    });
  }
}
