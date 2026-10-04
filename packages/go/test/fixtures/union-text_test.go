package models

import (
	"encoding"
	"reflect"
	"testing"
)

type textUnion interface {
	encoding.TextMarshaler
	encoding.TextUnmarshaler
}

func resolves(t *testing.T, union textUnion, raw, field string) {
	t.Helper()
	if err := union.UnmarshalText([]byte(raw)); err != nil {
		t.Fatalf("%q: %v", raw, err)
	}
	if reflect.ValueOf(union).Elem().FieldByName(field).IsNil() {
		t.Fatalf("%q: want %s, got %+v", raw, field, union)
	}
	text, err := union.MarshalText()
	if err != nil || string(text) != raw {
		t.Fatalf("%q: re-encoded %q %v", raw, text, err)
	}
}

func TestUnionTextResolution(t *testing.T) {
	for _, c := range []struct{ raw, field string }{
		{"auto", "Auto"}, {"5", "Count"}, {"1.5", "Ratio"}, {"true", "Flag"},
		{"verde", "Color"}, {"red", "Color"}, {"green", "Name"}, {"hello", "Name"},
		// Numbers and booleans only match their exact text form.
		{" 1", "Name"}, {"1.5 ", "Name"}, {" true", "Name"}, {"0x10", "Name"},
	} {
		resolves(t, &Mode{}, c.raw, c.field)
	}
	// Ranks follow the TypeSpec scalar: integer (json.Number) is an integer, decimal a float.
	resolves(t, &Num{}, "2", "Count")
	resolves(t, &Num{}, "1.5", "Ratio")
	resolves(t, &Dec{}, "1.5", "Amount")
	resolves(t, &Dec{}, " 1.5", "Name")
	resolves(t, &Dec{}, "abc", "Name")
	// Numeric enum and boolean literal variants match exact member text.
	resolves(t, &Tier{}, "1", "Level")
	resolves(t, &Tier{}, "true", "Flag")
	resolves(t, &Tier{}, "3", "Name")
	resolves(t, &Tier{}, "false", "Name")
	var num Num
	if err := num.UnmarshalText([]byte(" 2")); err == nil {
		t.Fatalf("padded number must fail, got %+v", num)
	}
	var strict Strict
	if err := strict.UnmarshalText([]byte("many")); err == nil {
		t.Fatal("text that no variant parses must fail")
	}
	if _, err := (Mode{}).MarshalText(); err == nil {
		t.Fatal("an unset union has no text")
	}
}

func TestEnumParameters(t *testing.T) {
	var color Color
	if err := DecodeParameter("purple", &color); err == nil {
		t.Fatalf("unknown member accepted: %q", color)
	}
	if err := DecodeParameter("verde", &color); err != nil || color != ColorGreen {
		t.Fatalf("verde: %q %v", color, err)
	}
	var level Level
	if err := DecodeParameter("3", &level); err == nil {
		t.Fatalf("unknown member accepted: %v", level)
	}
	if err := DecodeParameter("2", &level); err != nil || level != LevelHigh {
		t.Fatalf("2: %v %v", level, err)
	}
	if text, err := EncodeParameter(LevelHigh); err != nil || text != "2" {
		t.Fatalf("encode: %q %v", text, err)
	}
	// Numeric members match only their canonical text, like union members.
	for _, raw := range []string{"+1", "01", "1.0", "1e0", " 1"} {
		if err := DecodeParameter(raw, &level); err == nil {
			t.Fatalf("non-canonical %q accepted", raw)
		}
	}
	var ratio Ratio
	for _, raw := range []string{"5e-1", ".5", "0.50", "0x1p-1", "1e-07"} {
		if err := DecodeParameter(raw, &ratio); err == nil {
			t.Fatalf("non-canonical %q accepted", raw)
		}
	}
	for raw, member := range map[string]Ratio{"0.5": RatioHalf, "1e-7": RatioTiny} {
		if err := DecodeParameter(raw, &ratio); err != nil || ratio != member {
			t.Fatalf("%s: %v %v", raw, ratio, err)
		}
		if text, err := EncodeParameter(member); err != nil || text != raw {
			t.Fatalf("encode %v: %q %v", member, text, err)
		}
	}
}
