/** Convert an arbitrary identifier-ish string to PascalCase: "get pet_by-id" → "GetPetById". */
export function pascal(value: string): string {
  return value.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m, _sep, c: string) => c.toUpperCase());
}
