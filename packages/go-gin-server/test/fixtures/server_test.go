package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	client "example.com/pets/client"
	models "example.com/pets/models/v2"
	server "example.com/pets/server"
	"github.com/gin-gonic/gin"
)

type contextKey struct{}
type service struct{}

func (service) PetsRead(ctx context.Context, request server.PetsReadRequest) (*models.Pet, error) {
	switch request.PathId {
	case 0:
		return nil, fmt.Errorf("wrapped: %w", &server.HTTPError{StatusCode: 404, Body: map[string]string{"message": "not found"}})
	case -1:
		return nil, errors.New("private database credentials")
	case -2:
		return nil, &server.HTTPError{StatusCode: 200, Body: "private error"}
	case -3:
		price := json.Number("invalid")
		return &models.Pet{Price: &price}, nil
	case -4:
		var err *server.HTTPError
		return nil, err
	case -5:
		panic("private panic")
	case 99:
		if ctx.Value(contextKey{}) != "middleware" {
			return nil, errors.New("missing middleware context")
		}
	}
	return &models.Pet{Id: request.PathId}, nil
}

func (service) PetsDetails(_ context.Context, request server.PetsDetailsRequest) (*models.Pet, error) {
	return &models.Pet{Id: request.PathPetId}, nil
}

func (service) PetsLabel(_ context.Context, _ server.PetsLabelRequest) (*models.Pet, error) {
	return &models.Pet{Id: 22}, nil
}

func (service) PetsCreate(_ context.Context, request server.PetsCreateRequest) (*models.Pet, error) {
	return request.Body, nil
}

func (service) PetsOptional(_ context.Context, request server.PetsOptionalRequest) (*models.Pet, error) {
	if request.Body == nil {
		return &models.Pet{Id: 17}, nil
	}
	return request.Body, nil
}

func (service) PetsRemove(_ context.Context, _ server.PetsRemoveRequest) error { return nil }

func (service) PetsLookup(_ context.Context, request server.PetsLookupRequest) (*models.Pet, error) {
	id := int64(0)
	if request.QueryActive != nil && *request.QueryActive {
		id = 1
	}
	if request.HeaderTrace != nil && *request.HeaderTrace == "ok" {
		id += 2
	}
	return &models.Pet{Id: id, Name: &request.PathName}, nil
}

func (service) PetsSearch(_ context.Context, request server.PetsSearchRequest) (*models.Pet, error) {
	name := request.QueryQ + ":" + request.HeaderKey
	var id int64
	if request.QueryCount != nil {
		id = int64(*request.QueryCount)
	}
	return &models.Pet{Id: id, Name: &name}, nil
}

func request(handler http.Handler, method, path, body, contentType string, headers ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	for i := 0; i < len(headers); i += 2 {
		r.Header.Set(headers[i], headers[i+1])
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestRoundTrip(t *testing.T) {
	gin.SetMode(gin.TestMode)
	httpServer := httptest.NewServer(server.NewHandler(service{}))
	defer httpServer.Close()
	api := &client.Client{BaseURL: httpServer.URL}
	pet, err := api.PetsRead(context.Background(), client.PetsReadRequest{PathId: 42})
	if err != nil || pet.Id != 42 {
		t.Fatalf("read: pet=%+v err=%v", pet, err)
	}
	price := json.Number("12345678901234567890.123456789")
	created, err := api.PetsCreate(context.Background(), client.PetsCreateRequest{Body: &models.Pet{Id: 9, Price: &price}})
	if err != nil || created.Id != 9 || created.Price == nil || *created.Price != price {
		t.Fatalf("create: pet=%+v err=%v", created, err)
	}
	active, trace := true, "ok"
	name := "a/b+c%2F ?雪"
	found, err := api.PetsLookup(context.Background(), client.PetsLookupRequest{PathName: name, QueryActive: &active, HeaderTrace: &trace})
	if err != nil || found.Id != 3 || found.Name == nil || *found.Name != name {
		t.Fatalf("lookup: pet=%+v err=%v", found, err)
	}
	detailed, err := api.PetsDetails(context.Background(), client.PetsDetailsRequest{PathPetId: 8})
	if err != nil || detailed.Id != 8 {
		t.Fatalf("shared wildcard: pet=%+v err=%v", detailed, err)
	}
	label, err := api.PetsLabel(context.Background(), client.PetsLabelRequest{})
	if err != nil || label.Id != 22 {
		t.Fatalf("unicode route: label=%+v err=%v", label, err)
	}
	if err := api.PetsRemove(context.Background(), client.PetsRemoveRequest{PathId: 7}); err != nil {
		t.Fatal(err)
	}
	_, err = api.PetsRead(context.Background(), client.PetsReadRequest{PathId: 0})
	if httpErr, ok := err.(*client.HTTPError); !ok || httpErr.StatusCode != 404 {
		t.Fatalf("error: %v", err)
	}
}

func TestBinding(t *testing.T) {
	handler := server.NewHandler(service{})
	tests := []struct {
		name, method, path, body, contentType string
		headers                               []string
		status                                int
	}{
		{"bad path", "GET", "/pets/no", "", "", nil, 400},
		{"null path", "GET", "/pets/null", "", "", nil, 400},
		{"overflow path", "GET", "/pets/9223372036854775808", "", "", nil, 400},
		{"required query", "GET", "/pets/search", "", "", []string{"x-key", "k"}, 400},
		{"required header", "GET", "/pets/search?q=q", "", "", nil, 400},
		{"empty present strings", "GET", "/pets/search?q=", "", "", []string{"x-key", ""}, 200},
		{"string controls", "GET", "/pets/search?q=%01%0A", "", "", []string{"x-key", "k"}, 200},
		{"optional absent", "GET", "/pets/search?q=q", "", "", []string{"x-key", "k"}, 200},
		{"zero", "GET", "/pets/search?q=q&count=0", "", "", []string{"x-key", "k"}, 200},
		{"valid literals", "GET", "/pets/search?q=q&mode=fast&one=1", "", "", []string{"x-key", "k"}, 200},
		{"invalid string literal", "GET", "/pets/search?q=q&mode=slow", "", "", []string{"x-key", "k"}, 400},
		{"invalid number literal", "GET", "/pets/search?q=q&one=2", "", "", []string{"x-key", "k"}, 400},
		{"overflow query", "GET", "/pets/search?q=q&count=128", "", "", []string{"x-key", "k"}, 400},
		{"null query", "GET", "/pets/search?q=q&count=null", "", "", []string{"x-key", "k"}, 400},
		{"bad boolean", "GET", "/pets/names/n?active=yes", "", "", nil, 400},
		{"false", "GET", "/pets/names/n?active=false", "", "", nil, 200},
		{"missing body", "POST", "/pets", "", "", nil, 400},
		{"malformed", "POST", "/pets", "{", "application/json", nil, 400},
		{"trailing document", "POST", "/pets", `{"id":1} {"id":2}`, "application/json", nil, 400},
		{"trailing garbage", "POST", "/pets", `{"id":1} garbage`, "application/json", nil, 400},
		{"null body", "POST", "/pets", "null", "application/json", nil, 400},
		{"optional null", "PATCH", "/pets/optional", "null", "application/json", nil, 400},
		{"wrong media type", "POST", "/pets", `{"id":1}`, "text/plain", nil, 415},
		{"missing media type", "POST", "/pets", `{"id":1}`, "", nil, 415},
		{"json charset", "POST", "/pets", `{"id":1}`, "application/json; charset=utf-8", nil, 201},
		{"json suffix", "POST", "/pets", `{"id":1}`, "application/vnd.pet+json", nil, 201},
		{"oversize", "POST", "/pets", `{"name":"` + strings.Repeat("x", 256) + `"}`, "application/json", nil, 413},
		{"empty optional", "PATCH", "/pets/optional", "", "", nil, 200},
		{"optional body", "PATCH", "/pets/optional", `{"id":1}`, "application/json", nil, 200},
		{"no body response", "DELETE", "/pets/1", "", "", nil, 204},
		{"method mismatch", "PUT", "/pets/1", "", "", nil, 405},
		{"missing route", "GET", "/missing", "", "", nil, 404},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := request(handler, tc.method, tc.path, tc.body, tc.contentType, tc.headers...)
			if w.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.status, w.Body.String())
			}
			if tc.status == 204 && w.Body.Len() != 0 {
				t.Fatalf("204 body: %s", w.Body.String())
			}
		})
	}
}

func TestServiceErrors(t *testing.T) {
	handler := server.NewHandler(service{})
	for _, id := range []string{"-1", "-2", "-3", "-4", "-5"} {
		w := request(handler, "GET", "/pets/"+id, "", "")
		if w.Code != 500 || strings.Contains(w.Body.String(), "private") || strings.Contains(w.Body.String(), "invalid") {
			t.Fatalf("id=%s status=%d body=%s", id, w.Code, w.Body.String())
		}
	}
	w := request(handler, "GET", "/pets/0", "", "")
	if w.Code != 404 || w.Body.String() != `{"message":"not found"}` {
		t.Fatalf("wrapped HTTPError: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestRegisterRoutes(t *testing.T) {
	engine := gin.New()
	engine.UseEscapedPath = true
	var observedErrors int
	engine.Use(func(c *gin.Context) {
		c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), contextKey{}, "middleware"))
		c.Next()
		observedErrors += len(c.Errors)
	})
	server.RegisterRoutes(engine.Group("/v1"), service{})
	w := request(engine, "GET", "/v1/pets/99", "", "")
	if w.Code != 200 {
		t.Fatalf("middleware context: %d %s", w.Code, w.Body.String())
	}
	w = request(engine, "GET", "/v1/pets/names/a%2Fb+c%252F", "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"name":"a/b+c%2F"`) {
		t.Fatalf("group escaped path: %d %s", w.Code, w.Body.String())
	}
	_ = request(engine, "GET", "/v1/pets/-1", "", "")
	if observedErrors != 1 {
		t.Fatalf("middleware errors=%d", observedErrors)
	}
	// A group can introduce a wildcard with the same name as a generated one.
	other := gin.New()
	other.UseEscapedPath = true
	server.RegisterRoutes(other.Group("/v1/:p2"), service{})
	w = request(other, "GET", "/v1/tenant/pets/42", "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"id":42`) {
		t.Fatalf("group wildcard: %d %s", w.Code, w.Body.String())
	}
}
