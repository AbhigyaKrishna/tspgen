/** Kotlin package mapped to the longest matching namespace prefix, if any. */
export function mappedPackage(packages: Record<string, string> | undefined, namespace: readonly string[]): string | undefined {
  if (!packages) return undefined;
  for (let n = namespace.length; n > 0; n--) {
    const key = namespace.slice(0, n).join(".");
    if (Object.hasOwn(packages, key) && packages[key]) return packages[key];
  }
  return undefined;
}
