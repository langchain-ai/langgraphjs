import { describe, expect, it } from "vitest";
import type { Checkpoint } from "@langchain/langgraph-checkpoint";
import { LastValue } from "../channels/last_value.js";
import { ERROR, RESUME, RETURN } from "../constants.js";
import { _indexPendingWrites, _prepareNextTasks } from "./algo.js";
import { PregelNode } from "./read.js";

function buildPendingWrites(
  count: number
): [string, string, unknown][] {
  const writes: [string, string, unknown][] = [];
  for (let i = 0; i < count; i += 1) {
    const taskId = `task-${i % 500}`;
    if (i % 4 === 0) {
      writes.push([taskId, RESUME, i]);
    } else if (i % 11 === 0) {
      writes.push([taskId, ERROR, "err"]);
    } else {
      writes.push([taskId, RETURN, i]);
    }
  }
  return writes;
}

function linearScanSuccessfulWrite(
  pendingWrites: [string, string, unknown][],
  taskId: string
): boolean {
  return pendingWrites.some((w) => w[0] === taskId && w[1] !== ERROR);
}

describe("pending writes index", () => {
  it("index successfulWriteTaskIds matches linear scan for many task ids", () => {
    const pendingWrites = buildPendingWrites(12_000);
    const index = _indexPendingWrites(pendingWrites);

    for (let i = 0; i < 500; i += 1) {
      const taskId = `task-${i}`;
      expect(index.successfulWriteTaskIds.has(taskId)).toBe(
        linearScanSuccessfulWrite(pendingWrites, taskId)
      );
    }
  });

  it("index resume values match filter/flatMap for many task ids", () => {
    const pendingWrites = buildPendingWrites(8_000);
    const index = _indexPendingWrites(pendingWrites);

    for (let i = 0; i < 200; i += 1) {
      const taskId = `task-${i}`;
      const expected = pendingWrites
        .filter(([tid, chan]) => tid === taskId && chan === RESUME)
        .flatMap(([, , v]) => v);
      expect((index.resumeByTaskId.get(taskId) ?? []).flat()).toEqual(expected);
    }
  });

  it("_prepareNextTasks is unchanged with a pre-built index", () => {
    const nodeCount = 30;
    const channelVersions: Record<string, number> = {};
    const versionsSeen: Record<string, Record<string, number>> = {};
    const processes: Record<string, PregelNode> = {};
    const channels: Record<string, LastValue<number>> = {};

    for (let i = 0; i < nodeCount; i += 1) {
      const name = `node${i}`;
      const chan = `channel${i}`;
      channelVersions[chan] = 2;
      versionsSeen[name] = { [chan]: 1 };
      processes[name] = new PregelNode({
        channels: [chan],
        triggers: [chan],
      });
      const channel = new LastValue<number>();
      channel.update([i]);
      channels[chan] = channel;
    }

    const checkpoint: Checkpoint = {
      v: 1,
      id: "00000000-0000-0000-0000-000000000002",
      ts: "2026-01-01T00:00:00.000Z",
      channel_values: Object.fromEntries(
        Object.keys(channels).map((k) => [k, channels[k].get()])
      ),
      channel_versions: channelVersions,
      versions_seen: versionsSeen,
    };

    const pendingWrites = buildPendingWrites(6_000);
    const config = { configurable: { thread_id: "algo-test" } };
    const extra = { step: 2 };

    const withoutPrebuilt = _prepareNextTasks(
      checkpoint,
      pendingWrites,
      processes,
      channels,
      config,
      false,
      extra
    );

    const withPrebuilt = _prepareNextTasks(
      checkpoint,
      pendingWrites,
      processes,
      channels,
      config,
      false,
      { ...extra, pendingWritesIndex: _indexPendingWrites(pendingWrites) }
    );

    expect(Object.keys(withPrebuilt).sort()).toEqual(
      Object.keys(withoutPrebuilt).sort()
    );
    for (const id of Object.keys(withoutPrebuilt)) {
      expect(withPrebuilt[id]).toEqual(withoutPrebuilt[id]);
    }
  });
});
