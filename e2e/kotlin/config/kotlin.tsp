import "@abhigyakrishna/tspgen-kotlin";
import "../../spec/upload-edges.tsp";
import "../../spec/secure.tsp";

using TspGen;

@@meta(PetStore.Toy, "kotlin", #{ implements: #["java.io.Serializable"] });
@@meta(PetStore.Pet, "kotlin", #{ annotations: #["@Suppress(\"unused\")"] });
@@meta(PetStore.Pets.remove, "kotlin:ktor-server", #{ authenticate: "api" });
@@meta(
  PetStore.Uploads.streaming,
  "kotlin:ktor-server",
  #{ multipart: "streaming" }
);
@@meta(PetStore.Uploads.raw, "kotlin:ktor-server", #{ multipart: "raw" });
@@meta(
  PetStore.Uploads.fileStream,
  "kotlin:ktor-server",
  #{ multipart: "streaming" }
);
@@meta(PetStore.Feed.watchPlugin, "kotlin:ktor-server", #{ sse: "plugin" });

@@meta(
  PetStore.Extras.notesStream,
  "kotlin:ktor-server",
  #{ multipart: "streaming" }
);
@@meta(
  PetStore.Extras.envelopeRaw,
  "kotlin:ktor-server",
  #{ multipart: "raw" }
);
@@meta(PetStore.Extras.notesRaw, "kotlin:ktor-server", #{ multipart: "raw" });
@@meta(
  PetStore.Extras.smallStream,
  "kotlin:ktor-server",
  #{ multipart: "streaming", maxUploadSize: 64 }
);
@@meta(PetStore.Extras.small, "kotlin:ktor-server", #{ maxUploadSize: 64 });
@@meta(
  PetStore.Extras.smallRaw,
  "kotlin:ktor-server",
  #{ multipart: "raw", maxUploadSize: 64 }
);
@@meta(PetStore.Extras.smallFile, "kotlin:ktor-server", #{ maxUploadSize: 64 });
@@meta(PetStore.NoteForm.title, "kotlin", #{ notBlank: true });
