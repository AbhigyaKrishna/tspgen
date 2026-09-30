package petstore_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	client "example.com/petstore/client"
	models "example.com/petstore/models/v2"
)

func TestClientValidatesRequests(t *testing.T) {
	cases := []struct {
		name string
		call func(context.Context, *client.Client) error
	}{
		{"path constraint", func(ctx context.Context, api *client.Client) error {
			_, err := api.PetsRead(ctx, client.PetsReadRequest{PathID: 0})
			return err
		}},
		{"query constraint", func(ctx context.Context, api *client.Client) error {
			limit := int32(0)
			_, err := api.PetsList(ctx, client.PetsListRequest{QueryLimit: &limit})
			return err
		}},
		{"missing body", func(ctx context.Context, api *client.Client) error {
			_, err := api.PetsCreate(ctx, client.PetsCreateRequest{})
			return err
		}},
		{"model constraint", func(ctx context.Context, api *client.Client) error {
			pet := samplePet(1)
			pet.Name = "x"
			_, err := api.PetsCreate(ctx, client.PetsCreateRequest{Body: pet})
			return err
		}},
		{"enum validation", func(ctx context.Context, api *client.Client) error {
			pet := samplePet(1)
			pet.Species = "dragon"
			_, err := api.PetsCreate(ctx, client.PetsCreateRequest{Body: pet})
			return err
		}},
		{"null collection", func(ctx context.Context, api *client.Client) error {
			_, err := api.PetsLabels(ctx, client.PetsLabelsRequest{})
			return err
		}},
	}
	for _, transport := range transports {
		t.Run(transport.name, func(t *testing.T) {
			_, api := startServer(t, transport)
			for _, test := range cases {
				t.Run(test.name, func(t *testing.T) {
					err := test.call(t.Context(), api)
					var validation *models.ValidationError
					if !errors.As(err, &validation) {
						t.Fatalf("expected client validation error, got %v", err)
					}
				})
			}
		})
	}
}

func TestClientDecodesResponses(t *testing.T) {
	cases := []struct {
		name, body, message string
		status              int
	}{
		{"unknown property", `{"items":[],"total":0,"extra":true}`, `unknown field "extra"`, 200},
		{"missing required property", `{"items":[]}`, "required property is missing", 200},
		{"malformed JSON", `{`, "unexpected EOF", 200},
		{"trailing JSON", `{"items":[],"total":0} {}`, "trailing JSON", 200},
		{"oversized response", strings.Repeat("x", 513), "response body exceeds 512 bytes", 200},
		{"unexpected success status", `{"items":[],"total":0}`, "", 201},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/pets" {
					http.Error(w, "unexpected request", http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			t.Cleanup(host.Close)
			api := client.NewClient(host.URL)
			api.HTTPClient = host.Client()
			_, err := api.PetsList(t.Context(), client.PetsListRequest{})
			if test.status != http.StatusOK {
				assertHTTPError(t, err, test.status)
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("expected %q, got %v", test.message, err)
			}
		})
	}
}

func TestClientCancellation(t *testing.T) {
	for _, transport := range transports {
		t.Run(transport.name, func(t *testing.T) {
			_, api := startServer(t, transport)
			ctx, cancel := context.WithCancel(t.Context())
			cancel()
			_, err := api.PetsList(ctx, client.PetsListRequest{})
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("canceled request: expected context.Canceled, got %v", err)
			}
		})
	}
}
