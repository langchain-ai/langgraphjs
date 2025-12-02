import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { extract as tarExtract } from "tar";
import zipExtract from "extract-zip";

import { logger } from "../utils/logging.mjs";
import type { Config } from "../utils/config.mjs";
import { assembleLocalDeps } from "../docker/docker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UV_VERSION = "0.9.11";
const UV_BINARY_CACHE = path.join(__dirname, ".uv", UV_VERSION);

interface UvBinaryInfo {
  platform: string;
  arch: string;
  extension: string;
  binaryName: string;
}

function getPlatformInfo(): UvBinaryInfo {
  const platform = os.platform();
  const arch = os.arch();

  let binaryName = "uv";
  let extension = "";

  if (platform === "win32") {
    extension = ".exe";
  }

  return {
    platform,
    arch,
    extension,
    binaryName: binaryName + extension,
  };
}

function getDownloadUrl(info: UvBinaryInfo): string {
  let platformStr: string;

  switch (info.platform) {
    case "darwin":
      platformStr = "apple-darwin";
      break;
    case "win32":
      platformStr = "pc-windows-msvc";
      break;
    case "linux":
      platformStr = "unknown-linux-gnu";
      break;
    default:
      throw new Error(`Unsupported platform: ${info.platform}`);
  }

  let archStr: string;
  switch (info.arch) {
    case "x64":
      archStr = "x86_64";
      break;
    case "arm64":
      archStr = "aarch64";
      break;
    default:
      throw new Error(`Unsupported architecture: ${info.arch}`);
  }

  const fileName = `uv-${archStr}-${platformStr}${
    info.platform === "win32" ? ".zip" : ".tar.gz"
  }`;
  return `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${fileName}`;
}

async function downloadAndExtract(
  url: string,
  destPath: string,
  info: UvBinaryInfo
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to download uv: ${response.statusText}`);
  if (!response.body) throw new Error("No response body");

  const tempDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "uv-"));
  const tempFilePath = path.join(tempDirPath, path.basename(url));

  try {
    // @ts-expect-error invalid types for response.body
    await fs.writeFile(tempFilePath, Readable.fromWeb(response.body));

    let sourceBinaryPath = tempDirPath;
    if (url.endsWith(".zip")) {
      await zipExtract(tempFilePath, { dir: tempDirPath });
    } else {
      await tarExtract({ file: tempFilePath, cwd: tempDirPath });
      sourceBinaryPath = path.resolve(
        sourceBinaryPath,
        path.basename(tempFilePath).slice(0, ".tar.gz".length * -1)
      );
    }
    sourceBinaryPath = path.resolve(sourceBinaryPath, info.binaryName);

    // Move binary to cache directory
    const targetBinaryPath = path.join(destPath, info.binaryName);

    // Just copy the file directly (it's a single executable, not a directory)
    await fs.copyFile(sourceBinaryPath, targetBinaryPath);
    await fs.chmod(targetBinaryPath, 0o755);

    return targetBinaryPath;
  } finally {
    await fs.rm(tempDirPath, { recursive: true, force: true });
  }
}

export async function getUvBinary(): Promise<string> {
  await fs.mkdir(UV_BINARY_CACHE, { recursive: true });

  const info = getPlatformInfo();
  const cachedBinaryPath = path.join(UV_BINARY_CACHE, info.binaryName);

  try {
    await fs.access(cachedBinaryPath);
    return cachedBinaryPath;
  } catch {
    // Binary not found in cache, download it
    logger.info(`Downloading uv ${UV_VERSION} for ${info.platform}...`);
    const url = getDownloadUrl(info);
    return await downloadAndExtract(url, UV_BINARY_CACHE, info);
  }
}

export async function spawnPythonServer(
  args: {
    host: string;
    port: string;
    nJobsPerWorker: string;
    browser: boolean;
    rest: string[];
  },
  context: {
    configPath: string;
    config: Config;
    hostUrl: string;
    env: NodeJS.ProcessEnv;
  },
  options: {
    pid: number;
    projectCwd: string;
  }
) {
  const deps = await assembleLocalDeps(context.configPath, context.config);
  const requirements = deps.rebuildFiles.filter((i) => i.endsWith(".txt"));

  return spawn(
    await getUvBinary(),
    [
      "run",
      "--with",
      "langgraph-cli[inmem]",
      ...requirements?.flatMap((i) => ["--with-requirements", i]),
      "langgraph",
      "dev",
      "--port",
      args.port,
      "--host",
      args.host,
      "--n-jobs-per-worker",
      args.nJobsPerWorker,
      "--config",
      context.configPath,
      ...(args.browser ? [] : ["--no-browser"]),
      ...args.rest,
    ],
    {
      stdio: ["inherit", "inherit", "inherit"],
      env: context.env,
      cwd: options.projectCwd,
    }
  );
}
