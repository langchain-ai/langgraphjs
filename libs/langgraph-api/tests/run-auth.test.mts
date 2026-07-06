import { describe, expect, it } from "vitest";

import type { AuthContext } from "../src/auth/index.mjs";
import {
  applyAuthToRunConfig,
  applyRequestHeadersToRunConfig,
} from "../src/utils/run-auth.mjs";

describe("applyAuthToRunConfig", () => {
  it("stamps langgraph_auth_user onto config.configurable", () => {
    const auth: AuthContext = {
      user: {
        identity: "user-123",
        permissions: [],
        display_name: "Test User",
        is_authenticated: true,
        mda_actor_id: "user-123",
      },
      scopes: ["threads:read", "threads:create_run"],
    };

    const config: { configurable?: Record<string, unknown> } = {
      configurable: { thread_id: "t1" },
    };
    const userId = applyAuthToRunConfig(config, auth);

    expect(userId).toBe("user-123");
    expect(config.configurable?.langgraph_auth_user).toEqual(auth.user);
    expect(config.configurable?.langgraph_auth_user_id).toBe("user-123");
    expect(config.configurable?.langgraph_auth_permissions).toEqual(
      auth.scopes
    );
  });

  it("returns undefined when auth is absent", () => {
    const config: { configurable?: Record<string, unknown> } = {};
    expect(applyAuthToRunConfig(config, undefined)).toBeUndefined();
    expect(config.configurable?.langgraph_auth_user).toBeUndefined();
  });
});

describe("applyRequestHeadersToRunConfig", () => {
  it("copies allowed x- headers and user-agent into configurable", () => {
    const config: { configurable?: Record<string, unknown> } = {};
    const headers = new Headers({
      "x-configurable-header": "hello",
      "x-api-key": "secret",
      "user-agent": "vitest",
    });

    applyRequestHeadersToRunConfig(config, headers);

    expect(config.configurable?.["x-configurable-header"]).toBe("hello");
    expect(config.configurable?.["user-agent"]).toBe("vitest");
    expect(config.configurable?.["x-api-key"]).toBeUndefined();
  });
});
