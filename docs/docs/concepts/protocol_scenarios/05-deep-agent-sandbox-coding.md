# Scenario 5: Deep Agent Sandbox Coding

## Description

A deep agent runs in a sandboxed environment (Modal / Daytona / E2B)
implementing a feature from a GitHub issue. The agent reads existing code,
writes new files, runs tests, iterates on failures, and produces a working
implementation. The frontend displays:

- Live terminal output as tests run
- A file tree showing changes in real time
- Inline file diffs as the agent modifies code
- The ability for the user to edit a file the agent wrote and nudge the
  agent in a different direction

This scenario validates the `resource`, `sandbox`, and `input` modules
working together for an interactive coding experience.

## Agent Setup

```typescript
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent({
  systemPrompt: `You are a senior software engineer. Implement the feature 
    described in the user's message. Write clean code, add tests, and 
    ensure all tests pass before finishing.`,
  tools: [readFile, writeFile, editFile, execute, glob, grep],
  sandbox: { backend: "modal" },
});
```

## v1: Current Approach

```typescript
// v1: stream with updates + custom modes
for await (const [namespace, mode, data] of await agent.stream(
  { messages: [{ role: "user", content: "Implement JWT auth middleware" }] },
  { streamMode: ["messages", "custom", "updates"], subgraphs: true }
)) {
  if (mode === "messages") {
    renderAgentThinking(data[0].content);
  }

  if (mode === "custom" && data.type === "command_output") {
    // Test output arrives as a single string AFTER the command finishes
    renderTerminalOutput(data.output);
  }

  if (mode === "updates") {
    // File changes are invisible — updates only show state mutations,
    // not filesystem activity
  }
}

// To see what files the agent created: separate API call
const files = await fetch("/api/sandbox/files?path=/workspace/src");
```

**Problems with v1**:

1. **No live terminal**: Command output arrives after the command finishes.
   `npm test` running for 30 seconds shows nothing, then dumps everything
   at once. No streaming stdout/stderr.

2. **No file change notifications**: The agent writes `src/middleware/auth.ts`
   but the frontend doesn't know until it polls the filesystem.

3. **No file browsing/reading**: To see the code the agent wrote, the
   frontend must use a separate file API (not part of LangGraph).

4. **No user-to-agent file editing**: The user can't click on a file,
   edit it, and have the agent notice the change.

5. **No file diff view**: Without knowing which files changed and when,
   the frontend can't show meaningful diffs.

## v2: Protocol Approach

### Frontend (React)

```tsx
import { useStream } from "@langchain/react";
import { ProtocolStreamTransport } from "@langchain/react/protocol";
import { useEffect, useRef, useState } from "react";

function CodingWorkspace() {
  const transport = useRef(
    new ProtocolStreamTransport({ url: "ws://localhost:2024/v2/runs" })
  ).current;

  const thread = useStream({
    transport,
    assistantId: "deep-agent",
  });

  const [fileTree, setFileTree] = useState<FileEntry[]>([]);
  const [terminal, setTerminal] = useState<TerminalLine[]>([]);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);

  useEffect(() => {
    // Subscribe to file system changes
    const resourceSub = transport.subscribe("resource");

    // Subscribe to terminal output
    const sandboxSub = transport.subscribe("sandbox");

    // File changes: update tree, show modification markers
    (async () => {
      for await (const event of resourceSub) {
        for (const change of event.params.data.changes) {
          setFileTree(prev => applyChange(prev, change));

          // If the changed file is currently open, reload it
          if (openFile?.path === change.path && change.type === "modified") {
            const content = await transport.resource.read(
              event.params.namespace, change.path
            );
            setOpenFile({ path: change.path, content: content.result.content });
          }
        }
      }
    })();

    // Terminal: stream stdout/stderr line by line
    (async () => {
      for await (const event of sandboxSub) {
        if (event.method === "sandbox.started") {
          setTerminal(prev => [
            ...prev,
            { type: "command", text: `$ ${event.params.data.command}` },
          ]);
        } else if (event.method === "sandbox.output") {
          setTerminal(prev => [
            ...prev,
            {
              type: event.params.data.stream, // "stdout" or "stderr"
              text: event.params.data.text,
            },
          ]);
        } else if (event.method === "sandbox.exited") {
          setTerminal(prev => [
            ...prev,
            {
              type: event.params.data.exitCode === 0 ? "success" : "error",
              text: `Process exited with code ${event.params.data.exitCode}`,
            },
          ]);
        }
      }
    })();

    return () => { resourceSub.unsubscribe(); sandboxSub.unsubscribe(); };
  }, [transport]);

  // User clicks a file in the tree → load it via protocol
  const onFileClick = async (path: string, namespace: string[]) => {
    const result = await transport.resource.read(namespace, path);
    setOpenFile({ path, content: result.result.content });
  };

  // User edits a file → write it back via protocol
  const onFileSave = async (path: string, content: string, namespace: string[]) => {
    await transport.resource.write(namespace, path, content);
    // Optionally nudge the agent
    await transport.input.inject(namespace, {
      role: "user",
      content: `I edited ${path}. Please review my changes and continue.`,
    });
  };

  return (
    <div className="coding-workspace">
      {/* Three-panel layout: chat + files + terminal */}
      <div className="panel-chat">
        {thread.messages.map((msg) => (
          <Message key={msg.id} message={msg} />
        ))}
      </div>

      <div className="panel-files">
        <FileTree
          entries={fileTree}
          onFileClick={onFileClick}
          changedFiles={fileTree.filter(f => f.changed)}
        />
        {openFile && (
          <CodeEditor
            path={openFile.path}
            content={openFile.content}
            onSave={(content) => onFileSave(openFile.path, content, ["agent"])}
          />
        )}
      </div>

      <div className="panel-terminal">
        <Terminal lines={terminal} />
      </div>
    </div>
  );
}
```

## Protocol Analysis

### Can v1 handle this? **No.**

v1 has no mechanism for:
- Live terminal streaming (stdout/stderr as commands execute)
- File system change notifications
- Reading file contents through the stream connection
- Writing files from the frontend to the agent's sandbox
- Injecting user edits back to the agent mid-run

Each of these requires a separate out-of-band API today. The deep agent
coding experience is assembled from 3-4 different APIs with different
auth, error handling, and transport — not from the streaming protocol.

### What does v2 enable?

A single WebSocket connection powering all three panels:

| Panel | v1 | v2 |
|-------|----|----|
| **Chat** | SSE stream (works) | Same, via protocol `messages` channel |
| **File tree** | Separate filesystem API + polling | `resource.changed` events + `resource.list` command |
| **File content** | Separate file read API | `resource.read` command |
| **File editing** | Separate file write API + no agent notification | `resource.write` + `input.inject` |
| **Terminal** | Not possible (output after completion) | `sandbox.started` → `sandbox.output` → `sandbox.exited` live stream |

### Verdict

This scenario is **not possible with v1** as a cohesive experience. v2's
`resource`, `sandbox`, and `input` modules combine to enable an IDE-like
coding workspace over a single protocol connection.
