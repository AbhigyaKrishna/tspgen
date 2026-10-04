import { MINIMUM_GO_VERSION } from "../version.js";

export type GoServerFramework = "nethttp" | "gin";

/** Only the router and response APIs differ; binding and service contracts are shared. */
export interface GoServerTransport {
  framework: GoServerFramework;
  minimumVersion: string;
  routerType: string;
  callType: string;
  request: string;
  call: string;
  response: string;
  reject: string;
  readJSON: string;
  readJSONArguments: string[];
  serviceError: string;
  writeJSON: string;
  statusMethod: string;
  handlerTemplate: string;
  runtimeTemplate: string;
  moduleTemplate: string;
  imports: string[];
}

const transports: Record<GoServerFramework, GoServerTransport> = {
  nethttp: {
    framework: "nethttp",
    minimumVersion: MINIMUM_GO_VERSION,
    routerType: "*http.ServeMux",
    callType: "*http.Request",
    request: "r",
    call: "r",
    response: "w",
    reject: "rejectHTTP",
    readJSON: "readHTTPJSON",
    readJSONArguments: ["w", "r"],
    serviceError: "serviceHTTPError",
    writeJSON: "writeHTTPJSON",
    statusMethod: "WriteHeader",
    handlerTemplate: "go/server/nethttp-handler",
    runtimeTemplate: "go/server/nethttp-runtime",
    moduleTemplate: "go/dependent-mod",
    imports: [],
  },
  gin: {
    framework: "gin",
    minimumVersion: "1.25.0",
    routerType: "gin.IRoutes",
    callType: "*gin.Context",
    request: "c.Request",
    call: "c",
    response: "c",
    reject: "reject",
    readJSON: "readJSONBody",
    readJSONArguments: ["c"],
    serviceError: "serviceError",
    writeJSON: "writeJSON",
    statusMethod: "Status",
    handlerTemplate: "go/server/gin-handler",
    runtimeTemplate: "go/server/gin-runtime",
    moduleTemplate: "gin/mod",
    imports: ["net/url", "github.com/gin-gonic/gin"],
  },
};

export function serverTransport(framework: GoServerFramework): GoServerTransport {
  return transports[framework];
}
