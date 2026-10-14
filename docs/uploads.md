# Uploads (multipart and file bodies)

```tsp
model PhotoUpload {
  caption: HttpPart<string>;
  rating?: HttpPart<int32>;
  pet: HttpPart<Pet>;             // JSON part
  photo: HttpPart<File>;
  extras?: HttpPart<File>[];      // repeated part
}

@route("/uploads") interface Uploads {
  @post upload(@header contentType: "multipart/form-data", @multipartBody body: PhotoUpload): UploadReceipt;
  @put @route("/avatar") avatar(@bodyRoot file: File<"image/png">): void;
}
```

A part is `text` (scalars, enums and literals, also nullable — encoded like a query parameter, even when TypeSpec
gives it an `application/json` content type), `json` (models, arrays, records, tuples and unions with such a
variant, e.g. `HttpPart<Cat | Dog>` or `HttpPart<Meta | null>` — sent as `application/json`) or `file`
(`Http.File`, a model extending it, or `bytes`: `HttpPart<bytes>` is a file part too). A part declared with an
envelope, `HttpPart<{ @header contentType: "application/vnd.x+json"; @body value: Meta }>`, is a `Meta` part with
that content type (no wrapper model). The `contentType` header parameter of a multipart or file operation is
dropped from every generated signature (the HTTP runtime sets it, with the multipart boundary), and a plain
`Http.File`'s `*/*` content type counts as none declared.

| Target | Multipart body | File body |
|---|---|---|
| Kotlin models | `PhotoUpload` (and any model declaring `HttpPart`s) is a plain (non-`@Serializable`) data class; file parts are `HttpFile(filename, contentType, bytes)` / `List<HttpFile>`; `HttpFile.kt` is generated only when a file is used | `HttpFile` |
| Ktor server `buffered` (default) | `upload(body: PhotoUpload)`; the declared parts read into memory (others skipped unread); a missing required part → 400 | `avatar(file: HttpFile)` (filename from `Content-Disposition`, else `null`) |
| Ktor server `streaming` | `upload(parts: Flow<PhotoUploadPart>)` with `PhotoUploadPart.Caption(value)`, …, `PhotoUploadPart.Photo(filename, contentType, channel)`; one `PhotoUploadPart.kt` per model in the server package (a model with the same simple name from another package gets a package-prefixed name) | `avatar(contentType: String?, channel: ByteReadChannel)` |
| Ktor server `raw` | `upload(data: MultiPartData)` | `avatar(channel: ByteReadChannel)` |
| Ktor client | `upload(body: PhotoUpload)` → `MultiPartFormDataContent`, same `PhotoUpload`/`HttpFile` shape as the buffered server | `avatar(file: HttpFile)` → the bytes with `file.contentType`, else the declared type |
| TypeScript models | file parts are `globalThis.Blob` (a DOM `File` is one; `globalThis` so a model named `Blob` cannot shadow it), zod `z.instanceof(globalThis.Blob)` | `globalThis.Blob` |
| Next.js grouped / flat client | the body object is sent as `FormData`; fetch sets the content type (with the boundary), not the client, replacing any `Content-Type` from the client headers | the `Blob` is sent as-is with `blob.type`, else the declared type |

Pick the server mode with the `multipart` target option, or per operation / interface / namespace with
`@@meta(PetStore.Uploads.upload, "kotlin:ktor-server", #{ multipart: "streaming" })` (other values warn
`invalid-meta` and fall back to the option).

- Size limit (`max-upload-size`, default 50 MiB, Ktor's default `formFieldLimit`; override it per operation /
  interface / namespace with `#{ maxUploadSize: 1048576 }` in the same `@meta("kotlin:ktor-server", …)`):
  - every multipart part, in all modes (via `receiveMultipart(formFieldLimit)`), may hold at most that many bytes;
  - `buffered` multipart additionally caps the total it buffers for one request (the declared parts together) at
    that many bytes, and a `buffered` file body too;
  - `streaming` and `raw` multipart hand the parts to the service as they arrive, without a total cap, and
    `streaming`/`raw` file bodies hand the service the request channel unbounded.

  Over a limit → **413 Payload Too Large**. Only Ktor's multipart parser failing on the limit becomes 413: an
  exception the service (or a `streaming` collector) throws itself propagates unchanged, whatever its message.
  With `error-body: problem` (default) the 413 carries a problem body.
- `buffered` holds the declared parts in memory; use `streaming` or `raw` for large files. It also answers 400
  when a part that is not a list (`HttpPart<T>`, not `HttpPart<T>[]`) is sent more than once
  (`Part 'photo' must be sent at most once`).
- A streaming `Flow` can be collected once (a second collection throws `IllegalStateException`); a file part's
  `channel` is readable only until the collector returns for that part; unlike `buffered`, required parts are
  not checked. Undeclared parts are skipped.
- The Ktor server needs file parts sent **with a filename** (`Content-Disposition: form-data; name="photo";
  filename="…"`): Ktor reads a part without one as UTF-8 text, which would corrupt binary content, so
  `buffered` and `streaming` answer 400 (`File part 'photo' must be sent with a filename`). The generated
  clients always send one.
- JSON parts are read and written with the models' JSON configuration (the java.time serializers included).
- A file part is always sent with a filename (the part name when the file value has none) and a content type
  (its own, else the part's declared type, else `application/octet-stream`). JSON parts are sent with the part's
  declared JSON content type (`application/json` unless it declares another), which the Ktor server reads like
  text parts.
- In the Next.js clients, a JSON part is a `Blob` in the `FormData` typed with the part's declared JSON content
  type (`application/json` unless it declares another, e.g. `application/vnd.meta+json`), so fetch sends it with
  `filename="blob"`: fine for Ktor, but frameworks that treat every part with a filename as a file upload (multer,
  FastAPI, …) see it as a file. A `multipart/mixed` operation is sent as `multipart/form-data` (all `FormData`
  can encode).
- Not supported: file or multipart **responses** (downloads), tuple-form `@multipartBody` (error
  `unsupported-multipart-tuple`; the operation is skipped), React Query hooks and Server Actions for upload
  operations (skipped — call the client directly), and `Http.File` used inside a JSON model.
- Diagnostics: a multipart body model that `extends` a model with parts is an error
  (`unsupported-multipart-base` — TypeSpec ignores inherited parts; spread the base with `...Base` instead) and
  its operation is skipped; `Http.File` inside a JSON model or as a response body warns `file-in-json`; a model
  with parts also used as JSON (a response, a JSON body, a JSON model's property) warns
  `multipart-model-in-json`. In Kotlin, a model of your own named `HttpFile` in the models package clashes with
  the file class (`http-file-conflict`; rename it with `@Kotlin.name`).
