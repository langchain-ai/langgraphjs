import type { Run } from "./storage/ops.mjs";
import type { StreamCheckpoint } from "./stream.mjs";
import { serializeError } from "./utils/serde.mjs";
import { getLoopbackFetch } from "./loopback.mjs";

export async function callWebhook(result: {
  checkpoint: StreamCheckpoint | undefined;
  status: string | undefined;
  exception: Error | undefined;
  run: Run;
  webhook: string;
  run_started_at: Date;
  run_ended_at: Date | undefined;
}) {
  const payload = {
    ...result.run,
    status: result.status,
    run_started_at: result.run_started_at.toISOString(),
    run_ended_at: result.run_ended_at?.toISOString(),
    webhook_sent_at: new Date().toISOString(),
    values: result.checkpoint?.values,
    ...(result.exception
      ? { error: serializeError(result.exception).message }
      : undefined),
  };

  if (result.webhook.startsWith("/")) {
    const fetch = getLoopbackFetch();
    if (!fetch) throw new Error("Loopback fetch is not bound");

    await fetch(result.webhook, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } else {
    await fetch(result.webhook, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
}
