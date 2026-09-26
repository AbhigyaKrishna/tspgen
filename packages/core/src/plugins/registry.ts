/** Named extension points (e.g. routing styles) that plugins register and targets consume. */
export class ExtensionRegistry {
  private readonly entries = new Map<string, Map<string, unknown>>();

  register(kind: string, name: string, impl: unknown): void {
    let byName = this.entries.get(kind);
    if (!byName) {
      byName = new Map();
      this.entries.set(kind, byName);
    }
    byName.set(name, impl);
  }

  get<T>(kind: string, name: string): T | undefined {
    return this.entries.get(kind)?.get(name) as T | undefined;
  }

  names(kind: string): string[] {
    return [...(this.entries.get(kind)?.keys() ?? [])];
  }
}
