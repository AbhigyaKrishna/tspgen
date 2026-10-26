import "@typespec/http";
import "@abhigyakrishna/tspgen-kotlin";
using Http;

@service namespace LifecycleModels;

model User {
  @visibility(Lifecycle.Read) id: string;
  @visibility(Lifecycle.Create) password: string;
  name: string;
  nested?: User;
}
model Patch { name?: string; }

@route("/lifecycle") interface Users {
  @get read(): User;
  @post create(@body body: User): User;
  @patch update(@body body: Patch): User;
}
