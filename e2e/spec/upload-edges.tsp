import "./petstore.tsp";

using Http;

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
    pet: HttpPart<{
      @header contentType: "application/vnd.pet+json";
      @body pet: Pet;
    }>;
  }

  model BlobForm {
    blob: HttpPart<bytes>;
  }

  @route("/extras")
  interface Extras {
    @post @route("/notes") notes(
      @header contentType: "multipart/form-data",
      @multipartBody body: NoteForm,
    ): NoteReceipt;
    @post @route("/notes-stream") notesStream(
      @header contentType: "multipart/form-data",
      @multipartBody body: NoteForm,
    ): NoteReceipt;
    @post @route("/notes-raw") notesRaw(
      @header contentType: "multipart/form-data",
      @multipartBody body: NoteForm,
    ): NoteReceipt;

    /** Streams the same model as Uploads.streaming: one PhotoUploadPart class for both. */
    @post @route("/small-stream") smallStream(
      @header contentType: "multipart/form-data",
      @multipartBody body: PhotoUpload,
    ): UploadReceipt;

    @post @route("/small") small(
      @header contentType: "multipart/form-data",
      @multipartBody body: PhotoUpload,
    ): UploadReceipt;
    @post @route("/small-raw") smallRaw(
      @header contentType: "multipart/form-data",
      @multipartBody body: PhotoUpload,
    ): UploadReceipt;
    @put @route("/small-file") smallFile(@bodyRoot file: File): FileReceipt;
    @post @route("/envelope") envelope(
      @header contentType: "multipart/form-data",
      @multipartBody body: EnvelopeForm,
    ): NoteReceipt;
    @post @route("/envelope-raw") envelopeRaw(
      @header contentType: "multipart/form-data",
      @multipartBody body: EnvelopeForm,
    ): NoteReceipt;
    @post @route("/blob") blob(
      @header contentType: "multipart/form-data",
      @multipartBody body: BlobForm,
    ): FileReceipt;
  }
}
