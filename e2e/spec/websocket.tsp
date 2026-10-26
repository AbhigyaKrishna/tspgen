import "@typespec/http";
import "@abhigyakrishna/tspgen-kotlin";

using Http;

@service
@useAuth(BearerAuth)
namespace Socket;

@encode(string)
scalar MessageId extends int64;

model Message {
  id: MessageId;
  text: string;
}

@TspGen.meta("kotlin:ktor-client", #{ webSocket: true })
interface Sockets {
  @get
  @route("/rooms/{room}")
  connect(
    @path room: string,
    @query("target[type]") target: string,
    @header("x-trace") trace?: string,
    @cookie sid?: string,
    @query(#{ name: "labels[]", explode: true }) labels?: string[],
    @query("ids[]") ids?: int32[],
  ): {
    @statusCode status: 101;
  };

  @get
  @route("/collisions")
  collisions(
    @query http: string,
    @query baseUrl: string,
    @query consume: string,
  ): void;

  @useAuth(NoAuth)
  @get
  @route("/close")
  closing(): {
    @statusCode status: 101;
  };
}
