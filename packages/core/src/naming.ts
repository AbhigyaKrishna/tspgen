/** Convert an arbitrary identifier-ish string to PascalCase: "get pet_by-id" → "GetPetById". */
export function pascal(value: string): string {
  return value.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m, _sep, c: string) => c.toUpperCase());
}

/** "PetStore" → "PET_STORE", "petStore v2" → "PET_STORE_V2". */
export function constantCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export interface ApiVersionConstant {
  /** `API_VERSION`, or `<SERVICE>_API_VERSION` when several services are versioned. */
  name: string;
  /** The version's value (`"2024-01-01"`, or the member name when it has no value). */
  value: string;
  serviceId: string;
}

/** The version constants the language emitters generate: one per versioned service. */
export function apiVersionConstants(api: { services: { id: string; name: string; version?: { value: string } }[] }): ApiVersionConstant[] {
  const versioned = api.services.filter((s) => s.version);
  // Services with the same name in different namespaces are told apart by their full name.
  const prefix = (s: { id: string; name: string }) =>
    constantCase(versioned.filter((o) => o.name === s.name).length > 1 ? s.id : s.name);
  return versioned.map((s) => ({
    name: versioned.length > 1 ? `${prefix(s)}_API_VERSION` : "API_VERSION",
    value: s.version!.value,
    serviceId: s.id,
  }));
}
