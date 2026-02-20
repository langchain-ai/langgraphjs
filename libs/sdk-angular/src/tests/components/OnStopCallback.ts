import { Component } from "@angular/core";
import { inject } from "vitest";
import { useStream } from "../../index.js";

const serverUrl = inject("serverUrl");

@Component({
  standalone: true,
  template: `
    <div>
      <div data-testid="onstop-called">{{ onStopCalled ? 'Yes' : 'No' }}</div>
      <div data-testid="has-mutate">{{ hasMutate ? 'Yes' : 'No' }}</div>
      <button data-testid="submit" (click)="onSubmit()">Send</button>
      <button data-testid="stop" (click)="onStopClick()">Stop</button>
    </div>
  `,
})
export class OnStopCallbackComponent {
  onStopCalled = false;

  hasMutate = false;

  stream = useStream({
    assistantId: "agent",
    apiUrl: serverUrl,
    onStop: (arg: any) => {
      this.onStopCalled = true;
      this.hasMutate = typeof arg?.mutate === "function";
    },
  });

  onSubmit() {
    void this.stream.submit({} as any);
  }

  onStopClick() {
    void this.stream.stop();
  }
}
