using TspGen;
@service namespace S;
scalar Label extends string;
scalar Count extends int32;
enum State { active, spaced: "a b", punctuation: "a,b|c`d", empty: "" }
enum Ratio { first: 1.5, second: 2.5 }
model Child { @minLength(2) name: Label; }
model Box<T> { value: T; }
@meta("go", #{ features: #{ validator: false } })
model Plain { @minLength(2) name: string; }
model Payload {
  @minLength(2) @maxLength(4) name: string;
  @minValue(0) @maxValue(10) count: Count;
  active: boolean;
  @minLength(2) optional?: string;
  @minLength(2) nullable: string | null;
  @minItems(1) @maxItems(2) children: Child[];
  mapping: Record<Child>;
  nullableChildren: (Child | null)[];
  nested: Child[][];
  child: Child;
  optionalChild?: Child;
  plain: Plain;
  box: Box<Child>;
  state: State;
  ratio: Ratio;
  literal: "a,b|c`d";
  literalBool: false;
  literalNumber: 0;
  @minValue(100) number: numeric;
  @minValue(100) decimal: decimal;
  @pattern("^a") pattern: string;
}
@post op write(@body payload: Payload): Payload;
