import "@abhigyakrishna/tspgen-typescript";
import "../../spec/query-auth.tsp";

using TspGen;

@@meta(
  PetStore.Pet,
  "typescript",
  #{ features: #{ readonly: true }, jsdoc: #["@public"] }
);
@@meta(
  PetStore.Pets,
  "typescript:ts-nextjs-client",
  #{ next: #{ revalidate: 60, tags: #["pets"] }, staleTime: 30000 }
);
