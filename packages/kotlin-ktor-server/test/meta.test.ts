import { describe, expect, it } from "vitest";
import { petSpec, server } from "./tester.js";

const DIR = "server/com/acme/server";
const withMeta = `using TspGen;\n${petSpec}
  @@meta(PetStore.Pets.remove, "kotlin:ktor-server", #{ authenticate: "jwt", annotations: #["@Throws(Exception::class)"] });
  @@meta(PetStore.Pets, "kotlin:ktor-client", #{ annotations: #["@JvmSynthetic"] });
`;

describe("ktor-server @meta keys", () => {
  it("wraps routes in authenticate and annotates service methods", async () => {
    const { outputs } = await server().compile(withMeta);
    const routes = outputs[`${DIR}/PetsRoutes.kt`];
    expect(routes).toContain("import io.ktor.server.auth.authenticate\n");
    expect(routes).toContain(`    authenticate("jwt") {
        delete("/pets/{petId}") {
            val petId = call.pathParam("petId").convertParam("petId") { it.toLong() }
            service.remove(petId)
            call.respond(HttpStatusCode.NoContent)
        }
    }
}`);
    expect(outputs[`${DIR}/PetsService.kt`]).toContain(`    @Throws(Exception::class)
    suspend fun remove(petId: Long)`);
    expect(outputs[`${DIR}/PetsService.kt`]).not.toContain("@JvmSynthetic");
  });

  it("applies group-level authenticate to every route, in Resources style too", async () => {
    const { outputs } = await server({ "routing-style": "resources" }).compile(
      `using TspGen;\n${petSpec}\n@@meta(PetStore.Pets, "kotlin:ktor-server", #{ authenticate: #["jwt", "basic"] });`,
    );
    const routes = outputs[`${DIR}/PetsRoutes.kt`];
    expect(routes.match(/authenticate\("jwt", "basic"\) \{/g)).toHaveLength(4);
    expect(routes).toContain(`    authenticate("jwt", "basic") {
        get<PetsResources.ListResource> { resource ->`);
  });
});
