package models

import (
	"encoding/json"
	"testing"
)

func TestEnumAliases(t *testing.T) {
	for _, state := range []State{StateFirst, StateSecond} {
		if err := state.Validate(); err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(state)
		if err != nil || string(raw) != `"active"` {
			t.Fatalf("alias encoding: %s %v", raw, err)
		}
		var decoded State
		if err := json.Unmarshal(raw, &decoded); err != nil || decoded != state {
			t.Fatalf("alias decoding: %s %v", decoded, err)
		}
	}
	if err := CodeSecond.Validate(); err != nil {
		t.Fatal(err)
	}
}
