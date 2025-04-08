import { Auth, HTTPException } from "@langchain/langgraph-sdk/auth";
import { verify } from "hono/jwt";

const SECRET_KEY =
  "09d25e094faa6ca2556c818166b7a9563b93f7099f6f0f4caa6cf63b88e8d3e7";
const ALGORITHM = "HS256";

const USERS_DB: Record<
  string,
  {
    username: string;
    identity: string;
    full_name: string;
    email: string;
    permissions: string[];
    hashed_password: string;
    disabled: boolean;
  }
> = {
  johndoe: {
    username: "johndoe",
    identity: "johndoe",
    full_name: "John Doe",
    email: "johndoe@example.com",
    permissions: ["read", "write", "assistants:write", "me"],
    hashed_password:
      "$2b$12$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW",
    disabled: false,
  },
  alice: {
    username: "alice",
    identity: "alice",
    full_name: "Alice Chains",
    email: "alicechains@example.com",
    permissions: ["read", "write", "assistants:write", "me"],
    hashed_password:
      "$2b$12$gSvqqUPvlXP2tfVFaWK1Be7DlH.PKZbv5H8KnzzVgXXbVxpva.pFm",
    disabled: true,
  },
};
export const auth = new Auth()
  .authenticate(async (request) => {
    const authorization = request.headers.get("Authorization");

    const exc = new HTTPException(401, {
      message: "Could not validate credentials",
      headers: { "WWW-Authenticate": "Bearer" },
    });

    if (!authorization?.toLocaleLowerCase().startsWith("bearer ")) {
      throw exc;
    }

    let payload: Awaited<ReturnType<typeof verify>> | undefined;

    try {
      payload = await verify(
        authorization.split(" ")[1],
        SECRET_KEY,
        ALGORITHM,
      );
    } catch (error) {
      throw new HTTPException(401, {
        message: "Failed to verify JWT token",
        cause: error,
      });
    }

    const scopes = (payload["scopes"] ?? []) as string[];
    const username = payload["sub"] as string | undefined;
    const user = username ? USERS_DB[username] : null;
    if (!user) throw exc;

    let permissions = user.permissions ?? [];
    permissions = scopes.filter((scope) => permissions.includes(scope));

    return { ...user, permissions };
  })
  .on("*", ({ permissions }) => {
    if (!permissions?.length) {
      throw new HTTPException(403, { message: "Not authorized" });
    }
  })
  .on("assistants:create", ({ value, user, permissions }) => {
    if (!permissions?.includes("assistants:write")) {
      throw new HTTPException(403, { message: "Not authorized" });
    }

    value.metadata ??= {};
    value.metadata["owner"] = user.identity;
  })
  .on("assistants:search", (params) => ({ owner: params.user.identity }))
  .on(["threads", "assistants"], ({ action, value, user }) => {
    const filters = { owner: user.identity };
    if (
      action === "threads:create_run" ||
      action === "threads:update" ||
      action === "threads:create" ||
      action === "assistants:create" ||
      action === "assistants:update"
    ) {
      value.metadata ??= {};
      value.metadata["owner"] = user.identity;
    }
    return filters;
  })
  .on("store", ({ value, user }) => {
    const identity = user.identity;
    if (!identity || !value.namespace?.includes(identity)) {
      throw new HTTPException(403, { message: "Not authorized" });
    }
  });
