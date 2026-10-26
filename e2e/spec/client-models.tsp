import "@typespec/http";

using Http;

@service
@route("/client")
@useAuth(BearerAuth)
namespace ClientModels;

@encode(string)
scalar ExternalId extends int64;

model Patch {
  label?: string | null;
  external_id?: ExternalId | null;
  @minLength(1) name?: string | null;
}

enum Level {
  Read,
  Write,
}
model Specific {
  level: Level;
  scopes: string[];
}
union Permission {
  simple: Level,
  specific: Specific,
}
model Left {
  left?: string;
}
model Right {
  right?: string;
}
union Ambiguous {
  left: Left,
  right: Right,
}
union Literal {
  fixed: 7,
  text: string,
}
model NullInfo {
  info: null;
}
model Encoded {
  value: bytes;
}

@error
model Forbidden {
  @statusCode status: 403;
  message: string;
}

interface Operations {
  @get @route("/binary") binary():
    | {
        @header contentType: "application/octet-stream";
        @body value: bytes;
      }
    | Forbidden;
  @get @route("/endless") endless(): {
    @header contentType: "application/octet-stream";
    @body value: bytes;
  };
  @post @route("/patch") patch(@body body: Patch): Patch;
  @get @route("/large") large(): Encoded;
  @get @route("/denied") denied(): string | Forbidden;
  @get @route("/id") id(): ExternalId;
  @get @route("/choice") choice():
    | {
        @statusCode status: 200;
        @body body: Specific;
      }
    | {
        @statusCode status: 201;
        @body body: Encoded;
      };
  @get @route("/text") text(): string;
}
