import "@typespec/http";
import "@abhigyakrishna/tspgen-kotlin";

using Http;
using TspGen;

/** Every body-less error kind the generated server raises, answered by a custom responder; explicitNulls off. */
@service
namespace Faults;

model Item {
  name: string;
  note: string | null;
  price?: decimal;
}

@error
model Fault {
  code: string;
}

model NoteForm {
  title: HttpPart<string>;
}

@route("/items")
interface Items {
  @get @route("/{id}") get(@path id: int64): Item | Fault;
  @get search(@query q: string): Item[];
  @post create(@body item: Item): Item;
  @post @route("/notes") note(@header contentType: "multipart/form-data", @multipartBody body: NoteForm): Item;
}

@@meta(Faults.Item.name, "kotlin", #{ notBlank: true });
@@meta(Faults.Items.note, "kotlin:ktor-server", #{ maxUploadSize: 64 });
