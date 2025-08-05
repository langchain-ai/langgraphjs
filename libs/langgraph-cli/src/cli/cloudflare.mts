import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Readable, Transform, Writable } from "node:stream";

import { ChildProcess, spawn } from "node:child_process";
import { extract as tarExtract } from "tar";
import * as nodeStream from "node:stream/web";
import { fileURLToPath } from "node:url";

import { logger } from "../utils/logging.mjs";
import { BytesLineDecoder } from "./utils/stream.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLOUDFLARED_VERSION = "2025.2.1";

const CLOUDFLARED_CACHE_DIR = path.join(
  __dirname,
  ".cloudflare",
  CLOUDFLARED_VERSION
);

const writeFile = async (path: string, stream: ReadableStream | null) => {
  if (stream == null) throw new Error("Stream is null");
  return await fs.writeFile(
    path,
    Readable.fromWeb(stream as nodeStream.ReadableStream)
  );
};

class CloudflareLoggerStream extends WritableStream<Uint8Array> {
  constructor() {
    const decoder = new TextDecoder();
    super({
      write(chunk) {
        const text = decoder.decode(chunk);
        const [_timestamp, level, ...rest] = text.split(" ");
        const message = rest.join(" ");
        if (level === "INF") {
          logger.debug(message);
        } else if (level === "ERR") {
          logger.error(message);
        } else {
          logger.info(message);
        }
      },
    });
  }

  fromWeb() {
    return Writable.fromWeb(this);
  }
}

class CloudflareUrlStream extends TransformStream<Uint8Array, string> {
  constructor() {
    const decoder = new TextDecoder();
    super({
      transform(chunk, controller) {
        const str = decoder.decode(chunk);
        const urlMatch = str.match(
          /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
        )?.[0];

        if (urlMatch) controller.enqueue(urlMatch);
      },
    });
  }

  fromWeb() {
    // @ts-expect-error
    return Transform.fromWeb(this, { objectMode: true });
  }
}

export async function startCloudflareTunnel(
  port: string
): Promise<CloudflareTunnel> {
  const targetBinaryPath = await ensureCloudflared();
  logger.info("Starting tunnel");

  const child = spawn(
    targetBinaryPath,
    ["tunnel", "--url", `http://localhost:${port}`],
    { stdio: ["inherit", "pipe", "pipe"] }
  );

  child.stdout
    .pipe(new BytesLineDecoder().fromWeb())
    .pipe(new CloudflareLoggerStream().fromWeb());

  child.stderr
    .pipe(new BytesLineDecoder().fromWeb())
    .pipe(new CloudflareLoggerStream().fromWeb());

  const tunnelUrl = new Promise<string>((resolve) => {
    child.stderr
      .pipe(new CloudflareUrlStream().fromWeb())
      .once("data", (data: string) => {
        logger.info(`Tunnel URL: "${data}"`);
        resolve(data);
      });
  });

  return { child, tunnelUrl };
}

export interface CloudflareTunnel {
  child: ChildProcess;
  tunnelUrl: Promise<string>;
}

function getFiles(): { binary: string; archive?: string } {
  const platform = getPlatform();
  const arch = getArchitecture();

  if (platform === "windows") {
    if (arch !== "386" && arch !== "amd64") {
      throw new Error(`Unsupported architecture: ${arch}`);
    }
    return { binary: `cloudflared-${platform}-${arch}.exe` };
  }

  if (platform === "darwin") {
    if (arch !== "arm64" && arch !== "amd64") {
      throw new Error(`Unsupported architecture: ${arch}`);
    }
    return {
      archive: `cloudflared-${platform}-${arch}.tgz`,
      binary: "cloudflared",
    };
  }

  if (platform === "linux") {
    if (arch !== "arm64" && arch !== "amd64" && arch !== "386") {
      throw new Error(`Unsupported architecture: ${arch}`);
    }
    return { binary: `cloudflared-${platform}-${arch}` };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

async function downloadCloudflared() {
  await fs.mkdir(CLOUDFLARED_CACHE_DIR, { recursive: true });

  logger.info("Requesting download of `cloudflared`");
  const { binary, archive } = getFiles();
  const downloadFile = archive ?? binary;

  const tempDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "cloudflared-"));
  const tempFilePath = path.join(tempDirPath, downloadFile);

  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${downloadFile}`;
  logger.debug("Downloading `${archive}`", { url, target: tempDirPath });

  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download cloudflared: ${response.statusText}`);
  }

  await writeFile(tempFilePath, response.body);

  if (archive != null) {
    if (path.extname(archive) !== ".tgz") {
      throw new Error(`Invalid archive type: "${path.extname(archive)}"`);
    }

    logger.debug("Extracting `cloudflared`");
    await tarExtract({ file: tempFilePath, cwd: tempDirPath });
  }

  const sourceBinaryPath = path.resolve(tempDirPath, binary);
  const targetBinaryPath = path.resolve(CLOUDFLARED_CACHE_DIR, binary);

  logger.debug("Moving `cloudflared` to target directory", {
    targetBinaryPath,
  });
  await fs.rename(sourceBinaryPath, targetBinaryPath);
  await fs.chmod(targetBinaryPath, 0o755);
}

async function ensureCloudflared(): Promise<string> {
  const { binary } = getFiles();
  const targetBinaryPath = path.resolve(CLOUDFLARED_CACHE_DIR, binary);
  try {
    await fs.access(targetBinaryPath);
  } catch {
    await downloadCloudflared();
  }

  return targetBinaryPath;
}

function getArchitecture(): "386" | "amd64" | "arm64" {
  const arch = os.arch();
  switch (arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    case "ia32":
    case "x86":
      return "386";
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }
}

function getPlatform(): "darwin" | "linux" | "windows" {
  const platform = os.platform();
  switch (platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
