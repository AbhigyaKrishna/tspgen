@service namespace Pets;
model Pet { id: int64; name?: string; price?: decimal; }
@route("/pets") interface Pets {
  @get read(@path id: int64): Pet;
  @get @route("/{petId}/details") details(@path petId: int64): Pet;
  @get @route("/labels/雪") label(): Pet;
  @post create(@body pet: Pet): { @statusCode _: 201; @body pet: Pet };
  @patch @route("/optional") optional(@body pet?: Pet): Pet;
  @delete remove(@path id: int64): void;
  @get @route("/names/{name}") lookup(@path name: string, @query active?: boolean, @header("x-trace") trace?: string): Pet;
  @get @route("/search") search(@query q: string, @header("x-key") key: string, @query count?: int8, @query mode?: "fast", @query one?: 1): Pet;
}
