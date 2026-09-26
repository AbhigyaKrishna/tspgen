import "../dist/tsp-index.js";

namespace Specgen;

/**
 * Attach metadata for all languages ("*"), a language ("kotlin", "typescript") or a target
 * ("kotlin:ktor-server"). Built-in emitters understand documented keys; everything else is passed
 * through to templates (`it.h.meta`) and plugins (`resolveMeta`).
 */
extern dec meta(target: unknown, scope: valueof string, data: valueof Record<unknown>);
