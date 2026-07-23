import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  envWithoutDeploymentName,
  findDeploymentIdByName,
  formatDeploymentsTable,
  formatLogEntry,
  formatRevisionsTable,
  formatTimestamp,
  getDeploymentStatusUrl,
  hasDisallowedBuildCommandContent,
  isPathWithin,
  levelColor,
  normalizeImageTag,
  normalizeName,
  secretsFromEnv,
  smithDashboardBaseUrl,
} from "../src/cli/utils/deploy-helpers.mjs";

describe("normalizeName", () => {
  it("lowercases and replaces invalid characters", () => {
    expect(normalizeName("My Project!")).toBe("my-project");
    expect(normalizeName("__Weird__Name__")).toBe("weird-name");
    expect(normalizeName("already-valid")).toBe("already-valid");
  });

  it("falls back to 'app' for empty or fully invalid input", () => {
    expect(normalizeName("")).toBe("app");
    expect(normalizeName(undefined)).toBe("app");
    expect(normalizeName("!!!")).toBe("app");
  });
});

describe("normalizeImageTag", () => {
  it("defaults to latest", () => {
    expect(normalizeImageTag("")).toBe("latest");
  });

  it("accepts valid tags", () => {
    expect(normalizeImageTag("v1.2.3-rc_1")).toBe("v1.2.3-rc_1");
  });

  it("rejects invalid tags", () => {
    expect(() => normalizeImageTag("bad/tag")).toThrow();
    expect(() => normalizeImageTag("bad tag")).toThrow();
  });
});

describe("hasDisallowedBuildCommandContent", () => {
  it("flags shell metacharacters", () => {
    expect(hasDisallowedBuildCommandContent("rm -rf / | cat")).toBe(true);
    expect(hasDisallowedBuildCommandContent("echo $HOME")).toBe(true);
    expect(hasDisallowedBuildCommandContent("a & b")).toBe(true);
  });

  it("allows command chaining with &&", () => {
    expect(hasDisallowedBuildCommandContent("npm i && npm run build")).toBe(
      false
    );
    expect(hasDisallowedBuildCommandContent("pip install -r reqs.txt")).toBe(
      false
    );
  });
});

describe("secretsFromEnv", () => {
  it("filters reserved vars and empty values", () => {
    const skipped: string[] = [];
    const secrets = secretsFromEnv(
      {
        MY_SECRET: "value",
        LANGCHAIN_API_KEY: "reserved",
        EMPTY: "",
        ANOTHER: "ok",
      },
      (name) => skipped.push(name)
    );
    expect(secrets).toEqual([
      { name: "MY_SECRET", value: "value" },
      { name: "ANOTHER", value: "ok" },
    ]);
    expect(skipped).toEqual(["LANGCHAIN_API_KEY"]);
  });
});

describe("envWithoutDeploymentName", () => {
  it("drops the deployment-name key", () => {
    expect(
      envWithoutDeploymentName({
        LANGSMITH_DEPLOYMENT_NAME: "x",
        FOO: "bar",
      })
    ).toEqual({ FOO: "bar" });
  });
});

describe("formatDeploymentsTable", () => {
  it("renders id, name and url columns", () => {
    const table = formatDeploymentsTable([
      {
        id: "dep-1",
        name: "my-app",
        source_config: { custom_url: "https://example.com" },
      },
      { id: "dep-2", name: "other" },
    ]);
    expect(table).toContain("Deployment ID");
    expect(table).toContain("https://example.com");
    expect(table).toContain("dep-2");
    // missing url becomes "-"
    expect(table.split("\n").at(-1)).toContain("-");
  });
});

describe("formatRevisionsTable", () => {
  it("marks superseded DEPLOYED revisions as REPLACED", () => {
    const table = formatRevisionsTable([
      { id: "r1", status: "DEPLOYED", created_at: "t1" },
      { id: "r2", status: "DEPLOYED", created_at: "t0" },
    ]);
    const lines = table.split("\n");
    expect(lines[2]).toContain("DEPLOYED");
    expect(lines[3]).toContain("REPLACED");
  });
});

describe("formatTimestamp / formatLogEntry / levelColor", () => {
  it("formats epoch millis as UTC", () => {
    expect(formatTimestamp(0)).toBe("1970-01-01 00:00:00");
  });

  it("formats log entries with level + timestamp", () => {
    expect(
      formatLogEntry({ timestamp: 0, level: "INFO", message: "hi" })
    ).toBe("[1970-01-01 00:00:00] [INFO] hi");
    expect(formatLogEntry({ message: "plain" })).toBe("plain");
  });

  it("maps levels to colors", () => {
    expect(levelColor("ERROR")).toBe("red");
    expect(levelColor("critical")).toBe("red");
    expect(levelColor("WARNING")).toBe("yellow");
    expect(levelColor("INFO")).toBeUndefined();
  });
});

describe("smithDashboardBaseUrl", () => {
  it("maps the prod api host", () => {
    expect(smithDashboardBaseUrl("https://api.host.langchain.com")).toBe(
      "https://smith.langchain.com"
    );
  });

  it("maps regional api hosts", () => {
    expect(smithDashboardBaseUrl("https://eu.api.host.langchain.com")).toBe(
      "https://eu.smith.langchain.com"
    );
  });

  it("passes through localhost", () => {
    expect(smithDashboardBaseUrl("http://localhost:8000/")).toBe(
      "http://localhost:8000"
    );
  });

  it("defaults for unknown hosts", () => {
    expect(smithDashboardBaseUrl(undefined)).toBe(
      "https://smith.langchain.com"
    );
    expect(smithDashboardBaseUrl("https://example.com")).toBe(
      "https://smith.langchain.com"
    );
  });
});

describe("getDeploymentStatusUrl", () => {
  it("builds the dashboard url when tenant_id present", () => {
    expect(
      getDeploymentStatusUrl(
        { tenant_id: "tenant-1" },
        "dep-1",
        "https://api.host.langchain.com"
      )
    ).toBe("https://smith.langchain.com/o/tenant-1/host/deployments/dep-1");
  });

  it("returns null without a tenant_id", () => {
    expect(getDeploymentStatusUrl({}, "dep-1")).toBeNull();
  });
});

describe("isPathWithin", () => {
  const project = path.resolve("/tmp/project");

  it("accepts files inside the project directory", () => {
    expect(isPathWithin(project, path.resolve(project, ".env"))).toBe(true);
    expect(
      isPathWithin(project, path.resolve(project, "config/.env"))
    ).toBe(true);
  });

  it("rejects traversal paths that escape the project", () => {
    expect(
      isPathWithin(project, path.resolve(project, "../../.aws/credentials"))
    ).toBe(false);
    expect(isPathWithin(project, path.resolve(project, "../secret"))).toBe(
      false
    );
  });

  it("rejects absolute paths outside the project", () => {
    expect(isPathWithin(project, path.resolve("/etc/passwd"))).toBe(false);
  });

  it("rejects the project directory itself (no descendant)", () => {
    expect(isPathWithin(project, project)).toBe(false);
  });
});

describe("findDeploymentIdByName", () => {
  it("returns id for exact name match", () => {
    const response = {
      resources: [
        { id: "1", name: "foobar" },
        { id: "2", name: "foo" },
      ],
    };
    expect(findDeploymentIdByName(response, "foo")).toBe("2");
  });

  it("returns null when no exact match", () => {
    expect(
      findDeploymentIdByName({ resources: [{ id: "1", name: "foobar" }] }, "foo")
    ).toBeNull();
    expect(findDeploymentIdByName({ resources: [] }, "foo")).toBeNull();
    expect(findDeploymentIdByName(null, "foo")).toBeNull();
  });
});
