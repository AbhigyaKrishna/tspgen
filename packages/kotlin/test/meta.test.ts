import { expectDiagnostics } from "@typespec/compiler/testing";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitter } from "./tester.js";

const spec = `
  using Specgen;
  @service namespace S;
  @meta("kotlin", #{ annotations: #["@Entity"], imports: #["jakarta.persistence.Entity"], implements: #["java.io.Serializable"], table: "pets" })
  @meta("*", #{ owner: "team-a" })
  model Pet {
    @meta("kotlin", #{ annotations: #["@Volatile"] }) id: int64;
  }
  @discriminator("kind") model Toy { kind: string }
  model Ball extends Toy { kind: "ball" }
  enum Color { @meta("kotlin", #{ annotations: #["@Deprecated(\\"x\\")"] }) red, blue }
`;

describe("kotlin @meta keys", () => {
  it("applies annotations, imports and implements", async () => {
    const { outputs } = await emitter().compile(spec + `@@meta(S.Toy, "kotlin", #{ implements: #["java.io.Serializable"] });`);
    const pet = outputs["models/com/acme/models/Pet.kt"];
    expect(pet).toContain("import jakarta.persistence.Entity\n");
    // java.io.Serializable clashes with kotlinx.serialization.Serializable: written fully qualified
    expect(pet).not.toContain("import java.io.Serializable\n");
    expect(pet).toContain("import kotlinx.serialization.Serializable\n");
    expect(pet).toContain(`@Entity
@Serializable
data class Pet(
    @Volatile
    val id: Long,
) : java.io.Serializable`);
    expect(outputs["models/com/acme/models/Toy.kt"]).toContain("sealed interface Toy : java.io.Serializable");
    expect(outputs["models/com/acme/models/Color.kt"]).toContain(`    @Deprecated("x")
    @SerialName("red")
    RED,`);
  });

  it("qualifies property types whose simple name clashes with another import", async () => {
    const { outputs } = await emitter().compile(`
      @service namespace S;
      model Event { at: utcDateTime; @Kotlin.type("java.time.Instant") legacyAt: string; }
    `);
    const event = outputs["models/com/acme/models/Event.kt"];
    expect(event).toContain("import kotlin.time.Instant\n");
    expect(event).not.toContain("import java.time.Instant");
    expect(event).toContain("    val at: Instant,\n    val legacyAt: java.time.Instant,\n");
  });

  it("exposes all metadata to templates via it.h.meta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "specgen-meta-"));
    mkdirSync(dirname(join(dir, "kotlin/common/header.eta")), { recursive: true });
    writeFileSync(join(dir, "kotlin/common/header.eta"), `// meta: <%= it.decl ? JSON.stringify(it.h.meta(it.decl)) : "" %>`);
    const { outputs } = await emitter({ "template-dir": dir }).compile(spec);
    expect(outputs["models/com/acme/models/Pet.kt"]).toContain(
      `// meta: {"owner":"team-a","annotations":["@Entity"],"imports":["jakarta.persistence.Entity"],"implements":["java.io.Serializable"],"table":"pets"}`,
    );
  });

  it("warns on built-in keys with the wrong type", async () => {
    const [, diagnostics] = await emitter().compileAndDiagnose(`
      using Specgen;
      @service namespace S;
      @meta("kotlin", #{ annotations: 5 }) model M { x: int32 }
    `);
    expectDiagnostics(diagnostics, { code: "@specgen/emitter-core/invalid-meta", message: /'annotations' on 'S.M'/ });
  });
});
