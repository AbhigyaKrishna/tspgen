package petstore_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	client "example.com/petstore/client"
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
	for _, transport := range transports {
		t.Run(transport.name, func(t *testing.T) {
			host, api := startServer(t, transport)
			for _, test := range cases {
				t.Run(test.name, func(t *testing.T) {
					response, body := sendRequest(t, host, test.method, test.path, test.contentType, test.body)
					assertProblem(t, response, body, test.status)
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
	for _, transport := range transports {
		t.Run(transport.name, func(t *testing.T) {
			host, _ := startServer(t, transport)
			response, body := sendRequest(t, host, "POST", "/pets", "application/json", validPetJSON)
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
			response, body = sendRequest(t, host, "DELETE", "/pets/1", "", "")
			if response.StatusCode != http.StatusNoContent || len(body) != 0 {
				t.Fatalf("delete: expected empty 204, got %d %s", response.StatusCode, body)
			}
		})
	}
}

func TestServiceFailure(t *testing.T) {
	for _, transport := range transports {
		t.Run(transport.name, func(t *testing.T) {
			_, api := startServer(t, transport)
			_, err := api.PetsFail(t.Context(), client.PetsFailRequest{})
			raw := assertHTTPError(t, err, http.StatusInternalServerError)
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

func sendRequest(t *testing.T, host *httptest.Server, method, path, contentType, body string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), method, host.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := host.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, payload
}

func assertProblem(t *testing.T, response *http.Response, body []byte, status int) {
	t.Helper()
	if response.StatusCode != status || response.Header.Get("Content-Type") != "application/problem+json" {
		t.Fatalf("expected problem HTTP %d, got %d %s", status, response.StatusCode, body)
	}
	var problem struct {
		Type   string `json:"type"`
		Status int    `json:"status"`
	}
	if err := json.Unmarshal(body, &problem); err != nil || problem.Status != status || problem.Type != "about:blank" {
		t.Fatalf("invalid problem body: %s, %v", body, err)
	}
}
