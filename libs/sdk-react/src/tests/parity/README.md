# Side-by-side tests

Each scenario runs twice against the same server: on 1.x, the hooks as main has them, and on 2.0, this package. It compares what a page sees on each side: messages, values, loading edges, callbacks, interrupts, subagents, and the requests sent.

## Running them

```bash
pnpm test:parity
```

The suite starts the JS dev server with the graphs in `../fixtures`. To run it against a server you started, which must serve the same graphs under the same names:

```bash
PARITY_SERVER_URL=http://127.0.0.1:2024 pnpm test:parity
```

On the Python server, `langgraph dev` serves the twins of the fixtures in `python/`, with the versions CI pins (`.github/workflows/test-browser.yml`):

```bash
python3 -m venv ~/parity-venv
~/parity-venv/bin/pip install "langgraph-cli[inmem]==0.4.43" langgraph-api==0.19.0rc2 langgraph-api-core-bin==0.19.0rc2 langgraph-runtime-inmem==0.39.0rc2 deepagents==0.7.39
PARITY_BACKEND=python PARITY_LANGGRAPH=~/parity-venv/bin/langgraph pnpm test:parity
```

Rows that test only the client run on the JS dev server alone (`itOnJsServer`), and rows that need the Agent Server run everywhere else (`itOnAgentServer`), `PARITY_SERVER_URL` included.

A `PARITY_SERVER_URL` server is taken to serve the Python graphs. For an Agent Server serving the JS ones (`langchain/langgraphjs-api`), add `PARITY_GRAPHS=js`: rows where 1.x behaves differently with JS graphs check `jsGraphs`.

The rows about a hidden page also check an expired resume point on a server that keeps resume points only briefly. Start it with `RESUMABLE_STREAM_TTL_SECONDS=2` and pass the same seconds as `PARITY_RESUME_TTL`, running just those rows (`-t hidden`), since a short lifetime changes how other rows reconnect.

The server's log path is printed when it starts. Files run one at a time, since the fixtures' scripted models count turns across the whole server.

## The 1.x side

`vitest.config.ts` copies main's `libs/sdk-react/src` at the commit in `main-commit.txt` into `.parity-v1/` (git-ignored), and the harness imports it from there. Both sides use this branch's `@langchain/langgraph-sdk`. When this branch merges main, move the commit to the main commit it merged.

## Differences and 1.x bugs

`differences.ts` lists where 2.0 behaves differently on purpose (`DIFFERENCES`, each quoting the line of `docs/v2-migration.md` that tells users) and the 1.x bugs the scenarios found (`V1_BUGS`). A scenario that hits one leaves those fields out of the comparison and checks each side on its own, with the entry's name as the assertion message:

```ts
expectSameSummary(v1, v2, { fields: ["callbacks"], because: ["serverQueue"] });
expect(v2.listed.onServer, is("serverQueue")).toEqual([true, true, true]);
```

An entry with `guide: null` is a difference waiting for a decision, to fix 2.0 or to document it, and `differences.test.tsx` fails until one is made.

## Adding a scenario

```ts
it("what both sides must show", async () => {
  const { v1, v2 } = await onBothSides(async (side) => {
    const probe = await side.mount({ assistantId: "stategraph_text" });
    await probe.stream.submit({ messages: [{ type: "human", content: "Hello" }] });
    await probe.until((s) => !s.isLoading, "the run");
    return summary(probe);
  });

  expectSameSummary(v1, v2);
});
```

- `side.mount` renders a `useStream` probe under StrictMode. `options` go to `useStream`, and `extra` calls selector hooks in the same component, its result recorded in each snapshot.
- `side.mountPanel(stream, target)` renders `useMessages`, `useToolCalls` and `useValues` on a subagent, a subgraph or a namespace.
- `summary(probe)` waits until the probe stops rendering and calling back, then gives what the sides are compared on, with ids replaced by their order of appearance.
- `onSide("2.0", ...)` runs one side alone, for a scenario where 1.x can't take part.
- A scenario finishes every flow it starts, answering each approval it raises, so the next one finds the scripted models where it expects them.
- A side's streams must all close when its components unmount: `onBothSides` checks it.
