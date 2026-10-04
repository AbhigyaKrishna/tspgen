import "@typespec/http";

using Http;

@service(#{ title: "Go Pet Store" })
namespace PetStore;

enum Species { dog, cat, bird: "parrot" }

model Pet {
  @minValue(1) id: int64;
  @minLength(2) name: string;
  species: Species;
  @encodedName("application/json", "born_at") bornAt: utcDateTime;
  price?: decimal = 1.25;
  note: string | null;
}

model Page<T> { items: T[]; total: int32; }

model Binding {
  name: string;
  active?: boolean;
  trace?: string;
}

@error model NotFound {
  @statusCode status: 404;
  message: string;
}

@discriminator("kind")
model Toy { kind: string; @minLength(2) label: string; }
model Ball extends Toy { kind: "ball"; bounce?: int32 = 3; }
model Kite extends Toy { kind: "kite"; length: float64; }
model Tags { pet: string; ...Record<string>; }
union Sort { newest: "newest", limit: int32 }

@route("/pets")
interface Pets {
  @get list(@minValue(1) @query limit?: int32): Page<Pet>;
  @get read(@minValue(1) @path id: int64): Pet | NotFound;
  @post create(@body pet: Pet): { @statusCode status: 201; @body pet: Pet; };
  @delete remove(@minValue(1) @path id: int64): void | NotFound;

  @get @route("/names/{name}") lookup(
    @path name: string,
    @query active?: boolean,
    @header("x-trace") trace?: string,
  ): Binding;

  @post @route("/labels") labels(@body labels: string[]): string[];
  @get @route("/failure") fail(): Pet;
}

@route("/toys")
interface Toys {
  @post echo(@body toy: Toy): Toy;
}

@route("/tags")
interface Tagging {
  @post echo(@body tags: Tags, @query sort?: Sort): Tags;
}
