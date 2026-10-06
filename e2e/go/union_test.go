package petstore_test

import (
	"net/http"
	"testing"

	client "example.com/petstore/client"
	models "example.com/petstore/models/v2"
)

func TestDiscriminatedRoundTrip(t *testing.T) {
	for _, transport := range transports {
		t.Run(transport.name, func(t *testing.T) {
			host, api := startServer(t, transport)
			toy, err := api.ToysEcho(t.Context(), client.ToysEchoRequest{Body: models.NewToyBall(&models.Ball{Label: "red"})})
			if err != nil || toy.Ball == nil || toy.Ball.Label != "red" || toy.Ball.Bounce == nil || *toy.Ball.Bounce != 3 {
				t.Fatalf("ball: %+v %v", toy, err)
			}
			response, body := sendRequest(t, host, http.MethodPost, "/toys", "application/json", `{"kind":"drone","label":"xy"}`)
			assertProblem(t, response, body, http.StatusBadRequest)
			response, body = sendRequest(t, host, http.MethodPost, "/toys", "application/json", `{"kind":"kite","label":"x","length":1}`)
			assertProblem(t, response, body, http.StatusBadRequest)
		})
	}
}

func TestAdditionalPropertiesAndUnionQuery(t *testing.T) {
	for _, transport := range transports {
		t.Run(transport.name, func(t *testing.T) {
			host, api := startServer(t, transport)
			limit := int32(3)
			tags, err := api.TaggingEcho(t.Context(), client.TaggingEchoRequest{
				Body:      &models.Tags{Pet: "rex", AdditionalProperties: map[string]string{"color": "brown"}},
				QuerySort: models.NewSortLimit(&limit),
			})
			if err != nil || tags.Pet != "rex" || tags.AdditionalProperties["color"] != "brown" || tags.AdditionalProperties["sort"] != "3" {
				t.Fatalf("tags: %+v %v", tags, err)
			}
			response, body := sendRequest(t, host, http.MethodPost, "/tags?sort=oldest", "application/json", `{"pet":"rex"}`)
			assertProblem(t, response, body, http.StatusBadRequest)
			response, body = sendRequest(t, host, http.MethodPost, "/tags", "application/json", `{"pet":"rex","color":7}`)
			assertProblem(t, response, body, http.StatusBadRequest)
		})
	}
}
