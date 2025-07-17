import type {
  AuthenticateCallback,
  AnyCallback,
  CallbackEvent,
  OnCallback,
  BaseAuthReturn,
  ToUserLike,
  BaseUser,
} from "./types.js";

export class Auth<
  TExtra = {}, // eslint-disable-line @typescript-eslint/ban-types
  TAuthReturn extends BaseAuthReturn = BaseAuthReturn,
  TUser extends BaseUser = ToUserLike<TAuthReturn>
> {
  /**
   * @internal
   * @ignore
   */
  "~handlerCache": {
    authenticate?: AuthenticateCallback<BaseAuthReturn>;
    callbacks?: Record<string, AnyCallback>;
  } = {};

  authenticate<T extends BaseAuthReturn>(
    cb: AuthenticateCallback<T>
  ): Auth<TExtra, T> {
    this["~handlerCache"].authenticate = cb;
    return this as unknown as Auth<TExtra, T>;
  }

  on<T extends CallbackEvent>(event: T, callback: OnCallback<T, TUser>): this {
    this["~handlerCache"].callbacks ??= {};
    const events: string[] = Array.isArray(event) ? event : [event];
    for (const event of events) {
      this["~handlerCache"].callbacks[event] = callback as AnyCallback;
    }
    return this;
  }
}

/**
 * Check if the provided user was provided by LangGraph Studio.
 *
 * By default, if you add custom authorization on your resources, this will also apply to interactions made from the Studio.
 * If you want, you can handle logged-in Studio users in a special way.
 *
 * @param user - The user to check
 * @returns True if the user is a studio user, false otherwise
 */
export function isStudioUser(user: BaseUser) {
  if ("kind" in user && user.kind === "StudioUser") return true;
  return user.identity === "langgraph-studio-user";
}

export type {
  Filters as AuthFilters,
  EventValueMap as AuthEventValueMap,
} from "./types.js";
export { HTTPException } from "./error.js";
