/* eslint-disable import/no-extraneous-dependencies */
import fs from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

import {
  resetProtocolV2ServerState,
  startProtocolV2Server,
  TEST_API_URL,
} from "../../../../langgraph-api/tests/protocol-v2/utils.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    protocolV2ServerUrl: string;
  }
}

let cleanupProtocolV2Server: (() => Promise<void>) | undefined;
let ownsProtocolV2Server = false;
const protocolV2StorageDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../langgraph-api/tests/protocol-v2/graphs/.langgraph_api",
);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const isProtocolV2ServerReachable = async () => {
  try {
    await fetch(TEST_API_URL);
    return true;
  } catch {
    return false;
  }
};

const waitForProtocolV2Server = async (timeoutMs: number = 10_000) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isProtocolV2ServerReachable()) {
      return;
    }
    await sleep(100);
  }

  throw new Error("Timed out waiting for protocol-v2 server startup.");
};

export async function setup({ provide }: TestProject) {
  await fs.mkdir(protocolV2StorageDir, { recursive: true });

  if (!(await isProtocolV2ServerReachable())) {
    try {
      ({ cleanup: cleanupProtocolV2Server } = await startProtocolV2Server());
      ownsProtocolV2Server = true;
    } catch (error) {
      const maybeErrno = error as NodeJS.ErrnoException;
      if (maybeErrno.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  await waitForProtocolV2Server();
  await resetProtocolV2ServerState();
  provide("protocolV2ServerUrl", TEST_API_URL);
}

export async function teardown() {
  if (!ownsProtocolV2Server) {
    return;
  }

  await cleanupProtocolV2Server?.();
  cleanupProtocolV2Server = undefined;
  ownsProtocolV2Server = false;
}
