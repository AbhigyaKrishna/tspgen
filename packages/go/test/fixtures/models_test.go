package models_test

import (
 "bytes"
 "encoding/json"
 "testing"
 "time"
 models "example.com/config/models"
)

func valid() *models.Animal {
 return &models.Animal{ID: 1, Name: "ok", Created: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func TestDefaultsAndPolicies(t *testing.T) {
 value := models.NewAnimal()
 if value.Price == nil || *value.Price != "1.25" || value.Kind == nil || *value.Kind != "pet" { t.Fatalf("defaults: %+v", value) }
 data := []byte(`{"id":1,"name":"ok","created":"2026-01-01T00:00:00Z","note":null}`)
 if err := models.DecodeJSON(data, &value, false, true, true); err != nil { t.Fatal(err) }
 if value.Price == nil || *value.Price != "1.25" { t.Fatal("decode defaults") }
 raw, err := models.EncodeJSON(value, false, true)
 if err != nil || bytes.Contains(raw, []byte(`"price"`)) || !bytes.Contains(raw, []byte(`"note":null`)) { t.Fatalf("default omission: %s %v", raw, err) }
 raw, err = models.EncodeJSON(value, true, true)
 if err != nil || !bytes.Contains(raw, []byte(`"price":"1.25"`)) || !bytes.Contains(raw, []byte(`"trace":null`)) { t.Fatalf("encode defaults: %s %v", raw, err) }
 raw, err = models.EncodeJSON(value, true, false)
 if err != nil || bytes.Contains(raw, []byte(`"note"`)) || bytes.Contains(raw, []byte(`"trace"`)) { t.Fatalf("explicit nulls: %s %v", raw, err) }
 rawBytes := []byte{1, 2, 255}
 value.Raw = &rawBytes
 raw, err = models.EncodeJSON(value, false, true)
 if err != nil || !bytes.Contains(raw, []byte(`"raw":"AQL/"`)) { t.Fatalf("bytes: %s %v", raw, err) }
 if err := models.DecodeJSON(raw, &value, false, true, true); err != nil { t.Fatal(err) }
}

func TestValidation(t *testing.T) {
 for _, data := range []string{
  `{"name":"ok","created":"2026-01-01T00:00:00Z","note":null}`,
  `{"id":null,"name":"ok","created":"2026-01-01T00:00:00Z","note":null}`,
  `{"id":0,"name":"ok","created":"2026-01-01T00:00:00Z","note":null}`,
  `{"id":1,"name":"x","created":"2026-01-01T00:00:00Z","note":null}`,
  `{"id":1,"name":"ok","created":"2026-01-01T00:00:00Z","note":null,"tags":[]}`,
  `{"id":1,"name":"ok","created":"2026-01-01T00:00:00Z","note":null,"tags":[null]}`,
  `{"id":1,"name":"ok","created":"2026-01-01T00:00:00Z","note":null,"kind":"other"}`,
  `{"id":1,"name":"ok","created":"2026-01-01T00:00:00Z","note":null,"extra":1}`,
  `{"id":1,"name":"ok","created":"2026-01-01T00:00:00Z","note":null} {}`,
 } {
  var value *models.Animal
  if err := models.DecodeJSON([]byte(data), &value, false, true, true); err == nil { t.Errorf("accepted invalid JSON: %s", data) }
 }
 var relaxed *models.Animal
 if err := models.DecodeJSON([]byte(`{"extra":1}`), &relaxed, true, false, false); err != nil { t.Fatal(err) }
 if relaxed.Price != nil { t.Fatal("disabled defaults") }
 page := &models.Page[*models.Animal]{Items: []*models.Animal{valid()}}
 if err := models.ValidateValue(page); err != nil { t.Fatal(err) }
 page.Items[0].ID = 0
 if err := models.ValidateValue(page); err == nil { t.Fatal("nested validation missing") }
}

func TestEnumUnknownAndParameters(t *testing.T) {
 var state models.State
 if err := json.Unmarshal([]byte(`"future"`), &state); err != nil || state != models.StateUNKNOWN { t.Fatalf("unknown: %s %v", state, err) }
 if _, err := json.Marshal(state); err == nil { t.Fatal("encoded UNKNOWN") }
 var date time.Time
 if err := models.DecodeParameter("2026-01-01T00:00:00Z", &date); err != nil { t.Fatal(err) }
 if text, err := models.EncodeParameter(date); err != nil || text != "2026-01-01T00:00:00Z" { t.Fatalf("date: %s %v", text, err) }
 var trace *models.TraceID
 if err := models.DecodeParameter("a\x01\nb", &trace); err != nil || *trace != "a\x01\nb" { t.Fatal("text parameter") }
}

func TestCyclesDoNotHangValidation(t *testing.T) {
 object := map[string]any{}
 object["self"] = object
 array := make([]any, 1)
 array[0] = array
 for _, value := range []any{object, array} {
  if err := models.ValidateValue(value); err != nil { t.Fatal(err) }
  if _, err := models.EncodeJSON(value, false, true); err == nil { t.Fatal("cyclic JSON was accepted") }
 }
}
