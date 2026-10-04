package models

import (
	"encoding/json"
	"strings"
	"testing"
)

const holderJSON = `{"pet":{"kind":"cat","name":"Tom"},"pets":[{"kind":"dog","name":"Rex","good":true},{"kind":"cat","name":"Kit","lives":3}],"shape":{"kind":"square","side":2},"event":{"type":"created","data":{"id":1}},"item":{"id":1},"items":[{"id":2,"label":"big"}],"scalar":"x","mode":"auto","maybe":null}`

func decodeHolder(t *testing.T, raw string) *Holder {
	t.Helper()
	var value *Holder
	if err := DecodeJSON([]byte(raw), &value, false, true, true); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return value
}

func TestDiscriminatedModels(t *testing.T) {
	value := decodeHolder(t, holderJSON)
	if value.Pet.Cat == nil || value.Pet.Cat.Name != "Tom" || value.Pet.Dog != nil {
		t.Fatalf("pet: %+v", value.Pet)
	}
	if value.Pets[0].Dog == nil || !value.Pets[0].Dog.Good || value.Pets[1].Cat == nil {
		t.Fatalf("pets: %+v", value.Pets)
	}
	if value.Maybe != nil {
		t.Fatalf("nullable union: %+v", value.Maybe)
	}
	raw, err := json.Marshal(NewPetCat(&Cat{Name: "Tom"}))
	if err != nil || string(raw) != `{"kind":"cat","name":"Tom"}` {
		t.Fatalf("encode pet: %s %v", raw, err)
	}
	standalone, err := json.Marshal(&Dog{Name: "Rex", Good: true})
	if err != nil || !strings.HasPrefix(string(standalone), `{"kind":"dog",`) {
		t.Fatalf("standalone variant: %s %v", standalone, err)
	}
	var cat Cat
	if err := json.Unmarshal([]byte(`{"kind":"dog","name":"x"}`), &cat); err == nil {
		t.Fatal("accepted a mismatched discriminator")
	}
	var pet Pet
	if err := json.Unmarshal([]byte(`{"kind":"bird","name":"x"}`), &pet); err == nil {
		t.Fatal("accepted an unknown discriminator")
	}
}

func TestDiscriminatedUnions(t *testing.T) {
	value := decodeHolder(t, holderJSON)
	if value.Shape.Square == nil || value.Shape.Square.Side != 2 {
		t.Fatalf("shape: %+v", value.Shape)
	}
	if value.Event == nil || value.Event.Created == nil || value.Event.Created.Id != 1 {
		t.Fatalf("event: %+v", value.Event)
	}
	if raw, _ := json.Marshal(value.Event); string(raw) != `{"data":{"id":1},"type":"created"}` {
		t.Fatalf("encode event: %s", raw)
	}
	if raw, _ := json.Marshal(value.Shape); string(raw) != `{"kind":"square","side":2}` {
		t.Fatalf("encode shape: %s", raw)
	}
}

func TestUntaggedUnions(t *testing.T) {
	value := decodeHolder(t, holderJSON)
	if value.Item.Small == nil || value.Item.Large != nil {
		t.Fatalf("exact match should pick Small: %+v", value.Item)
	}
	if value.Items[0].Large == nil || value.Items[0].Large.Label != "big" {
		t.Fatalf("items: %+v", value.Items)
	}
	var lenient Item
	if err := json.Unmarshal([]byte(`{"id":1,"extra":true}`), &lenient); err != nil || lenient.Small == nil {
		t.Fatalf("lenient pass should pick the first variant with its required properties: %+v %v", lenient, err)
	}
	for _, test := range []struct {
		raw   string
		check func(*HolderScalar) bool
	}{
		{`1`, func(v *HolderScalar) bool { return v.Int32 != nil && *v.Int32 == 1 }},
		{`"x"`, func(v *HolderScalar) bool { return v.String != nil && *v.String == "x" }},
		{`true`, func(v *HolderScalar) bool { return v.Boolean != nil && *v.Boolean }},
	} {
		var scalar HolderScalar
		if err := json.Unmarshal([]byte(test.raw), &scalar); err != nil || !test.check(&scalar) {
			t.Errorf("scalar %s: %+v %v", test.raw, scalar, err)
		}
	}
	var scalar HolderScalar
	if err := json.Unmarshal([]byte(`1.5`), &scalar); err == nil {
		t.Error("accepted a value matching no variant")
	}
	var mode HolderMode
	if err := json.Unmarshal([]byte(`"auto"`), &mode); err != nil || mode.Auto == nil {
		t.Errorf("literal variant: %+v %v", mode, err)
	}
	if err := json.Unmarshal([]byte(`"manual"`), &mode); err == nil {
		t.Error("accepted a string that is not the literal")
	}
	if raw, _ := json.Marshal(&Item{Small: &Small{Id: 1}}); string(raw) != `{"id":1}` {
		t.Fatalf("encode item: %s", raw)
	}
	if err := (&Item{Small: &Small{}, Large: &Large{}}).Validate(); err == nil {
		t.Error("accepted two variants")
	}
	if err := (&Item{}).Validate(); err == nil {
		t.Error("accepted no variant")
	}
}

func TestPoliciesReachVariants(t *testing.T) {
	value := decodeHolder(t, holderJSON)
	if value.Pet.Cat.Lives == nil || *value.Pet.Cat.Lives != 9 {
		t.Fatalf("default inside a variant not applied: %+v", value.Pet.Cat)
	}
	extra := strings.Replace(holderJSON, `"name":"Tom"`, `"name":"Tom","extra":1`, 1)
	var strict *Holder
	if err := DecodeJSON([]byte(extra), &strict, false, true, true); err == nil {
		t.Fatal("accepted an unknown key inside a variant")
	}
	if err := DecodeJSON([]byte(extra), &strict, true, true, true); err != nil {
		t.Fatalf("ignore-unknown-keys: %v", err)
	}
	envelope := strings.Replace(holderJSON, `"type":"created"`, `"type":"created","extra":1`, 1)
	if err := DecodeJSON([]byte(envelope), &strict, false, true, true); err == nil {
		t.Fatal("accepted an unknown key in an envelope")
	}
	missing := strings.Replace(holderJSON, `"item":{"id":1}`, `"item":{}`, 1)
	if err := DecodeJSON([]byte(missing), &strict, false, true, true); err == nil {
		t.Fatal("accepted a variant missing a required property")
	}
	withDefaults, err := EncodeJSON(NewPetCat(&Cat{Name: "Tom"}), true, true)
	if err != nil || !strings.Contains(string(withDefaults), `"lives":null`) || !strings.HasPrefix(string(withDefaults), `{"kind":"cat"`) {
		t.Fatalf("encode-defaults inside a variant: %s %v", withDefaults, err)
	}
	plain, err := EncodeJSON(NewPetCat(&Cat{Name: "Tom"}), false, true)
	if err != nil || strings.Contains(string(plain), "lives") {
		t.Fatalf("encode without defaults: %s %v", plain, err)
	}
}
