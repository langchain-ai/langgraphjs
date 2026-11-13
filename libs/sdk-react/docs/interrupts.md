# Interrupts and headless tools

An interrupt pauses a run to ask for input, such as an approval. `useStream` shows the interrupts waiting, answers them, and can answer tool calls itself, in the browser, through headless tools.

## Table of contents

- [Reading interrupts](#reading-interrupts)
- [Answering an interrupt](#answering-an-interrupt)
- [Several interrupts at once](#several-interrupts-at-once)
- [Changing state while answering](#changing-state-while-answering)
- [Late answers](#late-answers)
- [Breakpoints](#breakpoints)
- [Headless tools](#headless-tools)
- [Lower-level helpers](#lower-level-helpers)

## Reading interrupts

`stream.interrupts` lists the interrupts waiting for an answer, nested ones included: one raised inside a subagent or a subgraph shows too. Each has its `id`, its `value` and its `namespace`, which is `[]` for the main graph. `stream.interrupt` is the first. Tool calls your [headless tools](#headless-tools) answer don't show.

```tsx
const stream = useStream<
  { messages: BaseMessage[] },
  { question: string } // the interrupt's value
>({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});

return (
  <>
    {stream.messages.map((message, i) => (
      <div key={message.id ?? i}>{message.text}</div>
    ))}

    {stream.interrupt?.value && (
      <div>
        <p>{stream.interrupt.value.question}</p>
        <button onClick={() => void stream.respond("Approved")}>Approve</button>
      </div>
    )}
  </>
);
```

## Answering an interrupt

`stream.respond(value)` answers the interrupt `stream.interrupt` shows. With several waiting, name the one with `interruptId`. Its id is enough for a nested interrupt too.

```tsx
stream.interrupts.map((interrupt) => (
  <button
    key={interrupt.id}
    onClick={() =>
      void stream.respond({ approved: true }, { interruptId: interrupt.id })
    }
  >
    Approve
  </button>
));
```

- The interrupt hides as soon as you answer, and shows again if the run that resumes fails.
- During a run, the answer waits in the queue behind it and never interrupts it.
- `respond` resolves once the answer's run is created or queued, and rejects when it can't be sent.
- `config` and `metadata` go onto the run that resumes, as with `submit()`.
- An interrupt answered in another tab disappears here too: at once on Agent Server 0.19 or later, else at the next read of the thread's state.

## Several interrupts at once

When a run pauses on several interrupts at the same checkpoint, such as parallel approvals, answer them in one run with `respondAll`. Answering them one by one with `respond` doesn't work: the first answer starts a run, and the others have nothing left to resume.

```tsx
await stream.respondAll({
  [interruptA.id!]: { approved: true },
  [interruptB.id!]: { approved: false },
});

// The same answer to every interrupt waiting:
await stream.respondAll(
  Object.fromEntries(
    stream.interrupts.map((interrupt) => [interrupt.id!, { approved: true }])
  )
);
```

## Changing state while answering

`update` applies a state update in the same step as the answer, as LangGraph's `Command(update=...)` does: one checkpoint holds both, with no separate write and no flicker. A typical use is a card that pushes its own message into the conversation when the user answers it. Messages can be plain objects or `BaseMessage` instances.

```tsx
import { AIMessage } from "@langchain/core/messages";

await stream.respond(
  { approved: true },
  { update: { messages: [new AIMessage("Approved by the reviewer.")] } }
);
```

`goto` sends the run to a node next, as `Command(goto=...)` does: a node name, a `Send` (`{ node, input }`), or a list of them.

## Late answers

An answer to an interrupt that is no longer waiting, because another tab answered it or the id is wrong, fails its run with an `UnknownInterruptError` and leaves the thread as it was. That needs a server that checks answers (Agent Server 0.19 or later, with a Python graph). Pass `strictResume: false` to have the server ignore such an answer instead.

## Breakpoints

A thread paused at a breakpoint (`interruptBefore` or `interruptAfter`) shows one interrupt, `{ when: "breakpoint" }`, with no `id` and no `value`. `submit(null)` continues the run. Check `interrupt.value` or `interrupt.id` before you render an approval card, as the example above does.

## Headless tools

A headless tool is a tool the agent calls and the browser runs: reading the location, the clipboard or browser storage. Define it without an implementation, give it to your agent, and implement it in the browser:

```tsx
import { tool } from "langchain";
import { z } from "zod";
import { useStream } from "@langchain/react";

// Shared with the agent, which calls it without running it.
export const getLocation = tool({
  name: "get_location",
  description: "Get the user's current location",
  schema: z.object({}),
});

function Chat() {
  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    tools: [
      getLocation.implement(async () => {
        const position = await new Promise<GeolocationPosition>(
          (resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject)
        );
        const { latitude, longitude } = position.coords;
        return { latitude, longitude };
      }),
    ],
    onTool: (event) => {
      if (event.phase === "error") console.error(event.error);
    },
  });
  // ...
}
```

When the agent calls the tool, the run pauses on an interrupt. `useStream` runs the implementation and answers the interrupt with its result, so the user never sees it. `onTool` gets an event when the tool starts, succeeds or fails (`event.phase` is `"start"`, `"success"` or `"error"`), with its `name`, `args`, `result` or `error`, and `duration`.

Each call runs once, also under `<StrictMode>`, and a call left waiting runs when the thread loads again.

## Lower-level helpers

For custom interrupt handling, `@langchain/react` exports the functions `useStream` uses for headless tools:

- `findHeadlessTool(tools, name)` finds a tool's implementation.
- `executeHeadlessTool(implementation, args, onTool?)` runs one and reports to `onTool`.
- `handleHeadlessToolInterrupt(interrupt, tools, onTool?)` runs the tool an interrupt asks for, and returns `{ toolCallId, value }`.
- `headlessToolResumeCommand(result)` turns that result into the command that answers the interrupt.
- `isHeadlessToolInterrupt(value)`, `parseHeadlessToolInterruptPayload(value)` and `filterOutHeadlessToolInterrupts(interrupts)` tell headless tool calls from other interrupts.

`getThread()` is deprecated: it returns `{ interrupts, onError }`, each interrupt as `{ interruptId, namespace, payload }`. Use `stream.interrupts` and `stream.respond` instead.
