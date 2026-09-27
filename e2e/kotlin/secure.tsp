import "@typespec/http";

using Http;

// Generated auth (Kotlin-only): a second service whose routes get authenticate(...) wrappers from @useAuth.
// Compiled with kotlin.tsp (dsl routing) and on its own with tspconfig.resources.yaml (Resources routing) and
// tspconfig.nest.yaml (nest-routes), each into its own package; PartnerKey is mapped through auth-providers.
@service(#{ title: "Secure Store" })
@useAuth(BearerAuth)
namespace SecureStore {
  model Greeting {
    message: string;
  }

  model PartnerKey is ApiKeyAuth<ApiKeyLocation.header, "X-Partner">;

  @route("/secure")
  interface Secure {
    /** Service-level @useAuth: a valid bearer token is required. */
    @get @route("/secret") secret(): Greeting;

    /** Public despite the service-level @useAuth. */
    @get @route("/public") @useAuth(NoAuth) open(): Greeting;

    /** Anonymous or authenticated; a token that is sent must be valid. */
    @get @route("/optional") @useAuth(BearerAuth | NoAuth) optional(): Greeting;

    /** Either scheme is enough. */
    @get @route("/either") @useAuth(BearerAuth | PartnerKey) either(): Greeting;

    /** Both schemes are required (Ktor AuthenticationStrategy.Required). */
    @get @route("/both") @useAuth([BearerAuth, PartnerKey]) both(): Greeting;
  }

  /** Interface-level @useAuth overrides the service's; an operation's own overrides the interface's. */
  @route("/partner")
  @useAuth(PartnerKey)
  interface Partner {
    @get list(): Greeting;
    @get @route("/bearer") @useAuth(BearerAuth) bearer(): Greeting;
  }

  /** A public interface with one authenticated operation inside. */
  @route("/lobby")
  @useAuth(NoAuth)
  interface Lobby {
    @get index(): Greeting;
    @get @route("/members") @useAuth(BearerAuth) members(): Greeting;
  }

  /** One path, a different requirement per method. */
  @route("/items")
  interface Items {
    @get @useAuth(NoAuth) list(): Greeting;
    @post create(): Greeting;
    @delete @useAuth([BearerAuth, PartnerKey]) purge(): Greeting;
  }
}
