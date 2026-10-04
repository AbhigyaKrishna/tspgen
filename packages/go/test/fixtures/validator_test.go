package checks

import (
	"encoding/json"
	"testing"

	models "example.com/validator/models"
	"github.com/go-playground/validator/v10"
)

func validPayload(t *testing.T) *models.Payload {
	t.Helper()
	var payload models.Payload
	err := json.Unmarshal([]byte(`{
  "name":"éé", "count":0, "active":false, "nullable":null,
  "children":[{"name":"ok"}], "mapping":{"a":{"name":"ok"}},
  "nullableChildren":[null], "nested":[[{"name":"ok"}]],
  "child":{"name":"ok"}, "plain":{"name":""}, "box":{"value":{"name":"ok"}},
  "state":"a,b|c\u0060d", "ratio":1.5, "literal":"a,b|c\u0060d",
  "literalBool":false, "literalNumber":0, "number":1, "decimal":1, "pattern":"bad",
  "extras":{"a":{"name":"ok"}}, "states":{"a":"active"}
 }`), &payload)
	if err != nil {
		t.Fatal(err)
	}
	return &payload
}

func TestValidatorTags(t *testing.T) {
	validate := validator.New(validator.WithRequiredStructEnabled())
	if err := validate.Struct(validPayload(t)); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		change func(*models.Payload)
	}{
		{"short name", func(p *models.Payload) { p.Name = "x" }},
		{"long name", func(p *models.Payload) { p.Name = "abcde" }},
		{"low count", func(p *models.Payload) { p.Count = -1 }},
		{"high count", func(p *models.Payload) { p.Count = 11 }},
		{"nil children", func(p *models.Payload) { p.Children = nil }},
		{"empty children", func(p *models.Payload) { p.Children = []*models.Child{} }},
		{"too many children", func(p *models.Payload) { p.Children = append(p.Children, p.Children[0], p.Children[0]) }},
		{"invalid child", func(p *models.Payload) { p.Children[0].Name = "x" }},
		{"nil child element", func(p *models.Payload) { p.Children[0] = nil }},
		{"invalid map value", func(p *models.Payload) { p.Mapping["a"].Name = "x" }},
		{"nil map value", func(p *models.Payload) { p.Mapping["a"] = nil }},
		{"nil nested slice", func(p *models.Payload) { p.Nested[0] = nil }},
		{"invalid nested value", func(p *models.Payload) { p.Nested[0][0].Name = "x" }},
		{"nil model", func(p *models.Payload) { p.Child = nil }},
		{"invalid generic value", func(p *models.Payload) { p.Box.Value.Name = "x" }},
		{"invalid enum", func(p *models.Payload) { p.State = "wrong" }},
		{"invalid numeric enum", func(p *models.Payload) { p.Ratio = 3 }},
		{"invalid literal", func(p *models.Payload) { p.Literal = "wrong" }},
		{"invalid bool literal", func(p *models.Payload) { p.LiteralBool = true }},
		{"invalid number literal", func(p *models.Payload) { p.LiteralNumber = 1 }},
		{"invalid additional value", func(p *models.Payload) { p.Extras.AdditionalProperties["a"].Name = "x" }},
		{"nil additional value", func(p *models.Payload) { p.Extras.AdditionalProperties["a"] = nil }},
		{"invalid additional enum", func(p *models.Payload) { p.States.AdditionalProperties["a"] = "wrong" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := validPayload(t)
			test.change(payload)
			if err := validate.Struct(payload); err == nil {
				t.Fatal("invalid value accepted")
			}
		})
	}
	for _, value := range []string{"active", "a b", ""} {
		payload := validPayload(t)
		payload.State = models.State(value)
		if err := validate.Struct(payload); err != nil {
			t.Fatal(err)
		}
	}
	empty := validPayload(t)
	empty.Extras.AdditionalProperties, empty.States.AdditionalProperties = nil, map[string]models.State{}
	if err := validate.Struct(empty); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"optional", "nullable"} {
		t.Run(field, func(t *testing.T) {
			payload := validPayload(t)
			if err := json.Unmarshal([]byte(`{"`+field+`":"x"}`), payload); err != nil {
				t.Fatal(err)
			}
			if err := validate.Struct(payload); err == nil {
				t.Fatal("present invalid value accepted")
			}
		})
	}
}
