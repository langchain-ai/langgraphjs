import type {
  Auth,
  HTTPException as AuthHTTPException,
} from "@langchain/langgraph-sdk/auth";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as url from "node:url";
import * as path from "path";

let CUSTOM_AUTH: Auth | undefined;
let DISABLE_STUDIO_AUTH = false;

export const isAuthRegistered = () => CUSTOM_AUTH != null;
export const isStudioAuthDisabled = () => DISABLE_STUDIO_AUTH;

export type AuthFilters =
  | Record<string, string | { $eq?: string; $contains?: string }>
  | undefined;

export interface AuthContext {
  user: {
    identity: string;
    permissions: string[];
    display_name: string;
    is_authenticated: boolean;
    [key: string]: unknown;
  };
  scopes: string[];
}

function convertError(error: unknown) {
  const isHTTPAuthException = (error: unknown): error is AuthHTTPException => {
    return (
      typeof error === "object" &&
      error != null &&
      "status" in error &&
      "headers" in error
    );
  };

  if (isHTTPAuthException(error)) {
    throw new HTTPException(error.status as ContentfulStatusCode, {
      message: error.message,
      res: new Response(error.message || "Unauthorized", {
        status: error.status,
        headers: error.headers,
      }),
    });
  }
  throw error;
}

export async function authorize(payload: {
  resource: string;
  action: string;
  value: unknown;
  context: AuthContext | undefined | null;
}) {
  // find filters and execute them
  const handlers = CUSTOM_AUTH?.["~handlerCache"];
  if (!handlers) return { filters: undefined, value: payload.value };

  const cbKey = [
    `${payload.resource}:${payload.action}`,
    `${payload.resource}`,
    `*:${payload.action}`,
    `*`,
  ].find((priority) => handlers.callbacks?.[priority]);
  const handler = cbKey ? handlers.callbacks?.[cbKey] : undefined;

  if (!handler || !payload.context) {
    return { filters: undefined, value: payload.value };
  }

  try {
    const result = await handler({
      event: `${payload.resource}:${payload.action}`,
      resource: payload.resource,
      action: payload.action,
      value: payload.value,
      permissions: payload.context?.scopes,
      user: payload.context?.user,
    });

    if (result == null || result == true) {
      return { filters: undefined, value: payload.value };
    }

    if (result === false) throw new HTTPException(403);

    if (typeof result !== "object") {
      throw new HTTPException(500, {
        message: `Auth handler returned invalid result. Expected filter object, null, undefined or boolean. Got "${typeof result}" instead.`,
      });
    }

    return { filters: result as AuthFilters, value: payload.value };
  } catch (error) {
    throw convertError(error);
  }
}

export async function authenticate(request: Request) {
  const handlers = CUSTOM_AUTH?.["~handlerCache"];
  if (!handlers?.authenticate) return undefined;

  try {
    const response = await handlers.authenticate(request);

    // normalize auth response
    const { scopes, user } = (() => {
      if (typeof response === "string") {
        return {
          scopes: [],
          user: {
            permissions: [],
            identity: response,
            display_name: response,
            is_authenticated: true,
          },
        };
      }

      if ("identity" in response && typeof response.identity === "string") {
        const scopes =
          "permissions" in response && Array.isArray(response.permissions)
            ? response.permissions
            : [];

        return {
          scopes,
          user: {
            ...response,
            permissions: scopes,
            is_authenticated: response.is_authenticated ?? true,
            display_name: response.display_name ?? response.identity,
          },
        };
      }

      throw new Error(
        "Invalid auth response received. Make sure to either return a `string` or an object with `identity` property.",
      );
    })();

    return { scopes, user };
  } catch (error) {
    throw convertError(error);
  }
}

export async function registerAuth(
  auth: { path?: string; disable_studio_auth?: boolean },
  options: { cwd: string },
) {
  if (!auth.path) return;

  // TODO: handle options.auth.disable_studio_auth
  const [userFile, exportSymbol] = auth.path.split(":", 2);
  const sourceFile = path.resolve(options.cwd, userFile);

  const module = (await import(url.pathToFileURL(sourceFile).toString()).then(
    (module) => module[exportSymbol || "default"],
  )) as Auth | undefined;

  if (!module) throw new Error(`Failed to load auth: ${auth.path}`);
  if (!("~handlerCache" in module))
    throw new Error(`Auth must be an instance of Auth: ${auth.path}`);

  CUSTOM_AUTH = module;
  DISABLE_STUDIO_AUTH = auth.disable_studio_auth ?? false;
}
