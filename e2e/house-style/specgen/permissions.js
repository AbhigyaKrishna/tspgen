// House rule (the shape shipyard uses): every operation is authenticated and needs <Feature>Module.READ for GET,
// WRITE otherwise (unless it already wraps an explicit requirePermission); mutations receive the caller as actorId.
// Operations marked @meta("*", #{ public: true }) are left alone.
const SCOPE = "kotlin:ktor-server";

export default {
  name: "house-permissions",
  languages: ["kotlin"],
  transformIR(ir) {
    for (const service of ir.services) {
      for (const group of service.groups) {
        const feature = group.namespace.at(-1);
        // Scope objects can be shared between operations of a group: always replace, never mutate.
        group.operations = group.operations.map((op) => {
          if (op.meta["*"]?.public === true) return op;
          const server = op.meta[SCOPE] ?? {};
          const wrap = server.wrap ?? [];
          const explicit = wrap.some((w) => w.startsWith("requirePermission("));
          const permission = op.verb === "get" ? "READ" : "WRITE";
          return {
            ...op,
            meta: {
              ...op.meta,
              [SCOPE]: {
                ...server,
                wrap: [
                  "authenticate(JWT_AUTH)",
                  ...(explicit ? [] : [`requirePermission(${feature}Module.${permission})`]),
                  ...wrap,
                ],
                imports: [
                  ...(server.imports ?? []),
                  "io.ktor.server.auth.authenticate",
                  "com.example.core.JWT_AUTH",
                  "com.example.core.requirePermission",
                  "com.example.core.requirePrincipal",
                ],
                context: [
                  ...(server.context ?? []),
                  ...(op.verb === "get" ? [] : [{ name: "actorId", type: "String", expr: "call.requirePrincipal().name" }]),
                ],
              },
            },
          };
        });
      }
    }
  },
};
