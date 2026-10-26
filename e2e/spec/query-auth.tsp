import "./petstore.tsp";

using Http;

namespace PetStore {
  model Greeting {
    message: string;
  }

  model PartnerKey is ApiKeyAuth<ApiKeyLocation.query, "api_key">;

  @route("/secure")
  @useAuth(BearerAuth)
  interface Secure {
    @get @route("/secret") secret(): Greeting;
    @get
    @route("/key")
    @useAuth(PartnerKey)
    key(@query q?: string): Greeting;
    @get
    @route("/public")
    @useAuth(NoAuth)
    open(): Greeting;
  }
}
