import "@typespec/http";

using Http;

@service(#{ title: "Pet Store" })
namespace PetStore;

enum Species {
  dog,
  cat,
  bird: "parrot",
}

/** A pet in the store. */
model Pet {
  id: int64;
  name: string;
  species: Species;
  tags?: string[];
  @encodedName("application/json", "born_at") bornAt?: utcDateTime;
  weight?: float64 = 1.0;
}

@discriminator("kind")
model Toy {
  kind: string;
  name: string;
}

model Ball extends Toy {
  kind: "ball";
  diameter: float32;
}

model Rope extends Toy {
  kind: "rope";
  length: int32;
}

/** One page of results; generated once as a generic class. */
model Page<T> {
  items: T[];
  total: int32;
}

model Collar {
  size: int32;
}

model NameTag {
  text: string;
}

/** Variants only this union uses are generated inside it (Accessory.Collar, Accessory.Tag). */
@discriminated(#{ envelope: "none", discriminatorPropertyName: "type" })
union Accessory {
  collar: Collar,
  tag: NameTag,
}

@error
model ApiError {
  code: string;
  message: string;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

@route("/pets")
interface Pets {
  @get list(
    @query limit?: int32,
    @query(#{ explode: true }) tags?: string[],
    @query species?: Species,
    @query bornAfter?: utcDateTime,
  ): Pet[] | ApiError;

  @get get(@path petId: int64, @header("x-trace") trace?: string): Pet | NotFound | ApiError;

  @post create(@body pet: Pet):
    | {
        @statusCode _: 201;
        @header location: string;
        @body pet: Pet;
      }
    | {
        @statusCode _: 200;
        @body pet: Pet;
      }
    | ApiError;

  @delete remove(@path petId: int64): void | NotFound;

  /** Bare java.time bodies need the generated contextual serializers. */
  @post @route("/latest") latest(@body dates: utcDateTime[]): utcDateTime;
}

@route("/toys")
interface Toys {
  @get list(): Toy[];
  @post add(@body toy: Toy): void;
}

@route("/accessories")
interface Accessories {
  @get page(@query offset?: int32): Page<Accessory>;
  @post add(@body accessory: Accessory): void;
}
