@service namespace S;

@discriminator("kind")
model Pet { kind: string; name: string; }
model Cat extends Pet { kind: "cat"; lives?: int32 = 9; }
model Dog extends Pet { kind: "dog"; good: boolean; }

model Circle { radius: float64; }
model Square { side: float64; }
@discriminated(#{ envelope: "none" })
union Shape { circle: Circle, square: Square }

model Created { id: int32; }
model Deleted { id: int32; }
@discriminated(#{ envelope: "object", discriminatorPropertyName: "type", envelopePropertyName: "data" })
union Event { created: Created, deleted: Deleted }

model Large { id: int32; label: string; }
model Small { id: int32; }
union Item { Large, Small }

model Holder {
  pet: Pet;
  pets: Pet[];
  shape: Shape;
  event?: Event;
  item: Item;
  items: Item[];
  `scalar`: int32 | string | boolean;
  mode: "auto" | int32;
  maybe: Pet | null;
}

@post op write(@body input: Holder): Holder;
