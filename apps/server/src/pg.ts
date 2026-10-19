/** Walks an error chain for a Postgres error code (drizzle wraps driver errors in `.cause`). */
export function pgErrorCode(err: unknown): string | null {
  let current = err as { code?: unknown; cause?: unknown } | null;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth++) {
    if (typeof current.code === "string" && current.code.length > 0) return current.code;
    current = current.cause as typeof current | undefined ?? null;
  }
  return null;
}

/** True when the error is a unique-constraint violation (23505). */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505";
}
