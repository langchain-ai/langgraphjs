/**
 * `langgraph deploy` command tree, ported from the Python CLI's `deploy.py`.
 *
 * Builds and deploys a LangGraph project (graph, createAgent, createDeepAgent,
 * ...) to LangSmith Deployment. Supports local Docker builds (build → push →
 * update) and remote source builds (tar → upload → trigger), plus the
 * `list`, `revisions list`, `delete`, and `logs` subcommands.
 */

import { $ } from "execa";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import readline from "node:readline";
import dotenv from "dotenv";
import { gracefulExit } from "exit-hook";

import { builder } from "./utils/builder.mjs";
import { withAnalytics } from "./utils/analytics.mjs";
import { getProjectPath } from "./utils/project.mjs";
import { getConfig, type Config } from "../utils/config.mjs";
import {
  assembleLocalDeps,
  configToDocker,
  getBaseImage,
} from "../docker/docker.mjs";
import { getExecaOptions } from "../docker/shell.mjs";
import {
  HostBackendClient,
  HostBackendError,
  type Secret,
} from "./utils/host-backend.mjs";
import { Emitter, Spinner } from "./utils/deploy-output.mjs";
import { createArchive, BYTES_PER_MIB } from "./utils/archive.mjs";
import {
  API_KEY_ENV_NAMES,
  DEFAULT_HOST_URL,
  DEPLOYMENT_NAME_ENV,
  TERMINAL_STATUSES,
  envWithoutDeploymentName,
  findDeploymentIdByName,
  formatDeploymentsTable,
  formatLogEntry,
  formatRevisionsTable,
  getDeploymentStatusUrl,
  hasDisallowedBuildCommandContent,
  isPathWithin,
  levelColor,
  normalizeImageTag,
  normalizeName,
  secretsFromEnv,
  smithDashboardBaseUrl,
} from "./utils/deploy-helpers.mjs";

// ---------------------------------------------------------------------------
// Module-level state (mirrors the Python globals `_emitter` / `_no_input`).
// ---------------------------------------------------------------------------

let emitter = new Emitter(false);
let noInput = false;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const NO_COLOR = process.env.NO_COLOR != null || !process.stdout.isTTY;
const COLORS = { cyan: "36", green: "32", yellow: "33", red: "31" } as const;

function paint(message: string, color: keyof typeof COLORS): string {
  if (NO_COLOR) return message;
  return `\u001b[${COLORS[color]}m${message}\u001b[0m`;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

function promptText(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || "");
    });
  });
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    let muted = false;
    // @ts-expect-error -- override internal writer to suppress echo
    rl._writeToOutput = (chunk: string) => {
      if (!muted)
        (rl as unknown as { output: NodeJS.WriteStream }).output.write(chunk);
    };
    rl.question(`${question}: `, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

async function confirm(question: string): Promise<boolean> {
  const answer = await promptText(question);
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

/**
 * Wrap a command action so failures surface as a clean message (or a JSON
 * error event in `--json` mode) and exit non-zero, rather than dumping a stack
 * trace through the global uncaught-exception handler.
 */
function action<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<void>
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await handler(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (emitter.jsonMode) {
        emitter.error(message);
      } else {
        process.stderr.write(paint(`Error: ${message}\n`, "red"));
      }
      gracefulExit(1);
    }
  };
}

// ---------------------------------------------------------------------------
// Config / env / secrets
// ---------------------------------------------------------------------------

function validateDeployCommands(
  installCommand: string | undefined,
  buildCommand: string | undefined
): void {
  if (installCommand && hasDisallowedBuildCommandContent(installCommand)) {
    throw new Error(
      "install_command contains disallowed characters or patterns."
    );
  }
  if (buildCommand && hasDisallowedBuildCommandContent(buildCommand)) {
    throw new Error(
      "build_command contains disallowed characters or patterns."
    );
  }
}

function warnNonWolfiDistro(rawConfig: Record<string, unknown>): void {
  const distro = rawConfig.image_distro ?? "debian";
  if (distro === "wolfi") return;
  emitter.note(
    "⚠️  Security Recommendation: Consider switching to Wolfi Linux for enhanced security."
  );
  emitter.note(
    "   Wolfi is a security-oriented, minimal Linux distribution designed for containers."
  );
  emitter.note(
    '   To switch, add \'"image_distro": "wolfi"\' to your langgraph.json config file.'
  );
}

async function resolveEnvPath(
  rawConfig: Record<string, unknown>,
  configPath: string
): Promise<string | null> {
  const envField = rawConfig.env;
  if (isPlainObject(envField) && Object.keys(envField).length) return null;
  if (typeof envField === "string") {
    const projectRoot = path.dirname(configPath);
    const envPath = path.resolve(projectRoot, envField);
    if (!isPathWithin(projectRoot, envPath)) {
      emitter.note(
        `Ignoring env file '${envField}' specified in langgraph.json: ` +
          "the path escapes the project directory."
      );
      return null;
    }
    if (!(await exists(envPath))) {
      emitter.note(
        `Warning: env file '${envField}' specified in langgraph.json not found.`
      );
      return null;
    }
    return envPath;
  }
  return path.join(process.cwd(), ".env");
}

async function parseEnvFromConfig(
  rawConfig: Record<string, unknown>,
  configPath: string
): Promise<Record<string, string>> {
  const envField = rawConfig.env;
  if (isPlainObject(envField) && Object.keys(envField).length) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(envField)) {
      out[String(key)] = String(value);
    }
    return out;
  }
  const envPath = await resolveEnvPath(rawConfig, configPath);
  if (envPath === null || !(await exists(envPath))) return {};
  const parsed = dotenv.parse(await fs.readFile(envPath));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value != null) out[key] = value;
  }
  return out;
}

async function setEnvKey(
  envPath: string,
  key: string,
  value: string
): Promise<void> {
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf-8");
  } catch {
    // file does not exist yet
  }
  const lines = content.length ? content.split(/\r?\n/) : [];
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
  const newLine = `${key}=${value}`;
  const idx = lines.findIndex((line) => pattern.test(line));
  if (idx >= 0) {
    lines[idx] = newLine;
  } else if (lines.length && lines[lines.length - 1] === "") {
    lines.splice(lines.length - 1, 0, newLine);
  } else {
    lines.push(newLine);
  }
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  await fs.writeFile(envPath, out);
}

// ---------------------------------------------------------------------------
// Host backend client factory + tenant handling
// ---------------------------------------------------------------------------

async function createHostBackendClient(
  hostUrl: string,
  apiKey: string | undefined,
  envVars?: Record<string, string>
): Promise<HostBackendClient> {
  let resolvedEnv = envVars;
  if (resolvedEnv === undefined) {
    resolvedEnv = await parseEnvFromConfig(
      {},
      path.join(process.cwd(), "langgraph.json")
    );
  }

  let resolvedApiKey = apiKey;
  if (!resolvedApiKey) {
    for (const name of API_KEY_ENV_NAMES) {
      if (resolvedEnv[name]) {
        resolvedApiKey = resolvedEnv[name];
        break;
      }
      if (process.env[name]) {
        resolvedApiKey = process.env[name];
        break;
      }
    }
  }
  if (!resolvedApiKey) {
    if (noInput) {
      throw new Error(
        "No LangSmith API key found. Set LANGSMITH_API_KEY in the environment or .env file."
      );
    }
    process.stdout.write(
      paint(
        "No LangSmith API key found. Create one at Settings > API Keys in LangSmith.\n",
        "yellow"
      )
    );
    resolvedApiKey = await promptHidden("Enter LangSmith API key");
  }

  const tenantId =
    resolvedEnv.LANGSMITH_TENANT_ID || process.env.LANGSMITH_TENANT_ID;
  return new HostBackendClient(hostUrl, resolvedApiKey, tenantId);
}

async function callWithOptionalTenant<T>(
  client: HostBackendClient,
  operation: (client: HostBackendClient) => Promise<T>
): Promise<T> {
  let promptedForTenant = false;
  for (;;) {
    try {
      return await operation(client);
    } catch (error) {
      if (!(error instanceof HostBackendError)) throw error;
      if (
        !promptedForTenant &&
        error.statusCode === 403 &&
        error.message.includes("requires workspace specification")
      ) {
        if (noInput) {
          throw new Error(
            "API key is org-scoped and requires a workspace ID. Set LANGSMITH_TENANT_ID " +
              "in your .env file or use a workspace-scoped API key."
          );
        }
        process.stdout.write(
          paint(
            "Your API key is org-scoped and requires a workspace ID.\n",
            "yellow"
          )
        );
        process.stdout.write(
          paint(
            "Find your workspace ID in LangSmith under Settings > Workspaces.\n",
            "yellow"
          )
        );
        const workspaceId = await promptText("Workspace ID");
        client.setTenantId(workspaceId);
        promptedForTenant = true;
        continue;
      }
      if (
        error.statusCode === 403 &&
        error.message.toLowerCase().includes("not enabled")
      ) {
        const smithBase = smithDashboardBaseUrl(client.baseUrl);
        throw new HostBackendError(
          "LangSmith Deployment is not enabled for this organization. " +
            `Enable it at ${smithBase}/host/deployments (ensure this matches the ` +
            "organization for your API key).",
          403
        );
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Build mode resolution
// ---------------------------------------------------------------------------

const DOCKER_NOT_INSTALLED =
  "Docker is required but not installed.\n" +
  "Install Docker Desktop: https://docs.docker.com/get-docker/";
const DOCKER_NOT_RUNNING =
  "Docker is installed but not running.\nStart Docker and try again.";

async function canBuildLocally(): Promise<[boolean, string | null]> {
  let opts: Awaited<ReturnType<typeof getExecaOptions>>;
  try {
    opts = await getExecaOptions({ reject: false });
  } catch {
    return [false, DOCKER_NOT_INSTALLED];
  }
  try {
    const info = await $(opts)`docker info`;
    if (info.exitCode !== 0) return [false, DOCKER_NOT_RUNNING];
  } catch {
    return [false, DOCKER_NOT_RUNNING];
  }
  if (os.arch() !== "x64") {
    try {
      const buildx = await $(opts)`docker buildx version`;
      if (buildx.exitCode !== 0) {
        return [
          false,
          "Docker Buildx is required but not installed.\n" +
            `Your machine architecture (${os.arch()}) requires Buildx to ` +
            "cross-compile images for linux/amd64.\n" +
            "Install Buildx: https://docs.docker.com/build/install-buildx/",
        ];
      }
    } catch {
      return [
        false,
        "Docker Buildx is required but not installed.\n" +
          "Install Buildx: https://docs.docker.com/build/install-buildx/",
      ];
    }
  }
  return [true, null];
}

async function resolveBuildMode(
  remoteBuildFlag: boolean | undefined
): Promise<[boolean, string | null]> {
  const [supported, localBuildError] = await canBuildLocally();
  if (remoteBuildFlag === true) return [true, localBuildError];
  if (remoteBuildFlag === false) {
    if (!supported) {
      throw new Error(
        `${localBuildError || "Unable to build locally."}\n\n` +
          "Or re-run with --remote to use remote builds."
      );
    }
    return [false, null];
  }
  return [!supported, localBuildError];
}

// ---------------------------------------------------------------------------
// Deployment resolution / creation
// ---------------------------------------------------------------------------

interface ResolveResult {
  deploymentId: string | undefined;
  needsCreation: boolean;
  step: number;
}

async function resolveDeployment(
  client: HostBackendClient,
  step: number,
  deploymentId: string | undefined,
  name: string | undefined,
  notFoundMessage: string
): Promise<ResolveResult> {
  if (deploymentId) {
    emitter.step(step, `Using deployment ${deploymentId}`);
    await callWithOptionalTenant(client, (c) => c.getDeployment(deploymentId));
    return { deploymentId, needsCreation: false, step: step + 1 };
  }

  emitter.step(step, `Looking up deployment '${name}'`);
  const response = await callWithOptionalTenant(client, (c) =>
    c.listDeployments(name)
  );
  const foundId = findDeploymentIdByName(response, name);
  if (foundId) {
    emitter.info(`Found existing deployment (ID: ${foundId})`);
    return { deploymentId: foundId, needsCreation: false, step: step + 1 };
  }
  emitter.warn(notFoundMessage);
  return { deploymentId: undefined, needsCreation: true, step: step + 1 };
}

async function createDeployment(
  client: HostBackendClient,
  step: number,
  args: {
    name: string;
    deploymentType: string;
    source: string;
    secrets: Secret[];
  }
): Promise<{ id: string; step: number }> {
  emitter.step(step, `Creating deployment '${args.name}'`);
  const created = await client.createDeployment({
    name: args.name,
    deploymentType: args.deploymentType,
    source: args.source,
    secrets: args.secrets,
  });
  const id = typeof created.id === "string" ? created.id : undefined;
  if (!id) {
    throw new HostBackendError(
      "POST /v2/deployments succeeded but response missing a valid 'id'"
    );
  }
  emitter.info(`Deployment ID: ${id}`, { deployment_id: id });
  return { id, step: step + 1 };
}

// ---------------------------------------------------------------------------
// Status polling + result
// ---------------------------------------------------------------------------

function emitDeploymentStatusUrl(
  updated: unknown,
  deploymentId: string,
  hostUrl: string
): string | null {
  const url = getDeploymentStatusUrl(updated, deploymentId, hostUrl);
  if (url) emitter.statusUrl(url);
  return url;
}

interface BuildResult {
  updated: Record<string, unknown>;
  progressMessage: string;
  timeoutSeconds: number;
  pollIntervalSeconds: number;
  noResultMessage: string;
  onPoll?: (
    status: string,
    revisionId: string,
    setProgress: (message: string) => void
  ) => Promise<void> | void;
  onInterrupt?: (revisionId: string) => void;
  showBuildLogsOnFailure: boolean;
}

async function pollRevisionStatus(
  client: HostBackendClient,
  deploymentId: string,
  options: {
    progressMessage: string;
    timeoutSeconds: number;
    pollIntervalSeconds: number;
    onPoll?: BuildResult["onPoll"];
    onInterrupt?: BuildResult["onInterrupt"];
  }
): Promise<[string, string | null]> {
  const revisionsResp = await client.listRevisions(deploymentId, 1);
  const resources = Array.isArray(revisionsResp.resources)
    ? (revisionsResp.resources as unknown[])
    : [];
  if (!resources.length) return ["", null];

  const revisionId = String(rec(resources[0]).id);
  let lastStatus = "";
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const startTime = Date.now();
  let lastHeartbeat = startTime;
  const json = emitter.jsonMode;

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process.on("SIGINT", onSigint);

  const spinner = new Spinner(options.progressMessage, {
    elapsed: true,
    jsonMode: json,
  });
  if (options.progressMessage) spinner.set(options.progressMessage);

  try {
    while (Date.now() < deadline) {
      if (interrupted) {
        spinner.set("");
        if (options.onInterrupt) {
          options.onInterrupt(revisionId);
          gracefulExit(1);
          return [lastStatus, revisionId];
        }
      }

      const rev = await client.getRevision(deploymentId, revisionId);
      const status =
        typeof rec(rev).status === "string"
          ? (rec(rev).status as string)
          : "UNKNOWN";

      if (status !== lastStatus) {
        spinner.set("");
        if (lastStatus) {
          emitter.statusChange(lastStatus, (Date.now() - startTime) / 1000);
        }
        lastStatus = status;
        if (TERMINAL_STATUSES.has(status)) break;
        spinner.set(`${status}...`);
        lastHeartbeat = Date.now();
      } else if (json && Date.now() - lastHeartbeat > 10_000) {
        emitter.heartbeat(lastStatus, (Date.now() - startTime) / 1000);
        lastHeartbeat = Date.now();
      }

      if (options.onPoll) {
        await options.onPoll(status, revisionId, (message) =>
          spinner.set(message)
        );
      }
      await sleep(options.pollIntervalSeconds * 1000);
    }
    spinner.set("");
  } finally {
    spinner.stop();
    process.off("SIGINT", onSigint);
  }

  return [lastStatus, revisionId];
}

async function printDeploymentResult(
  client: HostBackendClient,
  deploymentId: string,
  lastStatus: string,
  options: { dashboardLabel: string; statusUrl: string | null }
): Promise<void> {
  const depInfo = await client.getDeployment(deploymentId);
  const sourceConfig = rec(depInfo).source_config;
  const customUrl =
    isPlainObject(sourceConfig) && typeof sourceConfig.custom_url === "string"
      ? (sourceConfig.custom_url as string)
      : null;

  if (lastStatus === "DEPLOYED") {
    emitter.result("succeeded", {
      deploymentId,
      url: customUrl,
      statusUrl: options.statusUrl,
    });
  } else if (
    ["BUILD_FAILED", "DEPLOY_FAILED", "CREATE_FAILED"].includes(lastStatus)
  ) {
    emitter.result("failed", { deploymentId, statusUrl: options.statusUrl });
    gracefulExit(1);
  } else {
    emitter.result("timed_out", {
      deploymentId,
      statusUrl: options.statusUrl,
      fallbackStatusMessage: `Check status in the LangSmith ${options.dashboardLabel}.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Docker push auth + digest resolution
// ---------------------------------------------------------------------------

async function dockerConfigForToken(
  registryHost: string,
  token: string
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const authB64 = Buffer.from(`oauth2accesstoken:${token}`).toString("base64");
  const data = { auths: { [registryHost]: { auth: authB64 } } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-docker-"));
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(data));
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function resolvePushedImageDigest(
  opts: Awaited<ReturnType<typeof getExecaOptions>>,
  remoteImage: string
): Promise<string> {
  // rsplit on ":" preserves any ":port" in the registry host.
  const repoNoTag = remoteImage.slice(0, remoteImage.lastIndexOf(":"));
  let digests: unknown[] = [];
  try {
    const { stdout } = await $(
      opts
    )`docker image inspect --format ${"{{json .RepoDigests}}"} ${remoteImage}`;
    digests = JSON.parse(String(stdout || "[]")) || [];
  } catch {
    digests = [];
  }
  for (const digest of digests) {
    if (
      typeof digest === "string" &&
      digest.startsWith(`${repoNoTag}@sha256:`)
    ) {
      return digest;
    }
  }
  emitter.warn(
    `Could not resolve image digest for ${remoteImage}; falling back to the ` +
      "tag-based reference. Re-run with --verbose for details."
  );
  return remoteImage;
}

// ---------------------------------------------------------------------------
// GCS upload
// ---------------------------------------------------------------------------

/** Chunk size used when streaming the source archive upload (1 MiB). */
const UPLOAD_CHUNK_SIZE = 1024 * 1024;

async function uploadToGcs(
  signedUrl: string,
  filePath: string,
  fileSize: number
): Promise<void> {
  const sizeMb = fileSize / BYTES_PER_MIB;
  const handle = await fs.open(filePath, "r");
  let closed = false;
  const closeHandle = async () => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => {});
  };

  let uploaded = 0;
  let lastPct = -1;
  emitter.uploadProgress(sizeMb, 0);

  // Stream the archive in chunks so progress reflects bytes actually sent
  // (instead of buffering the whole file in memory and jumping 0% -> 100%).
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buffer = new Uint8Array(UPLOAD_CHUNK_SIZE);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        UPLOAD_CHUNK_SIZE,
        uploaded
      );
      if (bytesRead === 0) {
        await closeHandle();
        controller.close();
        return;
      }
      uploaded += bytesRead;
      controller.enqueue(buffer.subarray(0, bytesRead));
      const pct = fileSize ? Math.floor((uploaded * 100) / fileSize) : 100;
      if (pct !== lastPct) {
        emitter.uploadProgress(sizeMb, pct);
        lastPct = pct;
      }
    },
    async cancel() {
      await closeHandle();
    },
  });

  try {
    // `duplex: "half"` is required by undici when sending a streaming body.
    const response = await fetch(signedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/gzip",
        "Content-Length": String(fileSize),
        "X-Goog-Content-Length-Range": "0,209715200",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Upload failed with status ${response.status}: ${detail}`
      );
    }
  } finally {
    await closeHandle();
  }

  if (lastPct !== 100) emitter.uploadProgress(sizeMb, 100);
  if (!emitter.jsonMode) process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// Build runners
// ---------------------------------------------------------------------------

interface LocalBuildArgs {
  client: HostBackendClient;
  deploymentId: string;
  step: number;
  configPath: string;
  config: Config;
  verbose: boolean;
  pull: boolean;
  apiVersion: string | undefined;
  baseImage: string | undefined;
  imageName: string | undefined;
  name: string | undefined;
  tag: string;
  installCommand: string | undefined;
  buildCommand: string | undefined;
  dockerBuildArgs: string[];
  secrets: Secret[];
}

async function runLocalBuild(args: LocalBuildArgs): Promise<BuildResult> {
  const projectDir = path.dirname(args.configPath);
  const localDeps = await assembleLocalDeps(args.configPath, args.config);

  // Resolve the base image, honoring `--base-image` / `--api-version`. When
  // neither is supplied this equals the config's own base image, so the
  // rewrite below is a no-op.
  const baseImageRef =
    args.baseImage ?? getBaseImage(args.config, args.apiVersion);

  const generatedDockerfile = await configToDocker(
    args.configPath,
    args.config,
    localDeps,
    {
      watch: false,
      dockerCommand: "build",
      installCommand: args.installCommand,
      buildCommand: args.buildCommand,
    }
  );
  // `configToDocker` emits `FROM ${getBaseImage(config)}` using the config's
  // own base image; rewrite the first FROM instruction so the resolved base
  // image (including any override) is what gets built.
  const dockerfile = generatedDockerfile.replace(
    /^FROM .*$/m,
    `FROM ${baseImageRef}`
  );

  const needsBuildx = os.arch() !== "x64";
  const localTag = `langgraph-deploy-tmp:${Math.floor(Date.now() / 1000)}`;
  const baseOpts = await getExecaOptions({ cwd: projectDir });
  const stdio = args.verbose
    ? ({ stdout: "inherit", stderr: "inherit" } as const)
    : ({ stdout: "ignore", stderr: "ignore" } as const);

  let step = args.step;

  // -- Pull base image --
  if (args.pull) {
    await $({ ...baseOpts, ...stdio })`docker pull ${baseImageRef}`;
  }

  // -- Build image --
  emitter.step(step, "Building image");
  const buildCmd = needsBuildx
    ? [
        "buildx",
        "build",
        "--platform",
        "linux/amd64",
        "--load",
        ...(args.verbose ? [] : ["--progress=quiet"]),
        "-f",
        "-",
        "-t",
        localTag,
        projectDir,
        ...args.dockerBuildArgs,
      ]
    : ["build", "-f", "-", "-t", localTag, projectDir, ...args.dockerBuildArgs];

  const buildSpinner = new Spinner("Building...", {
    elapsed: !args.verbose,
    jsonMode: emitter.jsonMode,
  });
  if (!args.verbose) buildSpinner.set("Building...");
  try {
    await $({ ...baseOpts, ...stdio, input: dockerfile })`docker ${buildCmd}`;
  } finally {
    buildSpinner.stop();
  }
  step += 1;

  // -- Request push token --
  emitter.step(step, "Requesting push token");
  let pushData: Record<string, unknown>;
  try {
    pushData = await args.client.requestPushToken(args.deploymentId);
  } catch (error) {
    if (
      error instanceof HostBackendError &&
      error.statusCode === 400 &&
      error.message.includes(
        "only available for 'internal_docker' source deployments"
      )
    ) {
      throw new Error(
        `Deployment '${args.deploymentId}' was not created by 'langgraph deploy' ` +
          "and cannot be updated with this command.\n" +
          "Please create a new deployment by running 'langgraph deploy' without " +
          "--deployment-id, or use a different --name."
      );
    }
    throw error;
  }
  const deploymentToken =
    typeof pushData.token === "string" ? pushData.token : undefined;
  const registryUrl =
    typeof pushData.registry_url === "string"
      ? pushData.registry_url
      : undefined;
  if (!deploymentToken || !registryUrl) {
    throw new Error("Push token response missing token or registry_url");
  }
  step += 1;

  let normalizedRegistry = registryUrl.replace(/\/+$/, "");
  if (normalizedRegistry.includes("://")) {
    normalizedRegistry = normalizedRegistry.slice(
      normalizedRegistry.indexOf("//") + 2
    );
  }
  const repoSeed = args.imageName || args.name || path.basename(projectDir);
  const repoName = normalizeName(repoSeed);
  const tagValue = normalizeImageTag(args.tag);
  const remoteImage = `${normalizedRegistry}/${repoName}:${tagValue}`;
  const registryHost = normalizedRegistry.split("/")[0];

  const { dir: cfgDir, cleanup } = await dockerConfigForToken(
    registryHost,
    deploymentToken
  );
  try {
    // -- Login --
    emitter.step(step, `Logging into ${registryHost}`);
    const tokenInput = deploymentToken.endsWith("\n")
      ? deploymentToken
      : `${deploymentToken}\n`;
    await $({
      ...baseOpts,
      ...stdio,
      input: tokenInput,
    })`docker --config ${cfgDir} login -u oauth2accesstoken --password-stdin ${registryHost}`;
    step += 1;

    // -- Tag + push --
    emitter.step(step, `Pushing image ${remoteImage}`);
    await $({ ...baseOpts, ...stdio })`docker tag ${localTag} ${remoteImage}`;

    const maxPushRetries = 3;
    for (let attempt = 0; attempt < maxPushRetries; attempt += 1) {
      const pushSpinner = new Spinner("Pushing...", {
        elapsed: !args.verbose,
        jsonMode: emitter.jsonMode,
      });
      if (!args.verbose) pushSpinner.set("Pushing...");
      try {
        await $({
          ...baseOpts,
          ...stdio,
        })`docker --config ${cfgDir} push ${remoteImage}`;
        pushSpinner.stop();
        break;
      } catch (error) {
        pushSpinner.stop();
        if (attempt < maxPushRetries - 1) {
          emitter.warn(
            `Push failed, retrying (attempt ${attempt + 2} of ${maxPushRetries})...`
          );
        } else {
          throw error;
        }
      }
    }
    step += 1;
  } finally {
    await cleanup();
  }

  const resolvedImage = await resolvePushedImageDigest(baseOpts, remoteImage);

  // -- Update deployment --
  emitter.step(step, `Updating deployment ${args.deploymentId}`);
  const updated = await args.client.updateDeployment(
    args.deploymentId,
    resolvedImage,
    { secrets: args.secrets }
  );

  return {
    updated: rec(updated),
    progressMessage: "Deploying...",
    timeoutSeconds: 300,
    pollIntervalSeconds: 1,
    noResultMessage: "Deployment updated",
    showBuildLogsOnFailure: false,
  };
}

interface RemoteBuildArgs {
  client: HostBackendClient;
  deploymentId: string;
  step: number;
  configPath: string;
  verbose: boolean;
  installCommand: string | undefined;
  buildCommand: string | undefined;
  secrets: Secret[];
}

async function runRemoteBuild(args: RemoteBuildArgs): Promise<BuildResult> {
  let step = args.step;

  emitter.step(step, "Creating source archive");
  const archive = await createArchive(args.configPath, {
    onWarn: (message) => emitter.warn(message),
  });
  let configRel: string;
  try {
    emitter.info(
      `Archive created (${(archive.fileSize / BYTES_PER_MIB).toFixed(1)} MB)`
    );
    configRel = archive.configRel;
    step += 1;

    emitter.step(step, "Requesting upload URL");
    const uploadData = await args.client.requestUploadUrl(args.deploymentId);
    const signedUrl =
      typeof uploadData.upload_url === "string"
        ? uploadData.upload_url
        : undefined;
    const objectPath =
      typeof uploadData.object_path === "string"
        ? uploadData.object_path
        : undefined;
    if (!signedUrl || !objectPath) {
      throw new Error("Upload URL response missing required fields");
    }
    step += 1;

    emitter.step(step, "Uploading source");
    await uploadToGcs(signedUrl, archive.archivePath, archive.fileSize);
    step += 1;

    emitter.step(step, "Triggering remote build");
    const updated = await args.client.updateDeploymentInternalSource(
      args.deploymentId,
      {
        sourceTarballPath: objectPath,
        configPath: configRel,
        secrets: args.secrets,
        installCommand: args.installCommand,
        buildCommand: args.buildCommand,
      }
    );

    let logOffset: string | null = null;
    let logsHeaderPrinted = false;

    const onPoll: BuildResult["onPoll"] = async (
      status,
      revisionId,
      setProgress
    ) => {
      if (
        !(
          args.verbose &&
          (status === "AWAITING_BUILD" || status === "BUILDING")
        )
      ) {
        return;
      }
      try {
        const payload: Record<string, unknown> = logOffset
          ? { order: "asc", limit: 50, offset: logOffset }
          : { order: "asc", limit: 50 };
        const logsResp = await args.client.getBuildLogs(
          args.deploymentId,
          revisionId,
          payload
        );
        const entries = Array.isArray(logsResp.logs)
          ? (logsResp.logs as Record<string, unknown>[])
          : [];
        const hasOutput = entries.some((entry) => entry.message);
        if (hasOutput) {
          setProgress("");
          if (!logsHeaderPrinted) {
            emitter.info(`${status} (build logs):`);
            logsHeaderPrinted = true;
          }
        }
        for (const entry of entries) {
          if (entry.message) emitter.log(String(entry.message));
        }
        if (typeof logsResp.next_offset === "string") {
          logOffset = logsResp.next_offset;
        }
        if (hasOutput) setProgress(`${status}...`);
      } catch {
        // best-effort log streaming
      }
    };

    const onInterrupt: BuildResult["onInterrupt"] = (revisionId) => {
      emitter.warn(
        `\nInterrupted. Deployment ID: ${args.deploymentId}, Revision ID: ${revisionId}`
      );
      emitter.warn("The build will continue remotely.");
    };

    return {
      updated: rec(updated),
      progressMessage: "",
      timeoutSeconds: 900,
      pollIntervalSeconds: 3,
      noResultMessage: "Build triggered",
      onPoll,
      onInterrupt,
      showBuildLogsOnFailure: true,
    };
  } finally {
    await archive.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Main deploy orchestration
// ---------------------------------------------------------------------------

interface DeployOptions {
  config: string;
  apiKey?: string;
  name?: string;
  deploymentId?: string;
  deploymentType: string;
  wait: boolean;
  verbose: boolean;
  hostUrl: string;
  imageName?: string;
  tag: string;
  pull: boolean;
  baseImage?: string;
  installCommand?: string;
  buildCommand?: string;
  apiVersion?: string;
  remote: boolean;
  json: boolean;
  input: boolean;
}

async function runDeploy(
  dockerBuildArgs: string[],
  opts: DeployOptions,
  remoteBuildFlag: boolean | undefined
): Promise<void> {
  emitter = new Emitter(opts.json);
  noInput = !opts.input;

  emitter.note(
    "Note: 'langgraphjs deploy' is in beta. Expect frequent updates and improvements."
  );
  if (!opts.json) process.stdout.write("\n");

  if (!["dev", "prod"].includes(opts.deploymentType)) {
    throw new Error(
      `Invalid --deployment-type '${opts.deploymentType}' (expected 'dev' or 'prod').`
    );
  }

  // -- 1. Preflight --
  validateDeployCommands(opts.installCommand, opts.buildCommand);
  const configPath = await getProjectPath(opts.config);
  const rawConfig = JSON.parse(await fs.readFile(configPath, "utf-8"));
  const config = getConfig(rawConfig);
  warnNonWolfiDistro(rawConfig);

  const envVars = await parseEnvFromConfig(rawConfig, configPath);

  let name = opts.name;
  let deploymentId = opts.deploymentId;
  if (!deploymentId && !name) {
    name = envVars[DEPLOYMENT_NAME_ENV] ?? process.env[DEPLOYMENT_NAME_ENV];
  }
  if (!deploymentId && !name) {
    const defaultName = normalizeName(path.basename(process.cwd()));
    name = noInput
      ? defaultName
      : await promptText("Deployment name", defaultName);
  }
  if (name && !deploymentId) {
    name = normalizeName(name);
    if (!noInput) {
      const envPath = await resolveEnvPath(rawConfig, configPath);
      if (envPath) {
        await setEnvKey(envPath, DEPLOYMENT_NAME_ENV, name);
        emitter.info(`Saved deployment name to ${envPath}`);
      }
    }
  }

  const secrets = secretsFromEnv(envWithoutDeploymentName(envVars), (skipped) =>
    emitter.note(`Skipping reserved env var: ${skipped}`)
  );

  const [useRemoteBuild, localBuildError] =
    await resolveBuildMode(remoteBuildFlag);
  if (useRemoteBuild && remoteBuildFlag === undefined && localBuildError) {
    emitter.note(`${localBuildError}\nUsing remote build instead.`);
    if (!opts.json) process.stdout.write("\n");
  }

  // -- 2. Resolve / create deployment --
  const client = await createHostBackendClient(
    opts.hostUrl,
    opts.apiKey,
    envVars
  );
  let step = 1;

  const resolved = await resolveDeployment(
    client,
    step,
    deploymentId,
    name,
    useRemoteBuild
      ? "No deployment found. Will create."
      : "No deployment found. Will create after build."
  );
  deploymentId = resolved.deploymentId;
  step = resolved.step;

  if (resolved.needsCreation) {
    const created = await createDeployment(client, step, {
      name: name as string,
      deploymentType: opts.deploymentType,
      source: useRemoteBuild ? "internal_source" : "internal_docker",
      secrets,
    });
    deploymentId = created.id;
    step = created.step;
  }

  if (!deploymentId) {
    throw new Error("Failed to determine deployment ID");
  }

  // -- 3. Build (divergent path) --
  const buildResult = useRemoteBuild
    ? await runRemoteBuild({
        client,
        deploymentId,
        step,
        configPath,
        verbose: opts.verbose,
        installCommand: opts.installCommand,
        buildCommand: opts.buildCommand,
        secrets,
      })
    : await runLocalBuild({
        client,
        deploymentId,
        step,
        configPath,
        config,
        verbose: opts.verbose,
        pull: opts.pull,
        apiVersion: opts.apiVersion,
        baseImage: opts.baseImage,
        imageName: opts.imageName,
        name,
        tag: opts.tag,
        installCommand: opts.installCommand,
        buildCommand: opts.buildCommand,
        dockerBuildArgs,
        secrets,
      });

  // -- 4. Shared wait + result --
  const depStatusUrl = emitDeploymentStatusUrl(
    buildResult.updated,
    deploymentId,
    opts.hostUrl
  );

  if (!opts.wait) {
    emitter.info(buildResult.noResultMessage);
    return;
  }

  const [lastStatus, revisionId] = await pollRevisionStatus(
    client,
    deploymentId,
    {
      progressMessage: buildResult.progressMessage,
      timeoutSeconds: buildResult.timeoutSeconds,
      pollIntervalSeconds: buildResult.pollIntervalSeconds,
      onPoll: buildResult.onPoll,
      onInterrupt: buildResult.onInterrupt,
    }
  );
  if (!lastStatus) {
    emitter.info(buildResult.noResultMessage);
    return;
  }

  if (
    buildResult.showBuildLogsOnFailure &&
    lastStatus === "BUILD_FAILED" &&
    !opts.verbose &&
    revisionId
  ) {
    emitter.error("Last build log lines:");
    try {
      const logsResp = await client.getBuildLogs(deploymentId, revisionId, {
        order: "desc",
        limit: 30,
      });
      const entries = Array.isArray(logsResp.logs)
        ? [...(logsResp.logs as Record<string, unknown>[])].reverse()
        : [];
      for (const entry of entries) {
        if (entry.message) emitter.log(String(entry.message));
      }
    } catch {
      emitter.error("(failed to fetch build logs)");
    }
    emitter.warn("Re-run with --verbose to see full build output.");
  }

  await printDeploymentResult(client, deploymentId, lastStatus, {
    dashboardLabel: "Deployment dashboard",
    statusUrl: depStatusUrl,
  });
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function runList(opts: {
  apiKey?: string;
  hostUrl: string;
  nameContains: string;
}): Promise<void> {
  emitter = new Emitter(false);
  noInput = false;
  const client = await createHostBackendClient(opts.hostUrl, opts.apiKey);
  const response = await callWithOptionalTenant(client, (c) =>
    c.listDeployments(opts.nameContains)
  );
  const resources = Array.isArray(rec(response).resources)
    ? (rec(response).resources as unknown[])
    : [];
  const deployments = resources.filter(isPlainObject) as Record<
    string,
    unknown
  >[];
  if (!deployments.length) {
    process.stdout.write("No deployments found.\n");
    return;
  }
  process.stdout.write(`${formatDeploymentsTable(deployments)}\n`);
}

async function runRevisionsList(
  deploymentId: string,
  opts: { apiKey?: string; hostUrl: string; limit: string }
): Promise<void> {
  emitter = new Emitter(false);
  noInput = false;
  const client = await createHostBackendClient(opts.hostUrl, opts.apiKey);
  const limit = Number.parseInt(opts.limit, 10) || 10;
  const response = await callWithOptionalTenant(client, (c) =>
    c.listRevisions(deploymentId, limit)
  );
  const resources = Array.isArray(rec(response).resources)
    ? (rec(response).resources as unknown[])
    : [];
  const revisions = resources.filter(isPlainObject) as Record<
    string,
    unknown
  >[];
  if (!revisions.length) {
    process.stdout.write(
      `No revisions found for deployment ${deploymentId}.\n`
    );
    return;
  }
  process.stdout.write(`${formatRevisionsTable(revisions)}\n`);
}

async function runDelete(
  deploymentId: string,
  opts: { apiKey?: string; hostUrl: string; force: boolean }
): Promise<void> {
  emitter = new Emitter(false);
  noInput = false;
  if (!opts.force) {
    const confirmed = await confirm(
      paint(
        `Are you sure you want to delete deployment ID ${deploymentId}? (Y/n)`,
        "yellow"
      )
    );
    if (!confirmed) {
      process.stdout.write("Aborted.\n");
      gracefulExit(1);
      return;
    }
  }
  const client = await createHostBackendClient(opts.hostUrl, opts.apiKey);
  await callWithOptionalTenant(client, (c) => c.deleteDeployment(deploymentId));
  process.stdout.write(paint(`Deleted deployment ${deploymentId}.\n`, "green"));
}

interface LogsOptions {
  apiKey?: string;
  name?: string;
  deploymentId?: string;
  type: string;
  revisionId?: string;
  level?: string;
  limit: string;
  query?: string;
  startTime?: string;
  endTime?: string;
  follow: boolean;
  hostUrl: string;
}

async function runLogs(opts: LogsOptions): Promise<void> {
  emitter = new Emitter(false);
  noInput = false;

  const envVars = await parseEnvFromConfig(
    {},
    path.join(process.cwd(), "langgraph.json")
  );
  const client = await createHostBackendClient(
    opts.hostUrl,
    opts.apiKey,
    envVars
  );

  let name = opts.name;
  if (!opts.deploymentId && !name) {
    name = envVars[DEPLOYMENT_NAME_ENV] ?? process.env[DEPLOYMENT_NAME_ENV];
  }
  if (!opts.deploymentId && !name) {
    throw new Error("Either --deployment-id or --name is required.");
  }

  let depId: string;
  if (opts.deploymentId) {
    depId = opts.deploymentId;
  } else {
    const response = await callWithOptionalTenant(client, (c) =>
      c.listDeployments(name)
    );
    const found = findDeploymentIdByName(response, name);
    if (!found) throw new Error(`Deployment '${name}' not found.`);
    depId = found;
  }

  let revisionId = opts.revisionId;
  if (opts.type === "build" && !revisionId) {
    const revisionsResp = await client.listRevisions(depId, 1);
    const resources = Array.isArray(rec(revisionsResp).resources)
      ? (rec(revisionsResp).resources as unknown[])
      : [];
    if (!resources.length) {
      throw new Error(
        "No revisions found for this deployment. Cannot fetch build logs."
      );
    }
    revisionId = String(rec(resources[0]).id);
    process.stdout.write(
      paint(`Using latest revision: ${revisionId}\n`, "cyan")
    );
  }

  const limit = Number.parseInt(opts.limit, 10) || 100;
  const payload: Record<string, unknown> = { limit, order: "desc" };
  if (opts.level) payload.level = opts.level.toUpperCase();
  if (opts.query) payload.query = opts.query;
  if (opts.startTime) payload.start_time = opts.startTime;
  if (opts.endTime) payload.end_time = opts.endTime;

  const fetchLogs = async (
    requestPayload: Record<string, unknown>
  ): Promise<Record<string, unknown>[]> => {
    const resp =
      opts.type === "build"
        ? await client.getBuildLogs(depId, revisionId as string, requestPayload)
        : await client.getDeployLogs(depId, requestPayload, revisionId);
    const logs = rec(resp).logs;
    return Array.isArray(logs) ? (logs as Record<string, unknown>[]) : [];
  };

  const printEntries = (
    entries: Record<string, unknown>[],
    reverse = false
  ): void => {
    const iterable = reverse ? [...entries].reverse() : entries;
    for (const entry of iterable) {
      const line = formatLogEntry(entry);
      const color = levelColor(entry.level);
      process.stdout.write(`${color ? paint(line, color) : line}\n`);
    }
  };

  const initial = await fetchLogs(payload);
  printEntries(initial, true);

  if (!opts.follow) {
    if (!initial.length) {
      process.stdout.write(paint("No log entries found.\n", "yellow"));
    }
    return;
  }

  payload.order = "asc";
  const seenIds = new Set<string>();
  for (const entry of initial) {
    if (entry.id) seenIds.add(String(entry.id));
  }

  const updateStartTime = (ts: unknown): void => {
    if (ts == null) return;
    if (typeof ts === "number") {
      payload.start_time = new Date(ts).toISOString();
    } else {
      payload.start_time = String(ts);
    }
  };

  if (initial.length) updateStartTime(initial[0].timestamp);

  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
    process.stdout.write("\nStopped.\n");
    gracefulExit(0);
  });

  while (!stopped) {
    await sleep(2000);
    const entries = await fetchLogs(payload);
    const fresh = entries.filter(
      (entry) => !seenIds.has(String(entry.id ?? ""))
    );
    if (fresh.length) {
      printEntries(fresh);
      for (const entry of fresh) {
        if (entry.id) seenIds.add(String(entry.id));
      }
      updateStartTime(fresh[fresh.length - 1].timestamp);
    }
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

const deploy = builder
  .command("deploy")
  .description(
    "[Beta] Build and deploy a LangGraph image to LangSmith Deployment."
  )
  .option("-c, --config <path>", "Path to configuration file", process.cwd())
  .option(
    "--api-key <key>",
    "API key (or LANGGRAPH_HOST_API_KEY / LANGSMITH_API_KEY / LANGCHAIN_API_KEY)."
  )
  .option(
    "--name <name>",
    "Deployment name (or LANGSMITH_DEPLOYMENT_NAME). Defaults to the current directory name."
  )
  .option("--deployment-id <id>", "ID of an existing deployment to update.")
  .option(
    "--deployment-type <type>",
    "Deployment type when creating: 'dev' or 'prod'.",
    "dev"
  )
  .option("--no-wait", "Skip waiting for deployment status.")
  .option("--verbose", "Show more output from the server logs.", false)
  .option("--host-url <url>", "Host backend URL.", DEFAULT_HOST_URL)
  .option("--image-name <name>", "Image repository name for the pushed image.")
  .option(
    "-t, --tag <tag>",
    "Tag to use for the pushed deployment image.",
    "latest"
  )
  .option(
    "--no-pull",
    "Do not pull the latest base image before building locally."
  )
  .option("--base-image <image>", "Override the base image.")
  .option("--install-command <cmd>", "Custom install command (remote build).")
  .option("--build-command <cmd>", "Custom build command (remote build).")
  .option("--api-version <version>", "Pin the langgraph-api version.")
  .option("--remote", "Force a remote build.")
  .option("--no-remote", "Force a local build.")
  .option(
    "--json",
    "Emit structured JSON-lines to stdout instead of human-readable text.",
    false
  )
  .option(
    "--no-input",
    "Never prompt for input; fail with an error if a required value is missing."
  )
  .argument(
    "[dockerBuildArgs...]",
    "Extra arguments passed through to docker build"
  )
  .passThroughOptions()
  .allowUnknownOption()
  .exitOverride((error) => gracefulExit(error.exitCode))
  .hook(
    "preAction",
    withAnalytics((command) => ({
      config: command.opts().config !== process.cwd(),
      remote: command.opts().remote !== true,
      json: !!command.opts().json,
      no_wait: !command.opts().wait,
      deployment_id: !!command.opts().deploymentId,
    }))
  )
  .action(
    action(async (dockerBuildArgs, opts, command) => {
      const source = command.getOptionValueSource("remote");
      const remoteBuildFlag = source === "cli" ? opts.remote : undefined;
      await runDeploy(
        dockerBuildArgs ?? [],
        opts as DeployOptions,
        remoteBuildFlag
      );
    })
  );

deploy
  .command("list")
  .description("[Beta] List LangSmith Deployments.")
  .option("--api-key <key>", "API key.")
  .option("--host-url <url>", "Host backend URL.", DEFAULT_HOST_URL)
  .option(
    "--name-contains <value>",
    "Only show deployments whose names contain this value.",
    ""
  )
  .exitOverride((error) => gracefulExit(error.exitCode))
  .action(
    action(async (opts) => {
      await runList(opts);
    })
  );

const revisions = deploy
  .command("revisions")
  .description("[Beta] Manage deployment revisions.");

revisions
  .command("list")
  .description("[Beta] List revisions for a LangSmith Deployment.")
  .argument("<deploymentId>", "Deployment ID (see 'deploy list').")
  .option("--api-key <key>", "API key.")
  .option("--host-url <url>", "Host backend URL.", DEFAULT_HOST_URL)
  .option("--limit <n>", "Maximum number of revisions to return.", "10")
  .exitOverride((error) => gracefulExit(error.exitCode))
  .action(
    action(async (deploymentId, opts) => {
      await runRevisionsList(deploymentId, opts);
    })
  );

deploy
  .command("delete")
  .description("[Beta] Delete a LangSmith Deployment.")
  .argument("<deploymentId>", "Deployment ID (see 'deploy list').")
  .option("--api-key <key>", "API key.")
  .option("--host-url <url>", "Host backend URL.", DEFAULT_HOST_URL)
  .option("--force", "Delete without prompting for confirmation.", false)
  .exitOverride((error) => gracefulExit(error.exitCode))
  .action(
    action(async (deploymentId, opts) => {
      await runDelete(deploymentId, opts);
    })
  );

deploy
  .command("logs")
  .description("[Beta] Fetch LangSmith Deployment logs.")
  .option("--api-key <key>", "API key.")
  .option("--name <name>", "Deployment name (or LANGSMITH_DEPLOYMENT_NAME).")
  .option("--deployment-id <id>", "Deployment ID.")
  .option(
    "--type <type>",
    "Log stream: 'deploy' (runtime) or 'build' (remote build logs).",
    "deploy"
  )
  .option("--revision-id <id>", "Specific revision ID.")
  .option("--level <level>", "Filter by log level.")
  .option("--limit <n>", "Max log entries to fetch.", "100")
  .option("-q, --query <query>", "Search string filter.")
  .option("--start-time <ts>", "ISO8601 start time.")
  .option("--end-time <ts>", "ISO8601 end time.")
  .option("-f, --follow", "Continuously poll for new logs.", false)
  .option("--host-url <url>", "Host backend URL.", DEFAULT_HOST_URL)
  .exitOverride((error) => gracefulExit(error.exitCode))
  .action(
    action(async (opts) => {
      await runLogs(opts as LogsOptions);
    })
  );
