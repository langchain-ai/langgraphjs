import fs from "node:fs/promises";
import path from "node:path";

import StreamZip from "node-stream-zip";

async function extractArchive(archivePath: string, targetPath: string) {
  const archive = new StreamZip({ file: archivePath });

  try {
    await new Promise<void>((resolve, reject) => {
      archive.on("ready", resolve);
      archive.on("error", reject);
    });

    await new Promise<void>((resolve, reject) => {
      archive.extract(null, targetPath, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      archive.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

async function unwrapTemplateDirectory(targetPath: string) {
  const extractedDir = (await fs.readdir(targetPath)).find((entry) =>
    entry.endsWith("-main")
  );

  if (!extractedDir) {
    return;
  }

  const fullExtractedPath = path.join(targetPath, extractedDir);
  const files = await fs.readdir(fullExtractedPath);
  await Promise.all(
    files.map((file) =>
      fs.rename(path.join(fullExtractedPath, file), path.join(targetPath, file))
    )
  );
  await fs.rmdir(fullExtractedPath);
}

export async function downloadAndExtract(url: string, targetPath: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    await fs.mkdir(targetPath, { recursive: true });

    const tempFile = path.join(targetPath, "temp.zip");
    try {
      await fs.writeFile(tempFile, buffer);
      await extractArchive(tempFile, targetPath);
    } finally {
      await fs.rm(tempFile, { force: true });
    }

    await unwrapTemplateDirectory(targetPath);
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to download and extract template: ${error.message}`
      );
    }
    throw new Error("Failed to download and extract template");
  }
}
