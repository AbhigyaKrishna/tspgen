@service namespace S;
model Box<T> { value: T; }
model Page<T> { items: T[]; }
model OptionalBox<T> { value?: T; }
model OptionalPage<T> { items?: T[]; }
model Link<T> { item: T; next?: Link<T>; }
model Pair<T, U> { first: T; second: U; }
model Node { id: int32; }
model Payload {
  box: Box<int32>;
  nullable: Box<int32 | null>;
  node: Box<Node>;
  nullableNode: Box<Node | null>;
  page: Page<int32>;
  nullablePage: Page<int32 | null>;
  nested: Box<Page<int32>>;
  mapping: Record<Box<int32>>;
  count: integer;
  counts: integer[];
  optional: OptionalBox<int32>;
  pair: Pair<Node | null, Node>;
  link?: Link<Node>;
}
model Dash { @encodedName("application/json", "-") value: string; }
@post op write(@body input: Payload): Payload;
@get @route("/dash") op dash(): Dash;
@get @route("/optional-page") op optionalPage(): OptionalPage<int32>;
