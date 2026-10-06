@service namespace S;

enum Color { red, green: "verde" }
enum Level { low: 1, high: 2 }
enum Ratio { half: 0.5, tiny: 0.0000001 }
union Mode { auto: "auto", count: int32, ratio: float64, flag: boolean, color: Color, name: string }
union Strict { auto: "auto", count: int32 }
union Ref { latest: "latest", id: int32 }
union Num { count: integer, ratio: float64 }
union Tier { level: Level, flag: true, name: string }
union Dec { name: string, amount: decimal }
model Picked { level: Level; color: Color; ref: Ref; }
model Holder { ref: Ref; mode: Mode; strict?: Strict; color?: Color; }

@get @route("/items/{id}") op read(
  @path id: Ref,
  @query mode: Mode,
  @query strict?: Strict,
  @header("x-color") color?: Color,
  @query level?: Level,
  @query ratio?: Ratio,
): Holder;
@get @route("/picks/{level}/{color}/{ref}") op pick(@path level: Level, @path color: Color, @path ref: Ref): Picked;
