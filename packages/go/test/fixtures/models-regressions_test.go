package models

import (
	"encoding/json"
	"strings"
	"testing"
)

const validPayload = `{"box":{"value":1},"nullable":{"value":null},"node":{"value":{"id":1}},"nullableNode":{"value":null},"page":{"items":[1]},"nullablePage":{"items":[null]},"nested":{"value":{"items":[1]}},"mapping":{"a":{"value":1}},"count":123456789012345678901234567890,"counts":[1,2],"optional":{},"pair":{"first":null,"second":{"id":1}}}`

func TestGenericNullability(t *testing.T) {
	for _, test := range []struct{ original, invalid string }{
		{`"box":{"value":1}`, `"box":{"value":null}`},
		{`"node":{"value":{"id":1}}`, `"node":{"value":null}`},
		{`"page":{"items":[1]}`, `"page":{"items":[null]}`},
		{`"nested":{"value":{"items":[1]}}`, `"nested":{"value":{"items":[null]}}`},
		{`"mapping":{"a":{"value":1}}`, `"mapping":{"a":{"value":null}}`},
		{`"optional":{}`, `"optional":{"value":null}`},
	} {
		var value *Payload
		raw := strings.Replace(validPayload, test.original, test.invalid, 1)
		if err := DecodeJSON([]byte(raw), &value, false, true, true); err == nil {
			t.Errorf("accepted invalid generic JSON: %s", test.invalid)
		}
	}
	var scalar *Box[int32]
	if err := DecodeJSON([]byte(`{"value":null}`), &scalar, false, true, true); err == nil {
		t.Error("accepted null for a direct scalar generic")
	}
	var optional *OptionalBox[int32]
	if err := DecodeJSON([]byte(`{"value":null}`), &optional, false, true, true); err == nil {
		t.Error("accepted present null for an optional scalar generic")
	}
	var page *OptionalPage[int32]
	if err := DecodeJSON([]byte(`{"items":[1]}`), &page, false, true, true); err != nil {
		t.Fatalf("rejected direct optional generic collection: %v", err)
	}
	var binary *Box[[]byte]
	if err := DecodeJSON([]byte(`{"value":"AQI="}`), &binary, false, true, true); err != nil {
		t.Fatalf("rejected direct generic bytes: %v", err)
	}
}

func TestIntegerValidation(t *testing.T) {
	for _, number := range []string{"1.5", "1e-1", "1e-1000000", `"1"`} {
		var value *Payload
		raw := strings.Replace(validPayload, "123456789012345678901234567890", number, 1)
		if err := DecodeJSON([]byte(raw), &value, false, true, true); err == nil {
			t.Errorf("accepted invalid integer: %s", number)
		}
	}
	for _, number := range []string{"0", "-123", "1.0", "1e20", "100e-2", "0e-1000000", "1e1000000"} {
		var value *Payload
		raw := strings.Replace(validPayload, "123456789012345678901234567890", number, 1)
		if err := DecodeJSON([]byte(raw), &value, false, true, true); err != nil {
			t.Errorf("rejected integer %s: %v", number, err)
		}
	}
	var value *Payload
	raw := strings.Replace(validPayload, `"counts":[1,2]`, `"counts":[1,2.5]`, 1)
	if err := DecodeJSON([]byte(raw), &value, false, true, true); err == nil {
		t.Error("accepted fractional integer array element")
	}
}

func TestDashPropertyRoundTrip(t *testing.T) {
	var value *Dash
	if err := DecodeJSON([]byte(`{"-":"hello"}`), &value, false, true, true); err != nil {
		t.Fatal(err)
	}
	if value.Value != "hello" {
		t.Fatalf("lost property: %+v", value)
	}
	raw, err := EncodeJSON(value, false, true)
	if err != nil || !strings.Contains(string(raw), `"-":"hello"`) {
		t.Fatalf("dash encoding: %s %v", raw, err)
	}
}

func TestConstructedValidation(t *testing.T) {
	var value *Payload
	if err := DecodeJSON([]byte(validPayload), &value, false, true, true); err != nil {
		t.Fatal(err)
	}
	if value.Count != json.Number("123456789012345678901234567890") {
		t.Fatalf("lost precision: %+v", value)
	}
	if err := ValidateValue(value); err != nil {
		t.Fatal(err)
	}
	value.Node.Value = nil
	if err := ValidateValue(value); err == nil {
		t.Error("accepted nil nonnullable generic model")
	}
	value.Node.Value = &Node{Id: 1}
	value.Pair.Second = nil
	if err := ValidateValue(value); err == nil {
		t.Error("nullable nil hid a subsequent nonnullable nil")
	}
	value.Pair.Second = &Node{Id: 1}
	value.Link = &Link[*Node]{Item: &Node{Id: 1}}
	value.Link.Next = value.Link
	if err := ValidateValue(value); err != nil {
		t.Fatalf("cyclic generic validation: %v", err)
	}
	value.Count = json.Number("1.5")
	if err := ValidateValue(value); err == nil {
		t.Error("accepted constructed fractional integer")
	}
}
