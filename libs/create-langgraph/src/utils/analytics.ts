import os from "node:os";

import type { Command } from "@commander-js/extra-typings";

import { version } from "./version.js";

const SUPABASE_PUBLIC_API_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6cmxwcG9qaW5wY3l5YWlweG5iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MTkyNTc1NzksImV4cCI6MjAzNDgzMzU3OX0.kkVOlLz3BxemA5nP-vat3K4qRtrDuO4SwZSR_htcX9c";
const SUPABASE_URL = "https://kzrlppojinpcyyaipxnb.supabase.co";

interface LogData {
  os: string;
  os_version: string;
  node_version: string;
  cli_version: string;
  cli_command: string;
  params: Record<string, boolean>;
}

async function logData(data: LogData): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/js_logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_PUBLIC_API_KEY,
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify(data),
    });
  } catch (error) {
    // pass
  }
}

let analyticsPromise = Promise.resolve();

export function withAnalytics<TCommand extends Command<any, any, any>>(
  fn?: (command: TCommand) => Record<string, boolean>,
  options?: { name?: string }
) {
  if (process.env.LANGGRAPH_CLI_NO_ANALYTICS === "1") {
    return () => void 0;
  }

  return function (actionCommand: TCommand): void {
    analyticsPromise = analyticsPromise.then(() =>
      logData({
        os: os.platform(),
        os_version: os.release(),
        node_version: process.version,
        cli_version: version,
        cli_command: options?.name ?? actionCommand.name(),
        params: fn?.(actionCommand) ?? {},
      }).catch(() => {})
    );
  };
}

export async function flushAnalytics() {
  await analyticsPromise;
}
