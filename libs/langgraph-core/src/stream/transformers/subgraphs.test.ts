import { describe, expect, it } from "vitest";
import {
  StreamMux,
  RESOLVE_VALUES,
  REJECT_VALUES,
  type StreamHandle,
} from "../mux.js";
import type { Namespace, ProtocolEvent } from "../types.js";
import {
  collectIterator as collect,
  makeProtocolEvent,
} from "../test-utils.js";
import {
  createSubgraphDiscoveryTransformer,
  filterSubgraphHandles,
} from "./subgraphs.js";

class MockSubgraphStream implements StreamHandle {
  constructor(
    public path: Namespace,
    public mux: StreamMux,
    public discoveryStart: number,
    public eventStart: number
  ) {}

  [RESOLVE_VALUES](_v: unknown) {}
  [REJECT_VALUES](_e: unknown) {}
}

function makeEvent(
  method: string,
  ns: Namespace = [],
  seq = 0
): ProtocolEvent {
  return makeProtocolEvent(method, { namespace: ns, seq });
}

function installTransformer(mux: StreamMux): void {
  const transformer = createSubgraphDiscoveryTransformer(mux, {
    createStream: (path, discoveryStart, eventStart) =>
      new MockSubgraphStream(path, mux, discoveryStart, eventStart),
  });
  mux.addTransformer(transformer);
}

describe("SubgraphDiscoveryTransformer", () => {
  it("announces a single discovery for each unseen top-level namespace", async () => {
    const mux = new StreamMux();
    installTransformer(mux);

    mux.push(["agent"], makeEvent("messages", ["agent"]));
    mux._discoveries.close();

    const items = await collect(mux._discoveries.iterate());
    expect(items).toHaveLength(1);
    expect(items[0].ns).toEqual(["agent"]);
    expect(items[0].stream).toBeInstanceOf(MockSubgraphStream);
  });

  it("uses only the top-level namespace segment as the discovery key", async () => {
    const mux = new StreamMux();
    installTransformer(mux);

    mux.push(
      ["parent", "child"],
      makeEvent("messages", ["parent", "child"])
    );
    mux._discoveries.close();

    const items = await collect(mux._discoveries.iterate());
    expect(items).toHaveLength(1);
    expect(items[0].ns).toEqual(["parent"]);
  });

  it("does not create duplicate discoveries for repeated events on the same namespace", async () => {
    const mux = new StreamMux();
    installTransformer(mux);

    mux.push(["agent"], makeEvent("messages", ["agent"], 0));
    mux.push(["agent"], makeEvent("messages", ["agent"], 1));
    mux._discoveries.close();

    const items = await collect(mux._discoveries.iterate());
    expect(items).toHaveLength(1);
  });

  it("does not announce the root namespace", async () => {
    const mux = new StreamMux();
    installTransformer(mux);

    mux.push([], makeEvent("values", [], 0));
    mux._discoveries.close();

    const items = await collect(mux._discoveries.iterate());
    expect(items).toHaveLength(0);
  });

  it("registers each new stream on the mux so values resolve on close", async () => {
    const capturedStreams: MockSubgraphStream[] = [];
    // Capture only the first resolve call per stream (Promise-like
    // semantics); subsequent resolves are ignored so the mux's
    // "resolve registered streams with `undefined`" fallback at the
    // end of `close()` doesn't overwrite the real values payload.
    const resolved = new Map<string, unknown>();

    const mux = new StreamMux();
    const transformer = createSubgraphDiscoveryTransformer(mux, {
      createStream: (path, discoveryStart, eventStart) => {
        const stream = new MockSubgraphStream(
          path,
          mux,
          discoveryStart,
          eventStart
        );
        capturedStreams.push(stream);
        const key = path.join("/");
        stream[RESOLVE_VALUES] = (v: unknown) => {
          if (!resolved.has(key)) resolved.set(key, v);
        };
        return stream;
      },
    });
    mux.addTransformer(transformer);

    mux.push(["agent"], makeEvent("messages", ["agent"]));
    mux.push(["agent"], {
      type: "event",
      seq: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      method: "values" as any,
      params: {
        namespace: ["agent"],
        timestamp: Date.now(),
        data: { step: 1 },
      },
    });
    mux.close();

    expect(capturedStreams).toHaveLength(1);
    expect(resolved.get("agent")).toEqual({ step: 1 });
  });

  it("root projection yields only direct children of the root namespace", async () => {
    const mux = new StreamMux();
    const transformer = createSubgraphDiscoveryTransformer<MockSubgraphStream>(
      mux,
      {
        createStream: (path, discoveryStart, eventStart) =>
          new MockSubgraphStream(path, mux, discoveryStart, eventStart),
      }
    );
    mux.addTransformer(transformer);
    const projection = transformer.init();

    // Deep namespace — only top-level ["parent"] is announced
    mux.push(
      ["parent", "child", "grandchild"],
      makeEvent("messages", ["parent", "child", "grandchild"])
    );
    mux.push(["sibling"], makeEvent("messages", ["sibling"]));
    mux._discoveries.close();

    const rootChildren: MockSubgraphStream[] = [];
    for await (const child of projection.subgraphs) {
      rootChildren.push(child);
    }
    expect(rootChildren).toHaveLength(2);
    expect(rootChildren[0].path).toEqual(["parent"]);
    expect(rootChildren[1].path).toEqual(["sibling"]);
  });

  it("filterSubgraphHandles scopes the shared discovery log to an arbitrary namespace", async () => {
    const mux = new StreamMux();
    installTransformer(mux);

    mux.push(["a"], makeEvent("messages", ["a"]));
    mux.push(["b"], makeEvent("messages", ["b"]));
    mux._discoveries.close();

    const only = filterSubgraphHandles<MockSubgraphStream>(
      mux._discoveries,
      [],
      1
    );
    const seen: MockSubgraphStream[] = [];
    for await (const child of only) seen.push(child);
    // startAt=1 skips the first discovery entry
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toEqual(["b"]);
  });

  it("tracks discoveryStart / eventStart offsets for each new stream", async () => {
    const mux = new StreamMux();
    installTransformer(mux);

    mux.push([], makeEvent("values", [], 0));
    mux.push([], makeEvent("values", [], 1));
    mux.push(["late"], makeEvent("messages", ["late"]));
    mux._discoveries.close();

    const items = await collect(mux._discoveries.iterate());
    expect(items).toHaveLength(1);
    const stream = items[0].stream as MockSubgraphStream;
    // Discovery log starts empty — first discovery sits at index 0.
    expect(stream.discoveryStart).toBe(0);
    // Event log already contains the two root `values` events before
    // this discovery; eventStart reflects that offset.
    expect(stream.eventStart).toBe(2);
  });
});
