package models

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestAdditionalRoundTrip(t *testing.T) {
	var labels *Labels
	if err := DecodeJSON([]byte(`{"name":"a","y":2,"x":1}`), &labels, false, true, true); err != nil {
		t.Fatal(err)
	}
	if labels.Name != "a" || len(labels.AdditionalProperties) != 2 || labels.AdditionalProperties["x"] != 1 || labels.AdditionalProperties["y"] != 2 {
		t.Fatalf("decoded %+v", labels)
	}
	if out, err := json.Marshal(labels); err != nil || string(out) != `{"name":"a","x":1,"y":2}` {
		t.Fatalf("encoded %s %v", out, err)
	}
	if out, _ := json.Marshal(&Labels{Name: "b"}); string(out) != `{"name":"b"}` {
		t.Fatalf("no extras: %s", out)
	}
	clash := &Labels{Name: "c", AdditionalProperties: map[string]int32{"name": 5, "z": 1}}
	if out, _ := json.Marshal(clash); string(out) != `{"name":"c","z":1}` {
		t.Fatalf("declared names win: %s", out)
	}
	if err := DecodeJSON([]byte(`{"name":"a","x":"nope"}`), &labels, false, true, true); err == nil {
		t.Fatal("additional values must decode as int32")
	}
}

func TestAdditionalPoliciesInsideEntries(t *testing.T) {
	var nested *Nested
	if err := DecodeJSON([]byte(`{"a":{"count":2}}`), &nested, false, true, true); err != nil {
		t.Fatal(err)
	}
	if inner := nested.AdditionalProperties["a"]; inner == nil || inner.Size == nil || *inner.Size != 7 {
		t.Fatalf("defaults inside entries: %+v", nested.AdditionalProperties["a"])
	}
	if err := DecodeJSON([]byte(`{"a":{"count":0}}`), &nested, false, true, true); err == nil {
		t.Fatal("validation inside entries")
	}
	if err := DecodeJSON([]byte(`{"a":{"count":1,"bogus":1}}`), &nested, false, true, true); err == nil {
		t.Fatal("strict keys inside entries")
	}
	if err := DecodeJSON([]byte(`{"a":{"count":1,"bogus":1}}`), &nested, true, true, true); err != nil {
		t.Fatalf("ignore-unknown-keys inside entries: %v", err)
	}
	if err := DecodeJSON([]byte(`{"a":null}`), &nested, false, true, true); err == nil {
		t.Fatal("non-nullable entries reject null")
	}
	encoded, err := EncodeJSON(&Nested{AdditionalProperties: map[string]*Inner{"a": {Count: 1}}}, false, false)
	if err != nil || strings.Contains(string(encoded), "null") || !strings.Contains(string(encoded), `"a":{"count":1}`) {
		t.Fatalf("encode policies inside entries: %s %v", encoded, err)
	}
}

func TestAdditionalStrictModelAcceptsExtras(t *testing.T) {
	var labels *Labels
	if err := DecodeJSON([]byte(`{"name":"a","anything":3}`), &labels, false, true, true); err != nil {
		t.Fatalf("every unknown key is an additional property: %v", err)
	}
}

func TestAdditionalInheritance(t *testing.T) {
	var child *Child
	if err := DecodeJSON([]byte(`{"id":"ab","color":"red"}`), &child, false, true, true); err != nil {
		t.Fatal(err)
	}
	if child.Mode == nil || *child.Mode != "auto" || len(child.AdditionalProperties) != 1 || child.AdditionalProperties["color"] != "red" {
		t.Fatalf("child %+v", child)
	}
	if err := DecodeJSON([]byte(`{"id":"a"}`), &child, false, true, true); err == nil {
		t.Fatal("inherited constraints still apply")
	}
	var flags *Flags
	if err := DecodeJSON([]byte(`{"on":true}`), &flags, false, true, true); err != nil || !flags.AdditionalProperties["on"] {
		t.Fatalf("flags %+v %v", flags, err)
	}
}

func TestAdditionalTaggedVariant(t *testing.T) {
	var pet *Pet
	if err := DecodeJSON([]byte(`{"kind":"cat","name":"Tom","color":"grey"}`), &pet, false, true, true); err != nil {
		t.Fatal(err)
	}
	if pet.Cat == nil || pet.Cat.Name != "Tom" || len(pet.Cat.AdditionalProperties) != 1 || pet.Cat.AdditionalProperties["color"] != "grey" {
		t.Fatalf("cat %+v", pet.Cat)
	}
	if out, err := json.Marshal(pet); err != nil || string(out) != `{"kind":"cat","name":"Tom","color":"grey"}` {
		t.Fatalf("encoded %s %v", out, err)
	}
}

func TestAdditionalUnknownValues(t *testing.T) {
	var anything *Anything
	if err := DecodeJSON([]byte(`{"a":{"b":[1,2]},"c":null}`), &anything, false, true, true); err != nil {
		t.Fatal(err)
	}
	if out, err := json.Marshal(anything); err != nil || string(out) != `{"a":{"b":[1,2]},"c":null}` {
		t.Fatalf("encoded %s %v", out, err)
	}
}

func TestAdditionalGenericModel(t *testing.T) {
	if err := (&GenericHolder{G: &G[int32]{V: 1}}).Validate(); err != nil {
		t.Fatalf("absent additional properties: %v", err)
	}
	if err := (&GenericHolder{G: &G[int32]{V: 1, AdditionalProperties: map[string]string{"x": "y"}}}).Validate(); err != nil {
		t.Fatalf("present additional properties: %v", err)
	}
	var holder *GenericHolder
	for _, body := range []string{`{"g":{"v":1}}`, `{"g":{"v":1,"x":"y"}}`} {
		if err := DecodeJSON([]byte(body), &holder, true, true, true); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
	}
	if holder.G.AdditionalProperties["x"] != "y" {
		t.Fatalf("generic entries %+v", holder.G)
	}
	if err := DecodeJSON([]byte(`{"g":{"v":1,"x":null}}`), &holder, true, true, true); err == nil || !strings.Contains(err.Error(), "additionalProperties") {
		t.Fatalf("null entry in generic model: %v", err)
	}
}

func TestAdditionalTypeParameterRecord(t *testing.T) {
	var bag *BagString
	if err := DecodeJSON([]byte(`{"v":"a","x":"b"}`), &bag, false, true, true); err != nil {
		t.Fatal(err)
	}
	if bag.V != "a" || bag.AdditionalProperties["x"] != "b" {
		t.Fatalf("bag %+v", bag)
	}
	if out, err := json.Marshal(bag); err != nil || string(out) != `{"v":"a","x":"b"}` {
		t.Fatalf("encoded %s %v", out, err)
	}
}

func TestAdditionalValidateEntries(t *testing.T) {
	err := (&Nested{AdditionalProperties: map[string]*Inner{"x": nil}}).Validate()
	if err == nil || !strings.Contains(err.Error(), "additionalProperties") {
		t.Fatalf("nil entry: %v", err)
	}
	if err := (&Nested{AdditionalProperties: map[string]*Inner{"x": {Count: 1}}}).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (&Labels{Name: "a"}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestAdditionalEncodeSkipsDeclaredKeys(t *testing.T) {
	plain, err := EncodeJSON(&Mixed{Inner: &Inner{Count: 2}}, true, false)
	if err != nil {
		t.Fatal(err)
	}
	size := int32(9)
	clash, err := EncodeJSON(&Mixed{Inner: &Inner{Count: 2}, AdditionalProperties: map[string]*Inner{"inner": {Count: 1, Size: &size}}}, true, false)
	if err != nil || string(clash) != string(plain) {
		t.Fatalf("declared property re-encoded with an entry: %s vs %s %v", clash, plain, err)
	}
}

func TestAdditionalDecodeErrorPath(t *testing.T) {
	for i := 0; i < 20; i++ {
		var labels Labels
		err := json.Unmarshal([]byte(`{"name":"a","d":"x","c":"y","b":"z"}`), &labels)
		var invalid *ValidationError
		if !errors.As(err, &invalid) || invalid.Field != "additionalProperties.b" {
			t.Fatalf("decode error: %v", err)
		}
	}
}
