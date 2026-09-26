import "@tspgen/emitter-typescript";
import "./petstore.tsp";

using TspGen;

@@meta(PetStore.Pet, "typescript", #{ readonly: true, jsdoc: #["@public"] });
@@meta(PetStore.Pets, "typescript:ts-nextjs-client", #{ next: #{ revalidate: 60, tags: #["pets"] }, staleTime: 30000 });
