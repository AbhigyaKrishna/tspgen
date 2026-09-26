import "@specgen/emitter-kotlin";
import "./petstore.tsp";

using Specgen;

@@meta(PetStore.Toy, "kotlin", #{ implements: #["java.io.Serializable"] });
@@meta(PetStore.Pet, "kotlin", #{ annotations: #["@Suppress(\"unused\")"] });
@@meta(PetStore.Pets.remove, "kotlin:ktor-server", #{ authenticate: "api" });
