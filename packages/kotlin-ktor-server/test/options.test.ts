import { expectDiagnostics } from "@typespec/compiler/testing";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEADER, petSpec, server } from "./tester.js";

const DIR = "server/com/acme/server";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tspgen-ktor-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe("ktor server options", () => {
  it.each([
    ["module", "features.module"],
    ["generate-auth", "features.auth"],
    ["call-access", "features.call-access"],
    ["nest-routes", "features.nest-routes"],
  ])("rejects the moved option %s", async (key, to) => {
    const diagnostics = await server({ [key]: true }).diagnose(petSpec);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/option-moved",
      message: `\`${key}\` moved to \`${to}\` in 0.2.0.`,
    });
  });

  it("skips the module with features.module false", async () => {
    const { outputs } = await server({ features: { module: false } }).compile(petSpec);
    expect(outputs["server/com/acme/server/PetStoreModule.kt"]).toBeUndefined();
    expect(outputs["server/com/acme/server/PetsRoutes.kt"]).toBeDefined();
  });

  it("writes models and server code to their own output dirs", async () => {
    const { outputs } = await server(
      { "output-dir": "{emitter-output-dir}/features" },
      { "models-output-dir": "{emitter-output-dir}/contract" },
    ).compile(petSpec);
    const paths = Object.keys(outputs).filter((p) => p.endsWith(".kt"));
    expect(paths).toContain(`features/${DIR}/PetsRoutes.kt`);
    expect(paths).toContain("contract/models/com/acme/models/Pet.kt");
    expect(paths.every((p) => p.startsWith("features/server/") || p.startsWith("contract/models/"))).toBe(true);
  });

  it("emits type-safe Resources routing", async () => {
    const { outputs } = await server({ "routing-style": "resources" }).compile(petSpec);
    expect(outputs[`${DIR}/PetsRoutes.kt`]).toBe(`${HEADER}
package com.acme.server

import com.acme.api.CreateResult
import com.acme.models.Pet
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.post
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

object PetsResources {
    @Serializable
    @Resource("/pets")
    class ListResource(val limit: Int? = null, val tags: List<String>? = null)

    @Serializable
    @Resource("/pets/{petId}")
    class GetResource(val petId: Long)

    @Serializable
    @Resource("/pets")
    class CreateResource

    @Serializable
    @Resource("/pets/{petId}")
    class RemoveResource(val petId: Long)
}

fun Route.petsRoutes(service: PetsService) {
    get<PetsResources.ListResource> { resource ->
        val limit = resource.limit
        val tags = resource.tags
        call.respond(HttpStatusCode.OK, service.list(limit, tags))
    }
    get<PetsResources.GetResource> { resource ->
        val petId = resource.petId
        val trace = call.headerParam("x-trace")
        call.respond(HttpStatusCode.OK, service.get(petId, trace))
    }
    post<PetsResources.CreateResource> { resource ->
        val pet = call.receive<Pet>()
        when (val result = service.create(pet)) {
            is CreateResult.Created -> {
                call.response.header("location", result.location)
                call.respond(HttpStatusCode.Created, result.body)
            }
            is CreateResult.Ok -> {
                call.respond(HttpStatusCode.OK, result.body)
            }
        }
    }
    delete<PetsResources.RemoveResource> { resource ->
        val petId = resource.petId
        service.remove(petId)
        call.respond(HttpStatusCode.NoContent)
    }
}
`);
    const module = outputs[`${DIR}/PetStoreModule.kt`];
    expect(module).toContain("import io.ktor.server.resources.Resources\n");
    expect(module).toContain("    install(Resources)\n");
  });

  it("supports request objects and call access", async () => {
    const { outputs } = await server({ "handler-shape": "request-object", features: { "call-access": true } }).compile(petSpec);
    const service = outputs[`${DIR}/PetsService.kt`];
    expect(service).toContain("import io.ktor.server.application.ApplicationCall\n");
    expect(service).toContain("    suspend fun get(call: ApplicationCall, request: GetRequest): Pet\n");
    expect(service).toContain(`
    data class GetRequest(
        val petId: Long,
        val trace: String?,
    )
`);
    expect(outputs[`${DIR}/PetsRoutes.kt`]).toContain(
      "call.respond(HttpStatusCode.OK, service.get(call, PetsService.GetRequest(petId = petId, trace = trace)))",
    );
  });

  it("groups operations per namespace or into a single file", async () => {
    const spec = `
      @service namespace Shop;
      namespace Catalog {
        @route("/items") interface Items { @get list(): string[]; }
        @route("/tags") interface Tags { @get tags(): string[]; }
      }
      @route("/orders") interface Orders { @get orders(): string[]; }
    `;
    const perNamespace = (await server({ grouping: "per-namespace" }).compile(spec)).outputs;
    expect(Object.keys(perNamespace).filter((k) => k.endsWith("Service.kt")).sort()).toEqual([
      `${DIR}/CatalogService.kt`,
      `${DIR}/ShopService.kt`,
    ]);
    expect(perNamespace[`${DIR}/CatalogService.kt`]).toContain("suspend fun tags(): List<String>");

    const single = (await server({ grouping: "single-file" }).compile(spec)).outputs;
    expect(Object.keys(single).filter((k) => k.endsWith("Service.kt"))).toEqual([`${DIR}/ShopService.kt`]);
    expect(single[`${DIR}/ShopModule.kt`]).toContain("fun Application.shopModule(shopService: ShopService)");
  });

  it("uses routing styles registered by plugins", async () => {
    const dir = dirWith({
      "templates/custom/routes.eta": "fun Route.<%= it.unit.routesFn %>(service: <%= it.unit.serviceName %>) = TODO()",
      "plugin.mjs": `
        import { fileURLToPath } from "node:url";
        export default {
          name: "custom-style",
          templates: fileURLToPath(new URL("./templates", import.meta.url)),
          setup(ctx) {
            ctx.registry.register("ktor-server.routing-style", "custom", {
              template: "custom/routes",
              imports: () => ["io.ktor.server.routing.Route"],
            });
          },
        };`,
    });
    const { outputs } = await server({ "routing-style": "custom" }, { plugins: [join(dir, "plugin.mjs")] }).compile(petSpec);
    expect(outputs[`${DIR}/PetsRoutes.kt`]).toContain("fun Route.petsRoutes(service: PetsService) = TODO()");
  });

  it("reports unknown routing styles", async () => {
    const [, diagnostics] = await server({ "routing-style": "nope" }).compileAndDiagnose(petSpec);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/target-failed",
      message: /unknown routing style 'nope' \(available: dsl, resources\)/,
    });
  });

  it("validates target options", async () => {
    const [, diagnostics] = await server({ grouping: "sideways" }).compileAndDiagnose(petSpec);
    expectDiagnostics(diagnostics, { code: "@abhigyakrishna/tspgen-core/invalid-target-options" });
  });

  it("adds the emitter's file-annotations to a target file", async () => {
    const { outputs } = await server({}, { "file-annotations": ['Suppress("unused")'] }).compile(petSpec);
    expect(outputs[`${DIR}/PetsService.kt`]).toContain('@file:Suppress("unused")\n');
  });

  it("marks generated declarations internal with the emitter's visibility: internal", async () => {
    const { outputs } = await server({}, { visibility: "internal" }).compile(petSpec);
    expect(outputs[`${DIR}/PetsService.kt`]).toContain("\ninternal interface PetsService {");
    expect(outputs[`${DIR}/PetsRoutes.kt`]).toContain("\ninternal fun Route.petsRoutes(service: PetsService) {");
    const module = outputs[`${DIR}/PetStoreModule.kt`];
    expect(module).toContain("\ninternal fun Application.petStoreModule(");
    expect(module).toContain("\ninternal fun Route.petStoreApiRoutes(");
    expect(outputs[`${DIR}/PetStoreErrors.kt`]).toMatch(/\ninternal fun StatusPagesConfig\.\w+\(responder: ServerErrorResponder = \{ [^\n]* \}\) \{/);
    const resources = await server({ "routing-style": "resources" }, { visibility: "internal" }).compile(petSpec);
    expect(resources.outputs[`${DIR}/PetsRoutes.kt`]).toMatch(/\ninternal object \w+ \{/);
    expect(resources.outputs[`${DIR}/PetsRoutes.kt`]).toContain("\ninternal fun Route.petsRoutes(service: PetsService) {");
    const streaming = await server({ multipart: "streaming" }, { visibility: "internal" }).compile(`
      @service namespace S;
      model Upload { name: HttpPart<string>; file: HttpPart<File> }
      @route("/u") @post op upload(@header contentType: "multipart/form-data", @multipartBody body: Upload): void;
    `);
    expect(Object.values(streaming.outputs).some((c) => /\ninternal sealed class \w+Part \{/.test(c))).toBe(true);
  });

  it("validates error-body and sse-headers", async () => {
    for (const options of [
      { "error-body": "html" },
      { "sse-headers": { "X-A": 1 } },
      { "sse-headers": { "Bad Name": "x" } },
      { "sse-headers": { "X-A": "a\nb" } },
    ]) {
      const [, diagnostics] = await server(options).compileAndDiagnose(petSpec);
      expectDiagnostics(diagnostics, { code: "@abhigyakrishna/tspgen-core/invalid-target-options" });
    }
  });

  it("rejects sse-headers the event-stream writer owns and emits no server code", async () => {
    const [{ outputs }, diagnostics] = await server({ "sse-headers": { "content-type": "text/plain" } }).compileAndDiagnose(petSpec);
    expectDiagnostics(diagnostics, {
      code: "@abhigyakrishna/tspgen-core/invalid-target-options",
      message: /sse-headers\.content-type is set by the event-stream writer/,
    });
    expect(Object.keys(outputs).filter((p) => p.startsWith("server/"))).toEqual([]);
  });

  it("warns that status-pages needs the module only when it is set explicitly", async () => {
    const [, explicit] = await server({ features: { module: false, "status-pages": true } }).compileAndDiagnose(petSpec);
    expectDiagnostics(explicit, {
      code: "@abhigyakrishna/tspgen-core/unsupported-feature",
      message: /`features\.status-pages` has no effect with features\.module: false/,
    });
    const [, defaulted] = await server({ features: { module: false } }).compileAndDiagnose(petSpec);
    expect(defaulted.filter((d) => d.code.endsWith("unsupported-feature"))).toEqual([]);
  });

  it("warns that status-pages needs features.errors only when it is set explicitly", async () => {
    const [, explicit] = await server({ features: { errors: false, "status-pages": true } }).compileAndDiagnose(petSpec);
    expectDiagnostics(explicit, {
      code: "@abhigyakrishna/tspgen-core/unsupported-feature",
      message: /`features\.status-pages` has no effect with features\.errors: false/,
    });
    const [, defaulted] = await server({ features: { errors: false } }).compileAndDiagnose(petSpec);
    expect(defaulted.filter((d) => d.code.endsWith("unsupported-feature"))).toEqual([]);
    // module: false already explains it: one diagnostic, not two.
    const [, both] = await server({ features: { module: false, errors: false, "status-pages": true } }).compileAndDiagnose(petSpec);
    expect(both.filter((d) => d.code.endsWith("unsupported-feature"))).toHaveLength(1);
  });

  it("accepts the runtime features", async () => {
    const [, diagnostics] = await server({
      features: { "status-pages": false, "ignore-unknown-keys": true, "encode-defaults": true, errors: true, "explicit-nulls": false },
    }).compileAndDiagnose(petSpec);
    expect(diagnostics).toEqual([]);
  });
});
