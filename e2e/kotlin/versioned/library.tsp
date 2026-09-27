import "@typespec/http";
import "@typespec/versioning";

using Http;
using Versioning;

/** A small versioned API, generated once per version by the e2e projects. */
@service(#{ title: "Library" })
@versioned(Versions)
namespace Library;

enum Versions {
  v1: "2024-01-01",
  v2: "2024-06-01",
}

enum Genre {
  fiction,
  @added(Versions.v2) poetry,
}

model Book {
  id: int64;
  @renamedFrom(Versions.v2, "name") title: string;
  genre: Genre;
  @added(Versions.v2) isbn?: string;
  @removed(Versions.v2) shelf?: string;
  @madeOptional(Versions.v2) author?: string;
  @typeChangedFrom(Versions.v2, int32) pages: int64;
}

@added(Versions.v2)
model Review {
  stars: int32;
  text?: string;
}

model Page<T> {
  items: T[];
  @added(Versions.v2) next?: string;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

@route("/books")
interface Books {
  @get list(@query limit?: int32, @added(Versions.v2) @query genre?: Genre): Page<Book>;
  @get get(@path id: int64): Book | NotFound;
  @added(Versions.v2) @get @route("{id}/reviews") reviews(@path id: int64): Review[];
  @removed(Versions.v2) @delete remove(@path id: int64): void | NotFound;
}
