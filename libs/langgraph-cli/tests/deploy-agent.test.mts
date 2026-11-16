import { beforeEach, expect, it, vi } from "vitest";
import {
  gracefulExit,
  json,
  runDeployCli,
  useDeployHarness,
} from "./deploy-harness.mjs";

const fetchMock = vi.fn();
const harness = useDeployHarness({
  env: { LANGSMITH_DEPLOYMENT_NAME: "also-ignore-me" },
});

beforeEach(() => {
  vi.stubEnv("LANGSMITH_AGENT_ID", "my-agent");
  vi.stubEnv("LANGSMITH_AGENT_ENVIRONMENT", "staging");
  vi.stubEnv("LANGSMITH_DEPLOYMENT_NAME", "ignore-me");
  vi.stubGlobal("fetch", fetchMock);
});

const run = (...args: string[]) =>
  runDeployCli(...args, "--host-url", "https://api.host.langchain.com");

// `sent` is the upload's headers apart from Content-Length.
const GCS_DEFAULTS = {
  "content-type": "application/gzip",
  "x-goog-content-length-range": "0,209715200",
};
const AGENT_DEPLOYS = [
  {
    label: "new deployment, returned headers",
    existing: false,
    uploadHeaders: {
      "Content-Type": "application/x-gzip",
      "x-ms-blob-type": "BlockBlob",
      "content-length": "1",
    } as unknown,
    sent: { "content-type": "application/x-gzip", "x-ms-blob-type": "BlockBlob" },
  },
  {
    label: "existing deployment, no returned headers",
    existing: true,
    uploadHeaders: undefined as unknown,
    sent: GCS_DEFAULTS,
  },
  {
    label: "returned headers without a Content-Type",
    existing: true,
    uploadHeaders: { "x-ms-blob-type": "BlockBlob" } as unknown,
    sent: { "content-type": "application/gzip", "x-ms-blob-type": "BlockBlob" },
  },
  {
    label: "malformed returned headers",
    existing: true,
    uploadHeaders: ["x-ms-blob-type", "BlockBlob"] as unknown,
    sent: GCS_DEFAULTS,
  },
];

it.each(AGENT_DEPLOYS)("deploys by agent ($label)", async (c) => {
  const { existing, uploadHeaders, sent } = c;
  fetchMock.mockResolvedValueOnce(
    json({
      resources: existing
        ? [{ id: "preview", is_preview: true }, { id: "dep-1" }]
        : [],
    })
  );
  if (!existing)
    fetchMock.mockResolvedValueOnce(
      json({ id: "dep-1", name: "generated-name" })
    );
  fetchMock.mockResolvedValueOnce(
    json({
      upload_url: "https://upload.example/source",
      object_path: "source",
      upload_headers: uploadHeaders,
    })
  );
  fetchMock.mockImplementationOnce(async (_url, init) => {
    await new Response(init.body).arrayBuffer();
    return json({});
  });
  fetchMock.mockResolvedValueOnce(json({ id: "dep-1" }));

  await run(
    "--config",
    harness.configPath,
    "--remote",
    "--no-wait",
    "--no-input",
    "--json"
  );

  const [url] = fetchMock.mock.calls[0];
  expect(new URL(url).searchParams.get("agent_id")).toBe("my-agent");
  expect(new URL(url).searchParams.get("agent_environment")).toBe("staging");
  expect(new URL(url).searchParams.get("name_contains")).toBe("");
  if (!existing) {
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      agent: { agent_id: "my-agent", environment: "staging" },
      source: "internal_source",
      source_config: { deployment_type: "dev" },
      source_revision_config: {},
      secrets: [],
    });
  }
  const [, upload] = fetchMock.mock.calls.find(
    ([url]) => url === "https://upload.example/source"
  )!;
  expect(Object.fromEntries(new Headers(upload.headers))).toEqual({
    ...sent,
    "content-length": "0",
  });
  const [updateUrl, update] = fetchMock.mock.calls.at(-1)!;
  expect(new URL(updateUrl).pathname).toBe("/v2/deployments/dep-1");
  expect(update.method).toBe("PATCH");
  expect(JSON.parse(update.body).revision_source).toBe("internal_source");
  expect(fetchMock).toHaveBeenCalledTimes(existing ? 4 : 5);
  expect(gracefulExit).not.toHaveBeenCalled();
  expect(
    harness.output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).message)
  ).toContain(
    "Note: --agent-id and --agent-environment flags are in private beta"
  );
});

it("lets list flags override environment defaults", async () => {
  vi.stubEnv("LANGSMITH_AGENT_ENVIRONMENT", "invalid");
  fetchMock.mockResolvedValueOnce(json({ resources: [] }));
  await run(
    "list",
    "--agent-id",
    "other-agent",
    "--agent-environment",
    "production"
  );
  const params = new URL(fetchMock.mock.calls[0][0]).searchParams;
  expect(params.get("agent_id")).toBe("other-agent");
  expect(params.get("agent_environment")).toBe("production");
  expect(gracefulExit).not.toHaveBeenCalled();
});

it("stops when the tenant cannot use agent filters", async () => {
  fetchMock.mockResolvedValueOnce(
    json({ detail: "Agent filters are not available for this tenant." }, 400)
  );
  await run("--config", harness.configPath, "--remote", "--no-input", "--json");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(gracefulExit).toHaveBeenCalledWith(1);
  expect(harness.output).toContain("Agent filters are not available for this tenant.");
});
