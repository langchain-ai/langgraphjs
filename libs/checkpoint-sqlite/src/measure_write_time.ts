#!/usr/bin/env npx tsx
/**
 * Measures how long it takes to write checkpoints at various conversation sizes.
 * Simulates a chatbot where each checkpoint contains the full message history.
 *
 * Usage:
 *   npx tsx src/measure_write_time.ts <conversation.jsonl>
 */

import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteSaver } from "./index.js";
import { type Checkpoint, uuid6 } from "@langchain/langgraph-checkpoint";

interface CCMessage {
  role: string;
  content: unknown;
}

function loadMessages(path: string): CCMessage[] {
  const raw = readFileSync(resolve(path), "utf-8");
  const messages: CCMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    const msg = obj.message;
    if (msg?.role && msg?.content) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  return messages;
}

async function main() {
  const jsonlPath = process.argv[2];
  if (!jsonlPath) {
    console.error("Usage: npx tsx src/measure_write_time.ts <conversation.jsonl>");
    process.exit(1);
  }

  const messages = loadMessages(jsonlPath);
  console.log(`Loaded ${messages.length} messages\n`);

  const dbPath = `/tmp/checkpoint_timing_${Date.now()}.db`;
  const saver = SqliteSaver.fromConnString(dbPath);
  const threadId = randomUUID();

  // Trigger setup (creates tables)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (saver as any).setup();

  // Sample points — measure timing at various conversation sizes
  const samplePoints = [10, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 32000];
  const samples = samplePoints.filter((n) => n <= messages.length);
  samples.push(messages.length);

  console.log(
    `${"Msgs".padStart(8)} ${"Serialize".padStart(12)} ${"Write".padStart(12)} ${"Total".padStart(12)} ${"Blob Size".padStart(12)}`
  );
  console.log("-".repeat(60));

  let parentCheckpointId: string | undefined;

  for (const msgCount of samples) {
    const accumulated = messages.slice(0, msgCount);
    const checkpointId = uuid6(msgCount);

    const checkpoint: Checkpoint = {
      v: 4,
      id: checkpointId,
      ts: new Date().toISOString(),
      channel_values: { messages: accumulated },
      channel_versions: { messages: String(msgCount) },
      versions_seen: { chatbot: { messages: String(msgCount - 1) } },
    };

    const metadata = {
      source: "loop" as const,
      step: msgCount,
      parents: parentCheckpointId ? { "": parentCheckpointId } : {},
    };

    const config = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: parentCheckpointId,
      },
    };

    // Measure serialization time
    const t0 = performance.now();
    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] =
      await Promise.all([
        saver.serde.dumpsTyped(checkpoint),
        saver.serde.dumpsTyped(metadata),
      ]);
    const tSerialized = performance.now();

    // Measure write time
    saver.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        threadId,
        "",
        checkpointId,
        parentCheckpointId ?? null,
        type1,
        serializedCheckpoint,
        serializedMetadata
      );
    const tWritten = performance.now();

    const serializeMs = tSerialized - t0;
    const writeMs = tWritten - tSerialized;
    const totalMs = tWritten - t0;
    const blobKB = serializedCheckpoint.length / 1024;

    console.log(
      `${String(msgCount).padStart(8)} ${serializeMs.toFixed(1).padStart(10)}ms ${writeMs.toFixed(1).padStart(10)}ms ${totalMs.toFixed(1).padStart(10)}ms ${blobKB.toFixed(0).padStart(9)}KB`
    );

    parentCheckpointId = checkpointId;
  }

  // Cleanup
  unlinkSync(dbPath);
  try {
    unlinkSync(dbPath + "-wal");
    unlinkSync(dbPath + "-shm");
  } catch {}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
