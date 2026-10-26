import "../../spec/pet-feed.tsp";
import "@abhigyakrishna/tspgen-typescript";

using TspGen;

@@meta(
  PetFeed.Pets.getPet,
  "typescript:ts-nextjs-client",
  #{ next: #{ revalidate: 30, tags: #["pet"] } }
);
