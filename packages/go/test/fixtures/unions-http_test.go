package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	client "example.com/unions/client"
	models "example.com/unions/models"
	server "example.com/unions/server"
)

type service struct{}

func (service) SEcho(_ context.Context, request server.SEchoRequest) (*models.Pet, error) {
	return request.Body, nil
}

func TestUnionBodies(t *testing.T) {
	host := httptest.NewServer(server.NewHandler(service{}))
	defer host.Close()
	api := client.NewClient(host.URL)
	result, err := api.SEcho(context.Background(), client.SEchoRequest{Body: models.NewPetCat(&models.Cat{Name: "Tom"})})
	if err != nil || result.Cat == nil || result.Cat.Name != "Tom" || result.Cat.Lives == nil || *result.Cat.Lives != 9 {
		t.Fatalf("round trip: %+v %v", result, err)
	}
	for _, body := range []string{
		`{"kind":"cat","name":"Tom","extra":1}`,
		`{"kind":"bird","name":"x"}`,
	} {
		response, err := http.Post(host.URL+"/pets", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: status %d", body, response.StatusCode)
		}
	}
}
