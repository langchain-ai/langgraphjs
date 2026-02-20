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
      <div data-testid="counter">{{ asAny(stream.values()).counter }}</div>
      <div data-testid="items">
        {{ asAny(stream.values()).items?.join(', ') }}
      </div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
      <button data-testid="stop" (click)="onStopClick()">Stop</button>
    </div>
  `,
})
export class StopFunctionalComponent {
  onStopMutate = input<(prev: any) => any>((prev) => prev);

  stream = useStream({
    assistantId: "agent",
    apiUrl: serverUrl,
    initialValues: { counter: 5, items: ["item1", "item2"] },
    onStop: ({ mutate }: any) => {
      mutate(this.onStopMutate());
    },
  });

  asAny(v: unknown): any {
    return v;
  }

  onSubmit() {
    void this.stream.submit({} as any);
  }

  onStopClick() {
    void this.stream.stop();
  }
}
