import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const source = `
  @service namespace S;
  model User {
    @visibility(Lifecycle.Read) id: string;
    @visibility(Lifecycle.Create) password: string;
    name: string;
    nested?: User;
  }
  @route("/users") interface Users {
    @get read(): User;
    @post create(@body body: User): User;
    @patch update(@body body: User): User;
  }
`;

describe("Kotlin lifecycle payloads", () => {
  it("separates read/create/update shapes and preserves recursive references", async () => {
    const { outputs } = await emitter({ features: { "lifecycle-models": true } }).compile(source);
    const models = "models/com/acme/models";
    expect(outputs[`${models}/User.kt`]).toContain("val id: String");
    expect(outputs[`${models}/User.kt`]).not.toContain("val password");
    const created = outputs[`${models}/UserCreate.kt`];
    expect(created).toContain("val password: String");
    expect(created).not.toContain("val id");
    expect(created).toContain("val nested: UserCreate?");
    const patched = outputs[`${models}/UserUpdate.kt`];
    expect(patched).toContain("val name: String");
    expect(patched).not.toContain("val id");
    expect(patched).not.toContain("val password");
  });

  it("retains explicitly declared optional patch properties", async () => {
    const { outputs } = await emitter({ features: { "lifecycle-models": true } }).compile(`
      @service namespace S;
      model Patch { name?: string; }
      @patch op update(@body body: Patch): void;
    `);
    expect(outputs["models/com/acme/models/Patch.kt"]).toContain("val name: String? = null");
  });

  it("honors an operation's return lifecycle visibility", async () => {
    const { outputs } = await emitter({ features: { "lifecycle-models": true } }).compile(`
      @service namespace S;
      model User { @visibility(Lifecycle.Read) id: string; @visibility(Lifecycle.Create) password: string; }
      @returnTypeVisibility(Lifecycle.Create) @get op inspect(): User;
    `);
    expect(outputs["models/com/acme/models/UserCreate.kt"]).toContain("val password: String");
    expect(outputs["models/com/acme/models/UserCreate.kt"]).not.toContain("val id");
  });

  it("retains the existing public model shapes unless enabled", async () => {
    const { outputs } = await emitter().compile(source);
    expect(outputs["models/com/acme/models/User.kt"]).toContain("val password: String");
    expect(outputs["models/com/acme/models/UserCreate.kt"]).toBeUndefined();
  });
});
