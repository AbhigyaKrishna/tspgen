@service namespace S;
model Box<T> { value: T; }
model Node { id: int32; }
@post @route("/required") op required(@body input: Box<Node>): void;
@post @route("/nullable") op nullable(@body input: Box<Node | null>): void;
@post @route("/integer") op integerBody(@body input: Box<integer>): void;
@get @route("/response") op response(): Box<Node>;
@get @route("/nullable-response") op nullableResponse(): Box<Node | null>;
