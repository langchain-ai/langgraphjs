import { Component, signal } from '@angular/core';
import { useStream } from '@langchain/angular';
import { FormsModule } from '@angular/forms';
import type { Message } from '@langchain/langgraph-sdk';

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  template: `
    <main class="main">
      <div>
        @for (message of stream.messages(); track message.id) {
        <div>{{ message.content }}</div>
        }
      </div>

      <form (ngSubmit)="onSubmit()">
        <input type="text" [(ngModel)]="message" name="message" />
        <button type="submit">Submit</button>
      </form>
    </main>
  `,
})
export class App {
  protected message = signal('');

  protected stream = useStream({
    assistantId: 'agent',
    apiUrl: 'http://localhost:2024',
  });

  protected onSubmit() {
    const newMessage = { content: this.message(), type: 'human' };
    this.stream.submit(
      { messages: [newMessage] },
      {
        optimisticValues: (prev) => ({
          ...prev,
          messages: [...((prev['messages'] ?? []) as Message[]), newMessage],
        }),
      }
    );

    // reset form
    this.message.set('');
  }
}
