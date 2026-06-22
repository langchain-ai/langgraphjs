/**
 * HTTP client for the LangGraph host backend (LangSmith Deployment).
 *
 * Ported from the Python CLI's `host_backend.py`. Uses the global `fetch`
 * with a small retry loop on transport-level failures.
 */

/**
 * A deployment secret (an environment variable injected into the running
 * deployment). Mirrors the `{name, value}` shape the host backend expects.
 */
export interface Secret {
  /** Environment variable name. */
  name: string;
  /** Environment variable value. */
  value: string;
}

/**
 * Error raised when the host backend returns a non-success response or a
 * request fails at the transport level.
 *
 * @remarks
 * {@link statusCode} is populated for HTTP error responses and left
 * `undefined` for transport-level failures (network, DNS, timeout).
 */
export class HostBackendError extends Error {
  /** HTTP status code, when the failure came from an HTTP error response. */
  statusCode?: number;

  /**
   * @param message - Human-readable error description.
   * @param statusCode - HTTP status code, if the error came from a response.
   */
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "HostBackendError";
    this.statusCode = statusCode;
  }
}

/** Options for a single {@link HostBackendClient} request. */
interface RequestOptions {
  /** JSON body to send (serialized with `JSON.stringify`). */
  payload?: unknown;
  /** Query-string parameters; `undefined`/`null` values are skipped. */
  params?: Record<string, string | number | undefined>;
}

/** Number of times a transport-level failure is retried before giving up. */
const TRANSPORT_RETRIES = 3;
/** Per-request timeout in milliseconds, enforced via `AbortController`. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Minimal JSON HTTP client for the host backend deployment service.
 *
 * @remarks
 * Wraps the global `fetch`, attaching the API-key (and optional tenant)
 * headers to every request, retrying transport-level failures, and decoding
 * JSON responses. All methods reject with a {@link HostBackendError} on
 * failure.
 */
export class HostBackendClient {
  /** The normalized base URL (trailing slashes stripped). */
  readonly baseUrl: string;

  /** Headers sent with every request (API key, accept, optional tenant). */
  private readonly headers: Record<string, string>;

  /**
   * @param baseUrl - Host backend base URL, e.g. `https://api.host.langchain.com`.
   * @param apiKey - LangSmith API key sent as the `X-Api-Key` header.
   * @param tenantId - Optional workspace/tenant ID sent as `X-Tenant-ID`.
   * @throws {@link HostBackendError} if `baseUrl` is empty.
   */
  constructor(baseUrl: string, apiKey: string, tenantId?: string) {
    if (!baseUrl) {
      throw new HostBackendError("Host backend URL is required");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.headers = {
      "X-Api-Key": apiKey,
      Accept: "application/json",
    };
    if (tenantId) {
      this.headers["X-Tenant-ID"] = tenantId;
    }
  }

  /**
   * Set or override the tenant (workspace) header on this client. Used after
   * an org-scoped API key prompts for a workspace ID, so subsequent requests
   * are tenant-aware.
   *
   * @param tenantId - Workspace/tenant ID to send as `X-Tenant-ID`.
   */
  setTenantId(tenantId: string): void {
    this.headers["X-Tenant-ID"] = tenantId;
  }

  /**
   * Build a fully-qualified request URL, appending query parameters.
   *
   * @param path - Path relative to {@link baseUrl} (must start with `/`).
   * @param params - Optional query parameters; nullish values are omitted.
   * @returns The absolute URL string.
   */
  private buildUrl(path: string, params?: RequestOptions["params"]): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /**
   * Perform an HTTP request and decode the JSON response.
   *
   * @typeParam T - Expected shape of the decoded response body.
   * @param method - HTTP method (e.g. `GET`, `POST`, `PATCH`, `DELETE`).
   * @param path - Path relative to {@link baseUrl} (must start with `/`).
   * @param options - Optional JSON body and query parameters.
   * @returns The decoded JSON body, or `undefined` for empty responses.
   * @throws {@link HostBackendError} on HTTP error responses, transport
   * failures (after retries), or undecodable JSON bodies.
   */
  private async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = this.buildUrl(path, options.params);
    const init: RequestInit = {
      method,
      headers: { ...this.headers },
    };
    if (options.payload !== undefined) {
      init.body = JSON.stringify(options.payload);
      (init.headers as Record<string, string>)["Content-Type"] =
        "application/json";
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: controller.signal });
      } catch (error) {
        // Transport-level error (network, DNS, timeout). Retry a few times.
        lastError = error;
        if (attempt < TRANSPORT_RETRIES) continue;
        throw new HostBackendError(
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const detail =
          (await response.text().catch(() => "")) || String(response.status);
        throw new HostBackendError(
          `${method} ${path} failed with status ${response.status}: ${detail}`,
          response.status
        );
      }

      const text = await response.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new HostBackendError(
          `Failed to decode response from ${path}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    throw new HostBackendError(
      lastError instanceof Error ? lastError.message : String(lastError)
    );
  }

  /**
   * Create a new deployment (`POST /v2/deployments`).
   *
   * @param args - Deployment creation parameters.
   * @param args.name - Deployment name.
   * @param args.deploymentType - Deployment type, e.g. `dev` or `prod`.
   * @param args.source - Source kind, e.g. `internal_docker` or `internal_source`.
   * @param args.configPath - Config path inside the source archive. Only sent
   * for `internal_source` deployments.
   * @param args.secrets - Optional secrets to attach to the deployment.
   * @returns The created deployment object (expected to contain an `id`).
   */
  createDeployment(args: {
    name: string;
    deploymentType: string;
    source: string;
    configPath?: string | null;
    secrets?: Secret[] | null;
  }): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      name: args.name,
      source: args.source,
      source_config: { deployment_type: args.deploymentType },
      source_revision_config: {} as Record<string, unknown>,
    };
    if (args.source === "internal_source" && args.configPath) {
      (payload.source_revision_config as Record<string, unknown>)[
        "langgraph_config_path"
      ] = args.configPath;
    }
    if (args.secrets != null) {
      payload.secrets = args.secrets;
    }
    return this.request("POST", "/v2/deployments", { payload });
  }

  /**
   * List deployments (`GET /v2/deployments`).
   *
   * @param nameContains - Optional substring filter on deployment names.
   * @returns A paginated response object with a `resources` array.
   */
  listDeployments(nameContains = ""): Promise<Record<string, unknown>> {
    return this.request("GET", "/v2/deployments", {
      params: { name_contains: nameContains },
    });
  }

  /**
   * Fetch a single deployment (`GET /v2/deployments/{id}`).
   *
   * @param deploymentId - Deployment ID.
   * @returns The deployment object.
   */
  getDeployment(deploymentId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v2/deployments/${deploymentId}`);
  }

  /**
   * Delete a deployment (`DELETE /v2/deployments/{id}`).
   *
   * @param deploymentId - Deployment ID.
   */
  deleteDeployment(deploymentId: string): Promise<void> {
    return this.request("DELETE", `/v2/deployments/${deploymentId}`);
  }

  /**
   * Request a short-lived registry push token for a local-build deployment
   * (`POST /v2/deployments/{id}/push-token`).
   *
   * @param deploymentId - Deployment ID.
   * @returns A response containing the push `token` and `registry_url`.
   */
  requestPushToken(deploymentId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v2/deployments/${deploymentId}/push-token`);
  }

  /**
   * Request a signed GCS upload URL for the source tarball used by remote
   * builds (`POST /v2/deployments/{id}/upload-url`).
   *
   * @param deploymentId - Deployment ID.
   * @returns A response containing the `upload_url` and `object_path`.
   */
  requestUploadUrl(deploymentId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v2/deployments/${deploymentId}/upload-url`);
  }

  /**
   * Update a deployment to a new pre-built image, creating a new revision
   * (`PATCH /v2/deployments/{id}` with `revision_source: internal_docker`).
   *
   * @param deploymentId - Deployment ID.
   * @param imageUri - Fully-qualified image reference (ideally a digest).
   * @param args - Optional secrets.
   * @param args.secrets - Secrets to set on the deployment.
   * @returns The updated deployment object.
   */
  updateDeployment(
    deploymentId: string,
    imageUri: string,
    args: { secrets?: Secret[] | null } = {}
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      revision_source: "internal_docker",
      source_revision_config: { image_uri: imageUri },
    };
    if (args.secrets != null) {
      payload.secrets = args.secrets;
    }
    return this.request("PATCH", `/v2/deployments/${deploymentId}`, {
      payload,
    });
  }

  /**
   * Trigger a remote build revision from an uploaded source tarball
   * (`PATCH /v2/deployments/{id}` with `revision_source: internal_source`).
   *
   * @param deploymentId - Deployment ID.
   * @param args - Remote-build parameters.
   * @param args.sourceTarballPath - GCS object path of the uploaded tarball.
   * @param args.configPath - Path to `langgraph.json` inside the tarball.
   * @param args.secrets - Optional secrets to set on the deployment.
   * @param args.installCommand - Optional custom install command.
   * @param args.buildCommand - Optional custom build command.
   * @returns The updated deployment object.
   */
  updateDeploymentInternalSource(
    deploymentId: string,
    args: {
      sourceTarballPath: string;
      configPath: string;
      secrets?: Secret[] | null;
      installCommand?: string | null;
      buildCommand?: string | null;
    }
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      revision_source: "internal_source",
      source_revision_config: {
        source_tarball_path: args.sourceTarballPath,
        langgraph_config_path: args.configPath,
      },
    };

    const sourceConfig: Record<string, unknown> = {};
    if (args.installCommand != null) {
      sourceConfig.install_command = args.installCommand;
    }
    if (args.buildCommand != null) {
      sourceConfig.build_command = args.buildCommand;
    }
    if (Object.keys(sourceConfig).length) {
      payload.source_config = sourceConfig;
    }

    if (args.secrets != null) {
      payload.secrets = args.secrets;
    }
    return this.request("PATCH", `/v2/deployments/${deploymentId}`, {
      payload,
    });
  }

  /**
   * List a deployment's revisions, newest first
   * (`GET /v2/deployments/{id}/revisions`).
   *
   * @param deploymentId - Deployment ID.
   * @param limit - Maximum number of revisions to return (default `1`).
   * @returns A response object with a `resources` array of revisions.
   */
  listRevisions(
    deploymentId: string,
    limit = 1
  ): Promise<Record<string, unknown>> {
    return this.request("GET", `/v2/deployments/${deploymentId}/revisions`, {
      params: { limit },
    });
  }

  /**
   * Fetch a single revision (`GET /v2/deployments/{id}/revisions/{revId}`).
   *
   * @param deploymentId - Deployment ID.
   * @param revisionId - Revision ID.
   * @returns The revision object (expected to contain a `status`).
   */
  getRevision(
    deploymentId: string,
    revisionId: string
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v2/deployments/${deploymentId}/revisions/${revisionId}`
    );
  }

  /**
   * Fetch build logs for a revision
   * (`POST /v1/projects/{projectId}/revisions/{revId}/build_logs`).
   *
   * @param projectId - Project/deployment ID.
   * @param revisionId - Revision ID.
   * @param payload - Query body (e.g. `order`, `limit`, `offset`).
   * @returns A response object with a `logs` array and optional `next_offset`.
   */
  getBuildLogs(
    projectId: string,
    revisionId: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/projects/${projectId}/revisions/${revisionId}/build_logs`,
      { payload }
    );
  }

  /**
   * Fetch agent-server runtime (deploy) logs. Targets a specific revision when
   * `revisionId` is provided, otherwise the deployment as a whole.
   *
   * @param projectId - Project/deployment ID.
   * @param payload - Query body (e.g. `order`, `limit`, `level`, `query`).
   * @param revisionId - Optional revision ID to scope the logs.
   * @returns A response object with a `logs` array.
   */
  getDeployLogs(
    projectId: string,
    payload: Record<string, unknown>,
    revisionId?: string | null
  ): Promise<Record<string, unknown>> {
    const path = revisionId
      ? `/v1/projects/${projectId}/revisions/${revisionId}/deploy_logs`
      : `/v1/projects/${projectId}/deploy_logs`;
    return this.request("POST", path, { payload });
  }
}
