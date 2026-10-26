package testsupport

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	client "example.com/petstore/client"
)

func SendRequest(t *testing.T, host *httptest.Server, method, path, contentType, body string) (*http.Response, []byte) {
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

func AssertProblem(t *testing.T, response *http.Response, body []byte, status int) {
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
func AssertHTTPError(t *testing.T, err error, status int) *client.HTTPError {
	t.Helper()
	var raw *client.HTTPError
	if !errors.As(err, &raw) || raw.StatusCode != status {
		t.Fatalf("expected HTTP %d in error chain, got %v", status, err)
	}
	return raw
}
