@service namespace S;

model Labels { name: string; ...Record<int32>; }
model Settings extends Record<string> { @minLength(2) id: string; }
model Child extends Settings { mode?: string = "auto"; }
model Flags is Record<boolean>;
model Inner { @minValue(1) count: int32; size?: int32 = 7; }
model Nested { ...Record<Inner>; }
model Mixed { inner: Inner; ...Record<Inner>; }
model Anything { ...Record<unknown>; }

@discriminator("kind")
model Pet { kind: string; name: string; }
model Cat extends Pet { kind: "cat"; ...Record<string>; }

model G<T> { v: T; ...Record<string>; }
model Bag<T> { v: T; ...Record<T>; }

model Holder {
  labels: Labels;
  settings: Settings;
  child: Child;
  flags: Flags;
  nested: Nested;
  anything: Anything;
  pet: Pet;
  mixed: Mixed;
}
model GenericHolder { g: G<int32>; bag?: Bag<string>; }

@post op write(@body input: Holder): Holder;
@put op generic(@body input: GenericHolder): GenericHolder;
