import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadAndExtract } from "../utils/extract.js";

interface TestZipEntry {
  name: string;
  content?: string;
}

function crc32(data: Buffer) {
  let checksum = 0xffffffff;

  for (const byte of data) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1));
    }
  }

  return (checksum ^ 0xffffffff) >>> 0;
}

function createZip(entries: TestZipEntry[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.content ?? "");
    const isDirectory = entry.name.endsWith("/");
    const compressedData = isDirectory ? data : deflateRawSync(data);
    const compressionMethod = isDirectory ? 0 : 8;
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);

    localParts.push(localHeader, name, compressedData);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(
      ((isDirectory ? 0o40755 : 0o100644) << 16) >>> 0,
      38
    );
    centralHeader.writeUInt32LE(localOffset, 42);

    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressedData.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function stubArchiveDownload(archive: Buffer) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(new Uint8Array(archive), {
        status: 200,
      })
    )
  );
}

async function expectMissing(filePath: string) {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("downloadAndExtract", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "create-langgraph-extract-")
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("extracts every template entry and removes the GitHub wrapper", async () => {
    const archive = createZip([
      { name: "template-main/" },
      {
        name: "template-main/package.json",
        content: '{"name":"fixture"}\n',
      },
      {
        name: "template-main/src/agent.ts",
        content: "export const graph = {};\n",
      },
      {
        name: "template-main/.env.example",
        content: "LANGSMITH_API_KEY=\n",
      },
      { name: "template-main/empty/" },
    ]);
    stubArchiveDownload(archive);
    const targetPath = path.join(tempRoot, "project");

    await downloadAndExtract("https://example.test/template.zip", targetPath);

    await expect(
      fs.readFile(path.join(targetPath, "package.json"), "utf8")
    ).resolves.toBe('{"name":"fixture"}\n');
    await expect(
      fs.readFile(path.join(targetPath, "src", "agent.ts"), "utf8")
    ).resolves.toBe("export const graph = {};\n");
    await expect(
      fs.readFile(path.join(targetPath, ".env.example"), "utf8")
    ).resolves.toBe("LANGSMITH_API_KEY=\n");
    expect((await fs.stat(path.join(targetPath, "empty"))).isDirectory()).toBe(
      true
    );
    await expectMissing(path.join(targetPath, "template-main"));
    await expectMissing(path.join(targetPath, "temp.zip"));
  });

  it("rejects out-of-bound entries and still removes the temporary ZIP", async () => {
    const archive = createZip([
      { name: "template-main/package.json", content: "{}\n" },
      { name: "../escaped.txt", content: "outside\n" },
    ]);
    stubArchiveDownload(archive);
    const targetPath = path.join(tempRoot, "project");

    await expect(
      downloadAndExtract("https://example.test/template.zip", targetPath)
    ).rejects.toThrow("Malicious entry: ../escaped.txt");

    await expectMissing(path.join(tempRoot, "escaped.txt"));
    await expectMissing(
      path.join(targetPath, "template-main", "package.json")
    );
    await expectMissing(path.join(targetPath, "temp.zip"));
  });
});
