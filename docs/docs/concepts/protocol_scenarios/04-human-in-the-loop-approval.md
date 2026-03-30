# Scenario 4: Human-in-the-Loop Approval

## Description

An agent performing database operations needs human approval before executing
destructive queries. The agent analyzes a request, formulates a SQL query,
and pauses for approval. The user can approve, reject, or edit the query —
all within the same streaming session without closing and reopening
connections.

This scenario validates in-band interrupt/resume through the protocol's
`input` module.

## Agent Setup

```typescript
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { interrupt } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const executeSql = tool(
  async ({ query }, config) => {
    // Pause for human approval before executing
    const approval = await interrupt({
      type: "approval",
      prompt: `Approve this SQL query?\n\n${query}`,
      query,
    });

    if (!approval.approved) {
      return `Query rejected: ${approval.reason ?? "No reason provided"}`;
    }

    // Use the potentially edited query
    const finalQuery = approval.editedQuery ?? query;
    const result = await db.execute(finalQuery);
    return JSON.stringify(result.rows.slice(0, 10));
  },
  {
    name: "execute_sql",
    description: "Execute a SQL query against the database (requires approval)",
    schema: z.object({ query: z.string() }),
  }
);

const agent = createReactAgent({
  llm: new ChatOpenAI({ model: "gpt-4o" }),
  tools: [executeSql],
});
```

## v1: Current Approach

```typescript
// v1: Stream until interrupt, then make a separate API call to resume

// Step 1: Start streaming
const stream1 = await agent.stream(
  { messages: [{ role: "user", content: "Delete all inactive users older than 2 years" }] },
  { configurable: { thread_id: "thread_1" } }
);

for await (const chunk of stream1) {
  // Agent streams tokens... then hits interrupt
  // Stream ends with GraphInterrupt
}

// Step 2: Get the interrupt details via separate API call
const state = await client.threads.getState("thread_1");
const interrupt = state.tasks[0]?.interrupts[0];
// { type: "approval", prompt: "Approve this SQL query?...", query: "DELETE FROM..." }

// Step 3: User decides — must make another API call to resume
const approval = { approved: true, editedQuery: "DELETE FROM users WHERE ..." };

// Step 4: Start a NEW stream with Command({ resume })
const stream2 = await agent.stream(
  new Command({ resume: approval }),
  { configurable: { thread_id: "thread_1" } }
);

for await (const chunk of stream2) {
  // Agent continues with the approved query
}
```

```tsx
// Frontend (React) v1: complex multi-step flow
function SqlApproval() {
  const thread = useStream({ apiUrl: "...", assistantId: "agent" });

  // Must check for interrupts in the thread state
  const interrupt = thread.interrupts?.[0];

  if (interrupt) {
    return (
      <ApprovalDialog
        prompt={interrupt.value.prompt}
        query={interrupt.value.query}
        onApprove={(editedQuery) => {
          // Submit with Command({ resume }) — this creates a new stream
          thread.submit(undefined, {
            command: { resume: { approved: true, editedQuery } },
          });
        }}
        onReject={(reason) => {
          thread.submit(undefined, {
            command: { resume: { approved: false, reason } },
          });
        }}
      />
    );
  }

  return <ChatView messages={thread.messages} />;
}
```

**Problems with v1**:

1. **Connection break**: The stream ends when `GraphInterrupt` is thrown.
   The client must detect the interrupt, render a UI, collect user input,
   then start a new stream with `Command({ resume })`. This is two
   separate SSE connections with separate error handling.

2. **State polling**: To get interrupt details, the client makes a
   separate `GET /threads/:id/state` call — a different API with
   different auth context.

3. **Awkward UX flow**: The loading spinner stops (stream ended), an
   approval dialog appears, user clicks approve, loading spinner starts
   again (new stream). The "pause/resume" experience feels like two
   separate interactions.

## v2: Protocol Approach

### In-Process

```typescript
import { createSession } from "@langchain/langgraph/protocol";

const session = createSession(agent, {
  input: { messages: [{ role: "user", content: "Delete all inactive users older than 2 years" }] },
  config: { configurable: { thread_id: "thread_1" } },
});

const messages = session.subscribe("messages");
const inputs = session.subscribe("input");

await Promise.all([
  // Render tokens
  (async () => {
    for await (const event of messages) {
      process.stdout.write(event.params.data.message.content);
    }
  })(),

  // Handle interrupts IN-BAND — same session, same connection
  (async () => {
    for await (const event of inputs) {
      if (event.method === "input.requested") {
        const { interruptId, prompt, schema } = event.params.data;
        console.log(`\nApproval required: ${prompt}`);

        // Collect user input (CLI example)
        const answer = await readline.question("Approve? (y/n): ");

        // Respond through the SAME session — no new stream
        await session.input.respond(interruptId, {
          approved: answer === "y",
        });

        // Messages resume streaming automatically — no reconnect needed
      }
    }
  })(),
]);
```

### Frontend (React)

```tsx
import { useStream } from "@langchain/react";
import { ProtocolStreamTransport } from "@langchain/react/protocol";
import { useEffect, useState } from "react";

function SqlApproval() {
  const transport = new ProtocolStreamTransport({
    url: "ws://localhost:2024/v2/runs",
  });

  const thread = useStream({ transport, assistantId: "agent" });

  const [pendingApproval, setPendingApproval] = useState(null);

  // Subscribe to input requests via the protocol
  useEffect(() => {
    const inputSub = transport.subscribe("input");

    (async () => {
      for await (const event of inputSub) {
        if (event.method === "input.requested") {
          setPendingApproval(event.params.data);
        }
      }
    })();

    return () => inputSub.unsubscribe();
  }, [transport]);

  const handleApprove = async (editedQuery?: string) => {
    await transport.input.respond(pendingApproval.interruptId, {
      approved: true,
      editedQuery,
    });
    setPendingApproval(null);
    // Stream automatically resumes — no new connection, no reload
  };

  const handleReject = async (reason: string) => {
    await transport.input.respond(pendingApproval.interruptId, {
      approved: false,
      reason,
    });
    setPendingApproval(null);
  };

  return (
    <div>
      <ChatView messages={thread.messages} />

      {/* Approval dialog appears without breaking the stream */}
      {pendingApproval && (
        <ApprovalDialog
          prompt={pendingApproval.prompt}
          query={pendingApproval.query}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      {/* Spinner stays visible during approval — session is still open */}
      {thread.isLoading && <Spinner />}
    </div>
  );
}
```

## Protocol Analysis

### Can v1 handle this? **Yes, but with a broken UX.**

v1's `interrupt()` → `Command({ resume })` mechanism works correctly.
The functional outcome is the same. But the user experience has a visible
seam: the stream stops, a separate API call fetches state, the user
responds, and a new stream starts. The protocol makes this seamless.

### What does v2 enable?

| Aspect | v1 | v2 |
|--------|----|----|
| **Connections** | 2 SSE streams (before + after interrupt) | 1 WebSocket, never closes |
| **Interrupt delivery** | Separate `GET /state` call | In-band `input.requested` event |
| **Resume** | New `POST` with `Command({ resume })` | In-band `input.respond` command |
| **Loading state** | Spinner stops then restarts | Spinner stays — session is paused, not ended |
| **Multiple interrupts** | Each requires a new stream cycle | All handled in same session |

### Verdict

v1 handles the functionality but v2 provides a **significantly better UX**
by keeping the session open across interrupt/resume cycles. For agents with
frequent approvals (code execution, file deletion, API calls), the
difference between "stop/restart" and "pause/resume" is noticeable.
