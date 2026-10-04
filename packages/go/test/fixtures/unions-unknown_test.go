package models

import (
	"encoding/json"
	"testing"
)

func TestUnknownVariants(t *testing.T) {
	var pet Pet
	if err := json.Unmarshal([]byte(`{"kind":"bird","name":"x"}`), &pet); err != nil || string(pet.Unknown) != `{"kind":"bird","name":"x"}` {
		t.Fatalf("unknown discriminator: %+v %v", pet, err)
	}
	if raw, err := json.Marshal(pet); err != nil || string(raw) != `{"kind":"bird","name":"x"}` {
		t.Fatalf("re-encode unknown: %s %v", raw, err)
	}
	if err := pet.Validate(); err == nil {
		t.Fatal("validation accepted an unknown variant")
	}
	var scalar HolderScalar
	if err := json.Unmarshal([]byte(`1.5`), &scalar); err != nil || string(scalar.Unknown) != `1.5` {
		t.Fatalf("unknown untagged value: %+v %v", scalar, err)
	}
	var item Item
	if err := json.Unmarshal([]byte(`{"label":"x"}`), &item); err != nil || item.Unknown == nil || item.Large != nil || item.Small != nil {
		t.Fatalf("object matching no variant's required properties: %+v %v", item, err)
	}
	var event Event
	if err := json.Unmarshal([]byte(`{"type":"moved","data":{}}`), &event); err != nil || event.Unknown == nil {
		t.Fatalf("unknown envelope: %+v %v", event, err)
	}
}
