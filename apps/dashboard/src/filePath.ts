// Pure helpers that turn an event's file path into display segments for the FILES
// panel. Kept in their own module (no React) so they're unit-tested directly — and
// made separator-aware so a Windows path ("$PROJECT\src\foo.ts", "C:\proj\foo.ts")
// segments like a POSIX one instead of collapsing into a single mangled chunk.

export function normalizedProjectPath(path: string): string {
  return path
    .replace(/\\/g, "/") // Windows separators → POSIX, so the splits below work
    .replace(/^\$PROJECT\/?/, "") // drop the redaction prefix
    .replace(/^\/+/, ""); // and any leading slash
}

export function pathSegments(path: string): string[] {
  return normalizedProjectPath(path)
    .split("/")
    .filter(Boolean);
}

export function fileNameFromPath(path: string): string {
  return pathSegments(path).at(-1) ?? path;
}
