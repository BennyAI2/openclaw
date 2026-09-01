export function normalizeTsgoPath(repoRoot: string, filePath: string): string {
  const normalized = filePath.trim().replaceAll("\\", "/");
  const normalizedRoot = repoRoot.replaceAll("\\", "/");
  return normalized.startsWith(`${normalizedRoot}/`)
    ? normalized.slice(normalizedRoot.length + 1)
    : normalized;
}
