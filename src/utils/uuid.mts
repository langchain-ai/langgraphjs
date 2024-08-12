import { HTTPException } from "hono/http-exception";
import { validate } from "uuid";

export function validateUuid(value: string, message?: string): string {
  if (!validate(value)) {
    throw new HTTPException(422, {
      message: message ?? "Invalid UUID provided",
    });
  }

  return value;
}
