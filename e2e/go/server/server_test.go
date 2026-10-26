package server_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	client "example.com/petstore/client"
	"example.com/petstore/e2e/internal/testsupport"
)

const validPetJSON = `{"id":1,"name":"Milo","species":"parrot","born_at":"2026-01-02T03:04:05Z","note":null}`

func TestServerRejectsInvalidRequests(t *testing.T) {
	cases := []struct {
		name, method, path, contentType, body string
		status                                int
	}{
		{"malformed JSON", "POST", "/pets", "application/json", "{", 400},
		{"missing name", "POST", "/pets", "application/json", strings.Replace(validPetJSON, `"name":"Milo",`, "", 1), 400},
		{"missing nullable property", "POST", "/pets", "application/json", strings.Replace(validPetJSON, `,"note":null`, "", 1), 400},
		{"unknown property", "POST", "/pets", "application/json", strings.TrimSuffix(validPetJSON, "}") + `,"extra":true}`, 400},
		{"name constraint", "POST", "/pets", "application/json", strings.Replace(validPetJSON, "Milo", "x", 1), 400},
		{"unknown enum", "POST", "/pets", "application/json", strings.Replace(validPetJSON, "parrot", "dragon", 1), 400},
		{"null body", "POST", "/pets", "application/json", "null", 400},
		{"missing body", "POST", "/pets", "application/json", "", 400},
		{"trailing JSON", "POST", "/pets", "application/json", validPetJSON + " {}", 400},
		{"unsupported media", "POST", "/pets", "text/plain", validPetJSON, 415},
		{"body size limit", "POST", "/pets", "application/json", strings.Repeat("x", 513), 413},
		{"invalid path", "GET", "/pets/not-an-integer", "", "", 400},
		{"path constraint", "GET", "/pets/0", "", "", 400},
		{"invalid query", "GET", "/pets?limit=abc", "", "", 400},
		{"query constraint", "GET", "/pets?limit=0", "", "", 400},
		{"invalid boolean", "GET", "/pets/names/Milo?active=maybe", "", "", 400},
		{"null collection element", "POST", "/pets/labels", "application/json", `["cat",null]`, 400},
	}
	for _, transport := range testsupport.Transports {
		t.Run(transport.Name, func(t *testing.T) {
			host, api := testsupport.StartServer(t, transport)
			for _, test := range cases {
				t.Run(test.name, func(t *testing.T) {
					response, body := testsupport.SendRequest(t, host, test.method, test.path, test.contentType, test.body)
					testsupport.AssertProblem(t, response, body, test.status)
				})
			}
			page, err := api.PetsList(t.Context(), client.PetsListRequest{})
			if err != nil || page == nil || page.Total != 0 || len(page.Items) != 0 {
				t.Fatalf("invalid requests reached the service: %+v, %v", page, err)
			}
		})
	}
}

func TestServerJSONWireFormat(t *testing.T) {
	for _, transport := range testsupport.Transports {
		t.Run(transport.Name, func(t *testing.T) {
			host, _ := testsupport.StartServer(t, transport)
			response, body := testsupport.SendRequest(t, host, "POST", "/pets", "application/json", validPetJSON)
			if response.StatusCode != http.StatusCreated || response.Header.Get("Content-Type") != "application/json" {
				t.Fatalf("create: HTTP %d %s", response.StatusCode, body)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(body, &fields); err != nil {
				t.Fatal(err)
			}
			for name, expected := range map[string]string{"species": `"parrot"`, "born_at": `"2026-01-02T03:04:05Z"`, "note": "null"} {
				if string(fields[name]) != expected {
					t.Errorf("%s: expected %s, got %s", name, expected, fields[name])
				}
			}
			if _, exists := fields["price"]; exists {
				t.Errorf("optional default should be omitted: %s", body)
			}
			response, body = testsupport.SendRequest(t, host, "DELETE", "/pets/1", "", "")
			if response.StatusCode != http.StatusNoContent || len(body) != 0 {
				t.Fatalf("delete: expected empty 204, got %d %s", response.StatusCode, body)
			}
		})
	}
}

func TestServiceFailure(t *testing.T) {
	for _, transport := range testsupport.Transports {
		t.Run(transport.Name, func(t *testing.T) {
			_, api := testsupport.StartServer(t, transport)
			_, err := api.PetsFail(t.Context(), client.PetsFailRequest{})
			raw := testsupport.AssertHTTPError(t, err, http.StatusInternalServerError)
			if strings.Contains(string(raw.Body), "private database failure") {
				t.Fatalf("service error exposed private details: %s", raw.Body)
			}
			var problem struct {
				Status int `json:"status"`
			}
			if err := json.Unmarshal(raw.Body, &problem); err != nil || problem.Status != 500 {
				t.Fatalf("service error lost problem body: %s, %v", raw.Body, err)
			}
		})
	}
}
