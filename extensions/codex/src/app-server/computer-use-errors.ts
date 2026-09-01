export function hasNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
