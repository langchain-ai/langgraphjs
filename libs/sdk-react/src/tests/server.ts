import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, open, readFile, type FileHandle } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    serverUrl: string;
    backend: "js" | "python" | "url";
    graphs: "js" | "python";
    resumeTtl: number;
  }
}

const FIXTURES: Record<string, string> = {
  stategraph_text: "stategraph-text.ts:graph",
  create_agent: "create-agent.ts:graph",
  deep_agent: "deep-agent.ts:graph",
  interrupt_graph: "interrupt-graph.ts:graph",
  interrupt_card_graph: "interrupt-card-graph.ts:graph",
  interrupt_once_graph: "interrupt-once-graph.ts:graph",
  multi_interrupt_graph: "multi-interrupt-graph.ts:graph",
  nested_interrupt_graph: "nested-interrupt-graph.ts:graph",
  deep_agent_interrupt: "deep-agent-interrupt.ts:graph",
  error_graph: "error-graph.ts:graph",
  subgraph_graph: "subgraph-graph.ts:graph",
  embedded_subgraph_graph: "embedded-subgraph-graph.ts:graph",
  custom_channel_graph: "custom-channel-graph.ts:graph",
  slow_graph: "slow-graph.ts:graph",
  headless_tool_graph: "headless-tool-graph.ts:graph",
  remove_message_graph: "remove-message-graph.ts:graph",
  stateful_values_graph: "stateful-values-graph.ts:statefulValuesGraph",
  parallel_fanout: "parallel-fanout.ts:graph",
  parallel_subgraph: "parallel-subgraph.ts:graph",
};

let server: ChildProcess | undefined;
let log: FileHandle | undefined;

export async function setup({ provide }: TestProject) {
  const given = process.env.PARITY_SERVER_URL;
  if (given) {
    provide("serverUrl", given);
    provide("backend", "url");
    provide("graphs", process.env.PARITY_GRAPHS === "js" ? "js" : "python");
    provide("resumeTtl", Number(process.env.PARITY_RESUME_TTL ?? 0));
    return;
  }

  const backend = process.env.PARITY_BACKEND === "python" ? "python" : "js";
  const port = await freePort();
  // Both dev servers write their state into the folder they run in.
  const cwd = await mkdtemp(join(tmpdir(), "langchain-react-parity-"));
  const logPath = join(cwd, "server.log");
  log = await open(logPath, "w");
  const stdio = ["ignore", log.fd, log.fd] as const;
  const env = {
    ...process.env,
    LANGSMITH_TRACING: "false",
    LANGCHAIN_TRACING_V2: "false",
  };

  if (backend === "js") {
    const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
    // The dev server joins graph paths onto its folder, absolute ones too.
    const graphs = Object.fromEntries(
      Object.entries(FIXTURES).map(([id, spec]) => [
        id,
        relative(cwd, join(fixtures, spec)),
      ])
    );
    server = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./dev-server.mjs", import.meta.url)),
        String(port),
        cwd,
        JSON.stringify(graphs),
      ],
      { stdio: [...stdio], env }
    );
  } else {
    await cp(fileURLToPath(new URL("./parity/python/", import.meta.url)), cwd, {
      recursive: true,
    });
    const langgraph = process.env.PARITY_LANGGRAPH ?? "langgraph";
    server = spawn(
      `${langgraph} dev --port ${port} --host 127.0.0.1 --no-browser --no-reload --n-jobs-per-worker 10`,
      { cwd, stdio: [...stdio], env, shell: true }
    );
  }

  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url, server, logPath);
  console.log(`[parity] ${backend} server at ${url}, log in ${logPath}`);
  provide("serverUrl", url);
  provide("backend", backend);
  provide("graphs", backend);
  provide("resumeTtl", 0);
}

export async function teardown() {
  if (server != null && server.exitCode == null) {
    const exited = new Promise((resolve) => server?.once("exit", resolve));
    server.kill("SIGTERM");
    const timedOut = await Promise.race([
      exited.then(() => false),
      sleep(10_000).then(() => true),
    ]);
    if (timedOut) server.kill("SIGKILL");
  }
  await log?.close();
}

async function waitForServer(url: string, child: ChildProcess, logPath: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try {
      if ((await fetch(`${url}/ok`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  const tail = (await readFile(logPath, "utf8")).split("\n").slice(-40);
  throw new Error(`The test server didn't start:\n${tail.join("\n")}`);
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
