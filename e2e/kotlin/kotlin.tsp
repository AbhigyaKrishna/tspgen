import "@abhigyakrishna/tspgen-kotlin";
import "./petstore.tsp";
import "./secure.tsp";

using TspGen;
using Http;

@@meta(PetStore.Toy, "kotlin", #{ implements: #["java.io.Serializable"] });
@@meta(PetStore.Pet, "kotlin", #{ annotations: #["@Suppress(\"unused\")"] });
@@meta(PetStore.Pets.remove, "kotlin:ktor-server", #{ authenticate: "api" });
@@meta(PetStore.Uploads.streaming, "kotlin:ktor-server", #{ multipart: "streaming" });
@@meta(PetStore.Uploads.raw, "kotlin:ktor-server", #{ multipart: "raw" });
@@meta(PetStore.Uploads.fileStream, "kotlin:ktor-server", #{ multipart: "streaming" });

// Kotlin-only upload edge cases (the TypeScript e2e shares petstore.tsp, not this file).
namespace PetStore {
  /** Text and JSON parts only: no HttpFile anywhere. */
  model NoteForm {
    title: HttpPart<string>;
    tags?: HttpPart<string>[];
    times?: HttpPart<utcDateTime[]>;
    pet?: HttpPart<Pet | null>;
  }

  model NoteReceipt {
    title: string;
    tags: string[];
    times: utcDateTime[];
    petName?: string;
  }

  /** A JSON part declared with an envelope: a Pet sent as application/vnd.pet+json. */
  model EnvelopeForm {
    pet: HttpPart<{ @header contentType: "application/vnd.pet+json"; @body pet: Pet }>;
  }

  model BlobForm {
    blob: HttpPart<bytes>;
  }

  @route("/extras")
  interface Extras {
    @post @route("/notes") notes(@header contentType: "multipart/form-data", @multipartBody body: NoteForm): NoteReceipt;
    @post @route("/notes-stream") notesStream(
      @header contentType: "multipart/form-data",
      @multipartBody body: NoteForm,
    ): NoteReceipt;
    @post @route("/notes-raw") notesRaw(@header contentType: "multipart/form-data", @multipartBody body: NoteForm): NoteReceipt;

    /** Streams the same model as Uploads.streaming: one PhotoUploadPart class for both. */
    @post @route("/small-stream") smallStream(
      @header contentType: "multipart/form-data",
      @multipartBody body: PhotoUpload,
    ): UploadReceipt;

    @post @route("/small") small(@header contentType: "multipart/form-data", @multipartBody body: PhotoUpload): UploadReceipt;
    @post @route("/small-raw") smallRaw(@header contentType: "multipart/form-data", @multipartBody body: PhotoUpload): UploadReceipt;
    @put @route("/small-file") smallFile(@bodyRoot file: File): FileReceipt;
    @post @route("/envelope") envelope(
      @header contentType: "multipart/form-data",
      @multipartBody body: EnvelopeForm,
    ): NoteReceipt;
    @post @route("/envelope-raw") envelopeRaw(
      @header contentType: "multipart/form-data",
      @multipartBody body: EnvelopeForm,
    ): NoteReceipt;
    @post @route("/blob") blob(@header contentType: "multipart/form-data", @multipartBody body: BlobForm): FileReceipt;
  }
}

@@meta(PetStore.Extras.notesStream, "kotlin:ktor-server", #{ multipart: "streaming" });
@@meta(PetStore.Extras.envelopeRaw, "kotlin:ktor-server", #{ multipart: "raw" });
@@meta(PetStore.Extras.notesRaw, "kotlin:ktor-server", #{ multipart: "raw" });
@@meta(PetStore.Extras.smallStream, "kotlin:ktor-server", #{ multipart: "streaming", maxUploadSize: 64 });
@@meta(PetStore.Extras.small, "kotlin:ktor-server", #{ maxUploadSize: 64 });
@@meta(PetStore.Extras.smallRaw, "kotlin:ktor-server", #{ multipart: "raw", maxUploadSize: 64 });
@@meta(PetStore.Extras.smallFile, "kotlin:ktor-server", #{ maxUploadSize: 64 });
