#!/usr/bin/env npx tsx
/**
 * Measures actual SQLite checkpoint row sizes when simulating a long chatbot
 * conversation using the real SqliteSaver. Feed it a Claude Code conversation
 * transcript (.jsonl) and it will checkpoint accumulated messages at each turn,
 * then report how big the rows get.
 *
 * Usage:
 *   npx tsx src/measure_row_sizes.ts ~/.claude/projects/.../conversation.jsonl
 *   npx tsx src/measure_row_sizes.ts conversation.jsonl --max-messages 500
 */

import Database from "better-sqlite3";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteSaver } from "./index.js";
import {
  type Checkpoint,
  uuid6,
} from "@langchain/langgraph-checkpoint";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--") && i + 1 < args.length) {
    flags[args[i].slice(2)] = args[i + 1];
    i++;
  } else {
    positional.push(args[i]);
  }
}

const jsonlPath = positional[0];
if (!jsonlPath) {
  console.error(
    "Usage: npx tsx src/measure_row_sizes.ts <conversation.jsonl> [--max-messages N]"
  );
  process.exit(1);
}

const maxMessages = flags["max-messages"]
  ? parseInt(flags["max-messages"], 10)
  : Infinity;

// ---------------------------------------------------------------------------
// Load messages from Claude Code JSONL transcript
// ---------------------------------------------------------------------------
interface CCMessage {
  role: string;
  content: unknown;
}

function loadMessages(path: string, limit: number): CCMessage[] {
  const raw = readFileSync(resolve(path), "utf-8");
  const messages: CCMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    const msg = obj.message;
    if (msg?.role && msg?.content) {
      messages.push({ role: msg.role, content: msg.content });
    }
    if (messages.length >= limit) break;
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Run the simulation
// ---------------------------------------------------------------------------
async function main() {
  const fileStat = statSync(resolve(jsonlPath));
  console.log(`\nFile: ${jsonlPath}`);
  console.log(`File size: ${(fileStat.size / 1024 / 1024).toFixed(1)} MB`);

  const messages = loadMessages(jsonlPath, maxMessages);
  console.log(`Loaded ${messages.length} messages\n`);

  if (messages.length === 0) {
    console.error("No messages found in file.");
    process.exit(1);
  }

  // Use a temp file so we can inspect actual on-disk size
  const dbPath = `/tmp/checkpoint_size_test_${Date.now()}.db`;
  const saver = SqliteSaver.fromConnString(dbPath);

  const threadId = randomUUID();
  let parentCheckpointId: string | undefined;

  // Track row sizes at each sampled checkpoint
  const rowSizes: { step: number; msgCount: number; checkpointBytes: number; metadataBytes: number }[] = [];

  // Build sample points: exponential spacing so we get ~50-80 data points
  // without checkpointing all 17k turns
  const samplePoints = new Set<number>();
  // Linear at the start (every 2 messages up to 20)
  for (let n = 2; n <= Math.min(20, messages.length); n += 2) {
    samplePoints.add(n);
  }
  // Then exponential with finer granularity (1.15x growth)
  for (let exp = 1; exp < 80; exp++) {
    const n = Math.round(Math.pow(1.15, exp) * 20);
    if (n > messages.length) break;
    samplePoints.add(n);
  }
  // And always include the end
  samplePoints.add(messages.length);
  const sortedSamples = [...samplePoints].sort((a, b) => a - b);

  console.log(`Will checkpoint at ${sortedSamples.length} sample points\n`);

  for (let si = 0; si < sortedSamples.length; si++) {
    const msgCount = sortedSamples[si];
    const step = si;
    const accumulated = messages.slice(0, msgCount);

    const checkpointId = uuid6(step);

    const checkpoint: Checkpoint = {
      v: 4,
      id: checkpointId,
      ts: new Date().toISOString(),
      channel_values: {
        messages: accumulated, // full state — this is what a real chatbot graph does
      },
      channel_versions: {
        messages: String(step + 1),
      },
      versions_seen: {
        chatbot: { messages: String(step) },
      },
    };

    const metadata = {
      source: "loop" as const,
      step,
      parents: parentCheckpointId ? { "": parentCheckpointId } : {},
    };

    const config = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: "",
        checkpoint_id: parentCheckpointId,
      },
    };

    await saver.put(config, checkpoint, metadata);

    // Also write the last message as a pending write (like putWrites does)
    await saver.putWrites(
      {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: "",
          checkpoint_id: checkpointId,
        },
      },
      [["messages", messages[msgCount - 1]]],
      randomUUID()
    );

    // Measure the actual row size directly from SQLite
    const row = saver.db
      .prepare(
        "SELECT LENGTH(checkpoint) as cp, LENGTH(metadata) as md FROM checkpoints WHERE checkpoint_id = ?"
      )
      .get(checkpointId) as { cp: number; md: number };

    rowSizes.push({
      step,
      msgCount,
      checkpointBytes: row.cp,
      metadataBytes: row.md,
    });

    parentCheckpointId = checkpointId;

    const total = row.cp + row.md;
    process.stderr.write(
      `\r  ${si + 1}/${sortedSamples.length} | ${msgCount} msgs | row ${(total / 1024).toFixed(0)} KB`
    );
  }
  process.stderr.write("\n");

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  console.log("=== CHECKPOINT ROW SIZES ===\n");
  console.log(
    `${"Step".padStart(6)} ${"Msgs".padStart(6)} ${"Checkpoint".padStart(12)} ${"Metadata".padStart(10)} ${"Total Row".padStart(12)}`
  );
  console.log("-".repeat(50));

  const sampleInterval = Math.max(1, Math.floor(rowSizes.length / 30));
  for (let i = 0; i < rowSizes.length; i++) {
    if (i % sampleInterval !== 0 && i !== rowSizes.length - 1) continue;
    const r = rowSizes[i];
    const total = r.checkpointBytes + r.metadataBytes;
    console.log(
      `${String(r.step).padStart(6)} ${String(r.msgCount).padStart(6)} ${(r.checkpointBytes / 1024).toFixed(1).padStart(10)}KB ${(r.metadataBytes / 1024).toFixed(1).padStart(8)}KB ${(total / 1024).toFixed(1).padStart(10)}KB`
    );
  }

  const last = rowSizes[rowSizes.length - 1];
  const maxRow = rowSizes.reduce(
    (max, r) =>
      r.checkpointBytes + r.metadataBytes > max
        ? r.checkpointBytes + r.metadataBytes
        : max,
    0
  );

  console.log(`\nTotal checkpoints:          ${rowSizes.length}`);
  console.log(
    `Smallest row:               ${((rowSizes[0].checkpointBytes + rowSizes[0].metadataBytes) / 1024).toFixed(1)} KB`
  );
  console.log(
    `Largest row:                ${(maxRow / 1024).toFixed(1)} KB (${(maxRow / 1024 / 1024).toFixed(2)} MB)`
  );

  // Growth rate
  if (rowSizes.length >= 2) {
    const first = rowSizes[0].checkpointBytes + rowSizes[0].metadataBytes;
    const growthPerCheckpoint = (maxRow - first) / (rowSizes.length - 1);
    console.log(
      `Avg growth/checkpoint:      ${(growthPerCheckpoint / 1024).toFixed(1)} KB`
    );
  }

  // Writes table stats
  const writeStats = saver.db
    .prepare(
      "SELECT COUNT(*) as cnt, SUM(LENGTH(value)) as total, MAX(LENGTH(value)) as mx, AVG(LENGTH(value)) as av FROM writes"
    )
    .get() as { cnt: number; total: number; mx: number; av: number };

  console.log(`\nWrites rows:                ${writeStats.cnt}`);
  console.log(
    `Total writes data:          ${((writeStats.total || 0) / 1024 / 1024).toFixed(1)} MB`
  );
  console.log(
    `Max single write:           ${((writeStats.mx || 0) / 1024).toFixed(1)} KB`
  );

  // Total DB size on disk
  const pageCount = (
    saver.db.prepare("PRAGMA page_count").get() as { page_count: number }
  ).page_count;
  const pageSize = (
    saver.db.prepare("PRAGMA page_size").get() as { page_size: number }
  ).page_size;
  const dbSize = pageCount * pageSize;
  console.log(
    `\nSQLite DB file size:        ${(dbSize / 1024 / 1024).toFixed(1)} MB`
  );

  // Total data stored (sum of all checkpoint blobs)
  const totalCheckpointData = (
    saver.db
      .prepare(
        "SELECT SUM(LENGTH(checkpoint)) + SUM(LENGTH(metadata)) as total FROM checkpoints"
      )
      .get() as { total: number }
  ).total;
  console.log(
    `Total checkpoint blob data: ${(totalCheckpointData / 1024 / 1024).toFixed(1)} MB`
  );

  // Cloudflare DO limits
  console.log("\n=== CLOUDFLARE DO SQLITE LIMITS ===\n");

  const CF_MAX_ROW = 2 * 1024 * 1024; // 2MB max string/BLOB/row size
  const CF_DB_LIMIT = 10 * 1000 * 1000 * 1000; // 10GB paid (5GB free) per DO

  if (maxRow > CF_MAX_ROW) {
    const overStep = rowSizes.find(
      (r) => r.checkpointBytes + r.metadataBytes > CF_MAX_ROW
    )!;
    console.log(
      `FAIL: Row exceeds 2MB at step ${overStep.step} (${overStep.msgCount} messages, ${(maxRow / 1024 / 1024).toFixed(1)} MB)`
    );
  } else {
    console.log(
      `OK: All rows under 2MB limit (max: ${(maxRow / 1024 / 1024).toFixed(2)} MB)`
    );
    // Estimate when we'd hit the limit
    if (rowSizes.length >= 2) {
      const first = rowSizes[0].checkpointBytes + rowSizes[0].metadataBytes;
      const growthPerCheckpoint = (maxRow - first) / (rowSizes.length - 1);
      if (growthPerCheckpoint > 0) {
        const remaining = Math.floor(
          (CF_MAX_ROW - maxRow) / growthPerCheckpoint
        );
        console.log(
          `     ~${remaining} more checkpoints until 2MB limit (~${remaining * 2} messages)`
        );
      }
    }
  }

  if (dbSize > CF_DB_LIMIT) {
    console.log(
      `FAIL: DB size ${(dbSize / 1024 / 1024).toFixed(0)} MB exceeds 1GB limit`
    );
  } else {
    console.log(
      `OK: DB size ${(dbSize / 1024 / 1024).toFixed(1)} MB within 1GB limit (${((dbSize / CF_DB_LIMIT) * 100).toFixed(1)}% used)`
    );
  }

  // Cleanup
  unlinkSync(dbPath);
  try {
    unlinkSync(dbPath + "-wal");
    unlinkSync(dbPath + "-shm");
  } catch {
    // WAL files may not exist
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
