/**
 * Multimodal streaming end-to-end: real audio + image payloads via
 * ``AudioBlock`` / ``ImageBlock`` content blocks on the ``messages``
 * channel.
 *
 * Pairs with ``api/tests/graphs/agent_multimodal_stream.py`` in
 * ``langgraph-api``. That graph has two nodes:
 *
 *   * ``speak`` — streams ``fixtures/audio.wav`` in 16 ``AudioBlock``
 *     frames (one ``AIMessageChunk`` per frame).
 *   * ``draw``  — returns ``fixtures/image.png`` as a single
 *     ``ImageBlock``.
 *
 * Shapes mirror real provider output:
 *
 *   * Audio chunks match OpenAI's ``gpt-4o-audio-preview`` streaming
 *     shape — one logical AI message with N audio frames.
 *   * The image block matches OpenAI's Responses-API
 *     ``image_generation_call`` v1 output — one content block with
 *     ``{type: "image", data: <base64>, mime_type, id}``.
 *
 * This script uses the SDK's first-class media handles
 * (``thread.audio`` / ``thread.images``) so reassembly, base64
 * decoding, and per-message bookkeeping are handled by the SDK.
 *
 * Prereq:
 *   cd langgraph-api/api && make start
 *
 * Run:
 *   npx tsx src/api/multimodal_stream.ts
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@langchain/langgraph-sdk";

import { apiUrl, requireServer } from "./_shared.js";

// SHA-256 of the source fixtures — stable, deterministic.
// ``api/tests/graphs/fixtures/audio.wav``
const EXPECTED_AUDIO_SHA =
  "6897112dbb4e8b6eca4e2d15384783067ad866482383f2f987d1d6cffa31024f";
// ``api/tests/graphs/fixtures/image.png``
const EXPECTED_IMAGE_SHA =
  "a9be5f43d862898a6c627e071a5392080f75044024c8c61fb927335a250d3bf2";

async function main() {
  const url = apiUrl();
  await requireServer(url);
  console.log(`--- Connected to langgraph-api at ${url} ---\n`);

  const client = new Client({ apiUrl: url });
  const thread = client.threads.stream({
    assistantId: "agent_multimodal_stream",
  });

  await thread.run.start({
    input: { messages: [{ role: "user", content: "make-me-something" }] },
  });

  console.log("--- Streaming media handles ---\n");

  let ok = true;
  const wrote: string[] = [];

  for await (const audio of thread.audio) {
    const blob = await audio.blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    const out = join(tmpdir(), "multimodal-audio.wav");
    writeFileSync(out, bytes);
    wrote.push(out);

    const match = sha === EXPECTED_AUDIO_SHA && audio.monotonic;
    if (!match) ok = false;

    console.log(
      `  AUDIO   id=${audio.messageId}` +
        ` size=${bytes.length}B mime=${audio.mimeType ?? "?"}` +
        ` monotonic=${audio.monotonic ? "✓" : "✗"}`
    );
    console.log(`          expected sha: ${EXPECTED_AUDIO_SHA}`);
    console.log(`          actual   sha: ${sha}`);
    console.log(`          match: ${match ? "✓" : "✗"}  → wrote ${out}`);
  }

  for await (const image of thread.images) {
    const blob = await image.blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    const out = join(tmpdir(), "multimodal-image.png");
    writeFileSync(out, bytes);
    wrote.push(out);

    const match = sha === EXPECTED_IMAGE_SHA && image.monotonic;
    if (!match) ok = false;

    console.log(
      `  IMAGE   id=${image.messageId}` +
        ` size=${bytes.length}B mime=${image.mimeType ?? "?"}` +
        (image.width != null ? ` ${image.width}x${image.height}` : "") +
        ` monotonic=${image.monotonic ? "✓" : "✗"}`
    );
    console.log(`          expected sha: ${EXPECTED_IMAGE_SHA}`);
    console.log(`          actual   sha: ${sha}`);
    console.log(`          match: ${match ? "✓" : "✗"}  → wrote ${out}`);
  }

  await thread.close();

  console.log();
  console.log(`--- Wrote ${wrote.length} file(s); status: ${ok ? "OK" : "FAIL"} ---`);

  process.exit(ok ? 0 : 1);
}

await main();
