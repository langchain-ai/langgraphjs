import { describe, expect, it } from "vitest";
import { toolInputAction } from "./ordering.js";

/**
 * The SEP-1865 input ordering: zero or more partials, then exactly one
 * `tool-input`, then nothing, and none of it before the view is initialized.
 *
 * End to end this is invisible for a tool with one short argument, since the
 * arguments settle before the view finishes its handshake. It becomes the
 * whole behaviour the moment a model spends longer writing arguments than the
 * app takes to mount, which is any drawing, document or structured payload.
 */
describe("toolInputAction", () => {
  it("sends nothing before the view says initialized", () => {
    expect(toolInputAction({ ready: false, sentFinal: false, streaming: true })).toBe("none");
    expect(toolInputAction({ ready: false, sentFinal: false, streaming: false })).toBe("none");
  });

  it("sends partials while the arguments are still arriving", () => {
    expect(toolInputAction({ ready: true, sentFinal: false, streaming: true })).toBe("partial");
  });

  it("sends one final input once they settle", () => {
    expect(toolInputAction({ ready: true, sentFinal: false, streaming: false })).toBe("final");
  });

  it("sends nothing after the final, which is what makes it exactly one", () => {
    expect(toolInputAction({ ready: true, sentFinal: true, streaming: false })).toBe("none");
    expect(toolInputAction({ ready: true, sentFinal: true, streaming: true })).toBe("none");
  });

  /** Replay a sequence of frames the way the renderer does. */
  function sent(frames: { ready: boolean; streaming: boolean }[]) {
    let sentFinal = false;
    const out: string[] = [];
    for (const frame of frames) {
      const action = toolInputAction({ ...frame, sentFinal });
      if (action === "final") sentFinal = true;
      if (action !== "none") out.push(action);
    }
    return out;
  }

  it("still delivers the input when the run finished before the view was ready", () => {
    expect(
      sent([
        { ready: false, streaming: true },
        { ready: false, streaming: false },
        { ready: true, streaming: false },
        { ready: true, streaming: false },
      ]),
    ).toEqual(["final"]);
  });

  it("streams a slow argument, then settles, exactly once", () => {
    expect(
      sent([
        { ready: true, streaming: true },
        { ready: true, streaming: true },
        { ready: true, streaming: false },
        { ready: true, streaming: false },
      ]),
    ).toEqual(["partial", "partial", "final"]);
  });
});
