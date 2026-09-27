import { resolvePath, type Model } from "@typespec/compiler";
import { createTester } from "@typespec/compiler/testing";
import { describe, expect, it } from "vitest";
import {
  buildApiIR,
  collectDecorators,
  coreFeatures,
  declarationScopes,
  defineFeatures,
  enclosingNamespaceDecorators,
  lineComments,
  loadSseLibraries,
  loadVersioning,
  resolveMeta,
  type ApiIR,
  type EnumIR,
  type ModelIR,
  type ResolvedFeatures,
  type TypeIR,
  type UnionIR,
} from "../../src/index.js";
import { stripDocs } from "../../src/ir/feature-meta.js";

const MetaTester = createTester(resolvePath(import.meta.dirname, "../.."), {
  libraries: ["@typespec/http", "@abhigyakrishna/tspgen-core"],
})
  .importLibraries()
  .using("Http", "TspGen");

const VersionedMetaTester = createTester(resolvePath(import.meta.dirname, "../.."), {
  libraries: ["@typespec/http", "@typespec/versioning", "@abhigyakrishna/tspgen-core"],
})
  .importLibraries()
  .using("Http", "Versioning", "TspGen");

const SseMetaTester = createTester(resolvePath(import.meta.dirname, "../.."), {
  libraries: [
    "@typespec/http",
    "@typespec/streams",
    "@typespec/events",
    "@typespec/sse",
    "@abhigyakrishna/tspgen-core",
  ],
})
  .importLibraries()
  .using("Http", "SSE", "Events", "TspGen");

const features = (configured: Record<string, unknown> = {}) => defineFeatures(coreFeatures).resolve(configured);

/** A `generics` callback (for `buildApiIR`) resolving `features.generics` for the "kotlin" scope. */
function genericsFor(f: ResolvedFeatures<string>) {
  return (declaration: Model) =>
    f.at(
      "generics",
      resolveMeta(declarationScopes(collectDecorators(declaration), enclosingNamespaceDecorators(declaration)), "kotlin"),
      "model",
    );
}

function find(ir: ApiIR, id: string): TypeIR {
  const found = ir.types.find((t) => t.id === id);
  if (!found) throw new Error(`type ${id} not found in ${ir.types.map((t) => t.id).join(", ")}`);
  return found;
}

const docsSpec = `
  @service namespace S {
    @meta("kotlin", #{ features: #{ docs: false } })
    namespace Quiet {
      /** Hidden */ model Hidden { /** p */ id: int32 }
    }
    /** Shown */ model Shown { /** p */ id: int32 }
    /** Off */ @meta("kotlin", #{ features: #{ docs: false } }) model Off { /** p */ id: int32 }
    /** Back */ @meta("kotlin", #{ features: #{ docs: true } }) model Back { id: int32 }
    /** E */ enum E { /** m */ a }
    /** G */
    @meta("kotlin", #{ features: #{ docs: false } })
    @route("/g") interface G { /** get */ @get get(/** q */ @query q: string): void; }
    /** Single */ @meta("kotlin", #{ features: #{ docs: false } }) @route("/o") @get op single(): void;
    /** Kept */ @route("/k") @get op kept(): void;
  }
`;

describe("namespace decorators on types", () => {
  it("records the enclosing namespaces' decorators only when one of them has some", async () => {
    const { program } = await MetaTester.compile(docsSpec);
    const ir = buildApiIR(program);
    expect(find(ir, "S.Quiet.Hidden").namespaceDecorators).toEqual([
      {},
      { "TspGen.meta": [["kotlin", { features: { docs: false } }]] },
    ]);
    expect(find(ir, "S.Shown").namespaceDecorators).toBeUndefined();
  });

  it("returns a fresh array each time, so mutating one type's chain cannot leak into another's", async () => {
    const { program } = await MetaTester.compile(docsSpec);
    const first = buildApiIR(program);
    const hiddenChain = find(first, "S.Quiet.Hidden").namespaceDecorators!;
    hiddenChain.push({ mutated: [[true]] });
    const second = buildApiIR(program);
    expect(find(second, "S.Quiet.Hidden").namespaceDecorators).toEqual([
      {},
      { "TspGen.meta": [["kotlin", { features: { docs: false } }]] },
    ]);
  });
});

describe("namespace inheritance is consistent for types and operations", () => {
  it("both a model and an operation lose docs from a @meta set above the service namespace", async () => {
    const { program } = await MetaTester.compile(`
      @meta("kotlin", #{ features: #{ docs: false } })
      namespace Acme {
        @service namespace Pets {
          /** A pet */ model Pet { /** id */ id: int32 }
          /** list */ @route("/p") @get op list(): void;
        }
      }
    `);
    const ir = buildApiIR(program);
    stripDocs(ir, features(), "kotlin");
    expect(find(ir, "Acme.Pets.Pet").docs).toBeUndefined();
    const ops = ir.services[0].groups.flatMap((g) => g.operations);
    expect(ops.find((op) => op.name === "list")!.docs).toBeUndefined();
  });
});

describe("stripDocs", () => {
  it("drops docs where features.docs resolves false for the language", async () => {
    const { program } = await MetaTester.compile(docsSpec);
    const ir = buildApiIR(program);
    stripDocs(ir, features(), "kotlin");
    expect(find(ir, "S.Quiet.Hidden")).toMatchObject({ properties: [{ name: "id" }] });
    expect(find(ir, "S.Quiet.Hidden").docs).toBeUndefined();
    const hidden = find(ir, "S.Quiet.Hidden");
    if (hidden.kind !== "model") throw new Error("expected model");
    expect(hidden.properties[0].docs).toBeUndefined();
    expect(find(ir, "S.Off").docs).toBeUndefined();
    expect(find(ir, "S.Shown").docs).toBe("Shown");
    expect(find(ir, "S.E").docs).toBe("E");
    const groups = ir.services[0].groups;
    const g = groups.find((x) => x.id === "S.G")!;
    expect(g.docs).toBeUndefined();
    expect(g.operations[0].docs).toBeUndefined();
    expect(g.operations[0].params[0].docs).toBeUndefined();
    const ops = groups.flatMap((x) => x.operations);
    expect(ops.find((op) => op.name === "single")!.docs).toBeUndefined();
    expect(ops.find((op) => op.name === "kept")!.docs).toBe("Kept");
  });

  it("turns docs off globally, back on per declaration, and ignores other languages' scopes", async () => {
    const { program } = await MetaTester.compile(docsSpec);
    const off = buildApiIR(program);
    stripDocs(off, features({ docs: false }), "kotlin");
    expect(find(off, "S.Shown").docs).toBeUndefined();
    expect(find(off, "S.Back").docs).toBe("Back");
    const ts = buildApiIR(program);
    stripDocs(ts, features(), "typescript");
    expect(find(ts, "S.Off").docs).toBe("Off");
  });

  it("honours the \"*\" meta scope", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S;
      /** Off */ @meta("*", #{ features: #{ docs: false } }) model Off { id: int32 }
      /** On */ model On { id: int32 }
    `);
    const ir = buildApiIR(program);
    stripDocs(ir, features(), "kotlin");
    expect(find(ir, "S.Off").docs).toBeUndefined();
    expect(find(ir, "S.On").docs).toBe("On");
  });

  it("strips enum member and union variant docs when docs resolves false", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S {
        /** E */ enum E { /** m */ a }
        /** U */ union U { /** v */ v: string }
        op noop(): void;
      }
    `);
    const ir = buildApiIR(program);
    stripDocs(ir, features({ docs: false }), "kotlin");
    const e = find(ir, "S.E") as EnumIR;
    expect(e.docs).toBeUndefined();
    expect(e.members[0].docs).toBeUndefined();
    const u = find(ir, "S.U") as UnionIR;
    expect(u.docs).toBeUndefined();
    expect(u.variants[0].docs).toBeUndefined();
  });

  it("strips @events union variant and event docs when docs resolves false", async () => {
    const sse = await loadSseLibraries();
    const { program } = await SseMetaTester.compile(`
      @service namespace S;
      model Msg { text: string }
      /** Channel events */
      @events union Ev {
        /** joined */
        note: Msg,
      }
      @route("/c") op subscribe(): SSEStream<Ev>;
    `);
    const ir = buildApiIR(program, sse ? { sse } : {});
    stripDocs(ir, features({ docs: false }), "kotlin");
    const ev = find(ir, "S.Ev") as UnionIR;
    expect(ev.docs).toBeUndefined();
    expect(ev.variants[0].docs).toBeUndefined();
    expect(ev.events?.[0].docs).toBeUndefined();
  });

  it("strips op.body docs and multipart part docs where docs resolves false", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S;
      model Pet { id: int32 }
      model UploadRequest {
        /** display name */
        name: HttpPart<string>;
      }
      @meta("kotlin", #{ features: #{ docs: false } })
      @route("/u") @post op upload(@header contentType: "multipart/form-data", @multipartBody body: UploadRequest): void;
      @meta("kotlin", #{ features: #{ docs: false } })
      @route("/s") @post op single(
        /** the body */
        @body b: Pet,
      ): void;
    `);
    const ir = buildApiIR(program);
    stripDocs(ir, features(), "kotlin");
    const ops = ir.services[0].groups.flatMap((g) => g.operations);
    const upload = ops.find((op) => op.name === "upload")!;
    expect(upload.body?.parts?.[0].docs).toBeUndefined();
    const single = ops.find((op) => op.name === "single")!;
    expect(single.body?.docs).toBeUndefined();
  });

  it("removes custom scalar docs when features.docs resolves false globally or via a namespace @meta", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S {
        @meta("kotlin", #{ features: #{ docs: false } })
        namespace Quiet {
          /** hidden id */
          scalar HiddenId extends string;
          model M { id: HiddenId }
        }
        /** shown id */
        scalar ShownId extends string;
        model N { a: ShownId; b: ShownId }
      }
    `);
    const byName = (ir: ApiIR, name: string) => {
      const found = ir.customScalars.find((s) => s.name === name);
      if (!found) throw new Error(`scalar ${name} not found among ${ir.customScalars.map((s) => s.name).join(", ")}`);
      return found;
    };

    const ir = buildApiIR(program);
    stripDocs(ir, features(), "kotlin");
    // Off via the enclosing namespace's @meta; the sibling scalar outside Quiet keeps its docs.
    expect(byName(ir, "HiddenId").docs).toBeUndefined();
    expect(byName(ir, "ShownId").docs).toBe("shown id");
    // Every ref to the same scalar shares the one (mutated) CustomScalarIR object.
    const n = find(ir, "S.N");
    if (n.kind !== "model") throw new Error("expected model");
    const [a, b] = n.properties.map((p) => p.type);
    if (a.kind !== "scalar" || b.kind !== "scalar") throw new Error("expected scalar refs");
    expect(a.custom?.docs).toBe("shown id");
    expect(b.custom).toBe(a.custom);

    const globallyOff = buildApiIR(program);
    stripDocs(globallyOff, features({ docs: false }), "kotlin");
    expect(byName(globallyOff, "ShownId").docs).toBeUndefined();
    expect(byName(globallyOff, "HiddenId").docs).toBeUndefined();
  });

  it("known limitation: an owning operation's docs:false does not reach an anonymous inline body model", async () => {
    // See stripDocs' JSDoc: an anonymous ($anon.*) inline model is not associated with the declaration that owns
    // it, so only a namespace-level @meta (not one set directly on the operation) can turn its docs off.
    const { program } = await MetaTester.compile(`
      @service namespace S;
      @meta("kotlin", #{ features: #{ docs: false } })
      @route("/x") @get op x(): { /** kept */ a: string };
    `);
    const ir = buildApiIR(program);
    stripDocs(ir, features(), "kotlin");
    const anon = ir.types.find((t) => t.id.startsWith("$anon.")) as ModelIR;
    expect(anon).toBeDefined();
    expect(anon.properties[0].docs).toBe("kept");
  });
});

describe("generics per template", () => {
  it("emits a template once per instance when its generics callback returns false", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S {
        @meta("kotlin", #{ features: #{ generics: false } }) model Page<T> { items: T[] }
        model Box<T> { item: T }
        model Pet { id: int32 }
        model Holder { pets: Page<Pet>; box: Box<Pet> }
      }
    `);
    const ir = buildApiIR(program, { generics: genericsFor(features()) });
    expect(find(ir, "S.Page<S.Pet>")).toMatchObject({ kind: "model", name: "PagePet" });
    expect(find(ir, "S.Box<T>")).toMatchObject({ kind: "model", typeParameters: ["T"] });
    expect(ir.types.some((t) => t.id === "S.Page")).toBe(false);
  });

  it("cascades: a template containing a non-generic nested template becomes per-instance too", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S {
        @meta("kotlin", #{ features: #{ generics: false } }) model Link<T> { value: T }
        model Page<T> { link: Link<T> }
        model Pet { id: int32 }
        model Holder { page: Page<Pet> }
      }
    `);
    const ir = buildApiIR(program, { generics: genericsFor(features()) });
    expect(ir.types.some((t) => t.id === "S.Page<T>")).toBe(false);
    expect(find(ir, "S.Page<S.Pet>")).toMatchObject({ kind: "model", name: "PagePet" });
    expect(find(ir, "S.Link<S.Pet>")).toMatchObject({ kind: "model", name: "LinkPet" });
  });

  it("resolves a versioned service's per-template generics", async () => {
    const { program } = await VersionedMetaTester.compile(`
      @versioned(Versions) @service namespace S;
      enum Versions { v1, v2 }
      @meta("kotlin", #{ features: #{ generics: false } }) model Page<T> { items: T[]; @added(Versions.v2) next?: string }
      model Pet { id: int32 }
      @route("/p") op pets(): Page<Pet>;
    `);
    const ir = buildApiIR(program, {
      versioning: (await loadVersioning(program)).versioning,
      generics: genericsFor(features()),
    });
    expect(ir.types.some((t) => t.id === "S.Page<T>")).toBe(false);
    expect(find(ir, "S.Page<S.Pet>")).toMatchObject({ kind: "model", name: "PagePet" });
  });

  it("calls a generics callback once per template declaration even with several instances", async () => {
    const { program } = await MetaTester.compile(`
      @service namespace S {
        model Page<T> { items: T[] }
        model A { id: int32 }
        model B { id: int32 }
        model Holder { a: Page<A>; b: Page<B> }
      }
    `);
    let calls = 0;
    const ir = buildApiIR(program, {
      generics: () => {
        calls++;
        return true;
      },
    });
    expect(calls).toBe(1);
    expect(ir.types.some((t) => t.id === "S.Page<T>")).toBe(true);
  });
});

describe("lineComments", () => {
  it("prefixes every line; blank lines get the bare prefix", () => {
    expect(lineComments("one", "//")).toBe("// one");
    expect(lineComments("@generated\n\nDo not edit.", "//")).toBe("// @generated\n//\n// Do not edit.");
  });

  it("drops a trailing newline (e.g. a YAML block scalar) instead of a stray blank comment line", () => {
    expect(lineComments("one\n", "//")).toBe("// one");
    expect(lineComments("one\ntwo\n\n", "//")).toBe("// one\n// two");
  });

  it("normalizes CRLF line endings", () => {
    expect(lineComments("one\r\ntwo\r\n", "//")).toBe("// one\n// two");
  });
});
