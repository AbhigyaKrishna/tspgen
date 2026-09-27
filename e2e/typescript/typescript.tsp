import "@abhigyakrishna/tspgen-typescript";
import "./petstore.tsp";

using TspGen;
using Http;

@@meta(PetStore.Pet, "typescript", #{ features: #{ readonly: true }, jsdoc: #["@public"] });
@@meta(PetStore.Pets, "typescript:ts-nextjs-client", #{ next: #{ revalidate: 60, tags: #["pets"] }, staleTime: 30000 });

// Generated auth (TypeScript-only): credentials from ClientConfig.auth per the operations' @useAuth.
namespace PetStore {
  model Greeting {
    message: string;
  }

  model PartnerKey is ApiKeyAuth<ApiKeyLocation.query, "api_key">;

  @route("/secure")
  @useAuth(BearerAuth)
  interface Secure {
    @get @route("/secret") secret(): Greeting;
    @get @route("/key") @useAuth(PartnerKey) key(@query q?: string): Greeting;
    @get @route("/public") @useAuth(NoAuth) open(): Greeting;
  }
}
