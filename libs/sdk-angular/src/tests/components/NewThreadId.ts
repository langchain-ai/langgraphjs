import { Component, input } from "@angular/core";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="loading">
        {{ stream.isLoading() ? 'Loading...' : 'Not loading' }}
      </div>
      <div data-testid="thread-id">Client ready</div>
      <button data-testid="submit" (click)="onSubmit()">Submit</button>
    </div>
  `,
})
export class NewThreadIdComponent {
  submitThreadId = input<string | undefined>(undefined);

  onThreadIdCb = input<((threadId: string) => void) | undefined>(undefined);

  stream = useStream({
    assistantId: "agent",
    apiUrl: serverUrl,
    threadId: null,
    onThreadId: (threadId: string) => {
      this.onThreadIdCb()?.(threadId);
    },
  });

  onSubmit() {
    void this.stream.submit(
      {} as any,
      { threadId: this.submitThreadId() }
    );
  }
}
