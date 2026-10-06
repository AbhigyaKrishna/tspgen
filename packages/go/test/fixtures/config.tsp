@service namespace Config;
scalar TraceId extends string;
enum State { active, inactive }
model Pet {
  @minValue(1) id: int64;
  @minLength(2) name: string;
  created: utcDateTime;
  price?: decimal = 1.25;
  trace?: TraceId;
  state?: State;
  note: string | null;
  raw?: bytes;
  @minItems(1) tags?: string[];
  kind?: "pet" = "pet";
}
model Page<T> { items: T[]; }
@error model Missing { @statusCode status: 404; message: string; }
interface Pets {
  @post @route("/echo") echo(@body pet: Pet): Pet | Missing;
  @get @route("/page") page(): Page<Pet>;
  @get @route("/at") at(@query date: utcDateTime): Pet;
}
