/**
 * Simple WebSocket client for testing the chat DO.
 *
 * Usage:
 *   pnpm ws <threadId> <command> [args...]
 *
 * Commands:
 *   get_messages                    — fetch latest messages
 *   get_history                     — fetch checkpoint history
 *   message <text>                  — send a message
 *   fork <checkpointId>             — fork from a checkpoint
 */

import WebSocket from "ws";

const [threadId, command, ...rest] = process.argv.slice(2);

if (!threadId || !command) {
  console.error("Usage: pnpm ws <threadId> <command> [args...]");
  process.exit(1);
}

const url = `ws://localhost:7303/thread/${threadId}`;
const ws = new WebSocket(url);

const timeout = setTimeout(() => {
  console.error("Timed out after 5s");
  ws.close();
  process.exit(1);
}, 5000);

ws.on("open", () => {
  let payload: Record<string, unknown>;

  switch (command) {
    case "get_messages":
    case "get_history":
      payload = { type: command };
      break;
    case "message":
      payload = { type: "message", content: rest.join(" ") };
      break;
    case "fork":
      payload = { type: "fork", checkpointId: rest[0] };
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }

  ws.send(JSON.stringify(payload));
});

ws.on("message", (data) => {
  clearTimeout(timeout);
  const parsed = JSON.parse(String(data));
  console.log(JSON.stringify(parsed, null, 2));
  ws.close();
});

ws.on("error", (err) => {
  clearTimeout(timeout);
  console.error("WebSocket error:", err.message);
  process.exit(1);
});
