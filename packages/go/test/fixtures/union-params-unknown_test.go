package models

import (
	"encoding/json"
	"testing"
)

func TestUnknownParameters(t *testing.T) {
	var color Color
	if err := DecodeParameter("purple", &color); err != nil || color != ColorUNKNOWN {
		t.Fatalf("purple: %q %v", color, err)
	}
	if _, err := EncodeParameter(ColorUNKNOWN); err == nil {
		t.Fatal("UNKNOWN must not encode")
	}
	unknown := ColorUNKNOWN
	if _, err := (Mode{Color: &unknown}).MarshalText(); err == nil {
		t.Fatal("UNKNOWN variant must not encode")
	}
	var strict Strict
	if err := strict.UnmarshalText([]byte("many")); err != nil || string(strict.Unknown) != `"many"` {
		t.Fatalf("many: %+v %v", strict, err)
	}
	if text, err := strict.MarshalText(); err != nil || string(text) != "many" {
		t.Fatalf("re-encoded %q %v", text, err)
	}
	if text, err := (Strict{Unknown: json.RawMessage("42")}).MarshalText(); err != nil || string(text) != "42" {
		t.Fatalf("raw unknown: %q %v", text, err)
	}
	// decimal as a Go string still ranks as a number.
	var dec Dec
	if err := dec.UnmarshalText([]byte("1.5")); err != nil || dec.Amount == nil {
		t.Fatalf("1.5: %+v %v", dec, err)
	}
	if err := dec.UnmarshalText([]byte("abc")); err != nil || dec.Name == nil {
		t.Fatalf("abc: %+v %v", dec, err)
	}
}
