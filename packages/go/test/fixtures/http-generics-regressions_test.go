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

	client "example.com/regressions/client"
	models "example.com/regressions/models"
	server "example.com/regressions/server"
)

type genericService struct{}

func (genericService) SRequired(context.Context, server.SRequiredRequest) error       { return nil }
func (genericService) SNullable(context.Context, server.SNullableRequest) error       { return nil }
func (genericService) SIntegerBody(context.Context, server.SIntegerBodyRequest) error { return nil }
func (genericService) SResponse(context.Context, server.SResponseRequest) (*models.Box[*models.Node], error) {
	return &models.Box[*models.Node]{Value: &models.Node{Id: 1}}, nil
}
func (genericService) SNullableResponse(context.Context, server.SNullableResponseRequest) (*models.Box[*models.Node], error) {
	return &models.Box[*models.Node]{}, nil
}

func TestGenericRequests(t *testing.T) {
	router := server.NewHandler(genericService{})
	for _, test := range []struct {
		path, body string
		status     int
	}{
		{"/required", `{"value":null}`, 400},
		{"/required", `{"value":{"id":1}}`, 204},
		{"/nullable", `{"value":null}`, 204},
		{"/integer", `{"value":1.5}`, 400},
		{"/integer", `{"value":123456789012345678901234567890}`, 204},
	} {
		request := httptest.NewRequest("POST", test.path, strings.NewReader(test.body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Errorf("%s %s: status %d", test.path, test.body, response.Code)
		}
	}
	host := httptest.NewServer(router)
	defer host.Close()
	api := client.NewClient(host.URL)
	var validation *models.ValidationError
	input := &models.Box[*models.Node]{}
	if err := api.SRequired(context.Background(), client.SRequiredRequest{Body: input}); !errors.As(err, &validation) {
		t.Fatalf("client accepted nonnullable nil: %v", err)
	}
	if err := api.SNullable(context.Background(), client.SNullableRequest{Body: input}); err != nil {
		t.Fatalf("client rejected nullable nil: %v", err)
	}
	number := &models.Box[json.Number]{Value: json.Number("1.5")}
	if err := api.SIntegerBody(context.Background(), client.SIntegerBodyRequest{Body: number}); !errors.As(err, &validation) {
		t.Fatalf("client accepted fractional integer: %v", err)
	}
}

func TestGenericResponses(t *testing.T) {
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"value":null}`)
	}))
	defer host.Close()
	api := client.NewClient(host.URL)
	var validation *models.ValidationError
	if _, err := api.SResponse(context.Background(), client.SResponseRequest{}); !errors.As(err, &validation) {
		t.Fatalf("client accepted nonnullable response: %v", err)
	}
	if result, err := api.SNullableResponse(context.Background(), client.SNullableResponseRequest{}); err != nil || result.Value != nil {
		t.Fatalf("client rejected nullable response: %+v %v", result, err)
	}
}
