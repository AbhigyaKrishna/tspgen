package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	// GIN_IMPORT

	client "example.com/params/client"
	models "example.com/params/models"
	server "example.com/params/server"
)

type service struct{}

func (service) SRead(_ context.Context, request server.SReadRequest) (*models.Holder, error) {
	return &models.Holder{Ref: request.PathId, Mode: request.QueryMode, Strict: request.QueryStrict, Color: request.HeaderColor}, nil
}

func (service) SPick(_ context.Context, request server.SPickRequest) (*models.Picked, error) {
	return &models.Picked{Level: request.PathLevel, Color: request.PathColor, Ref: request.PathRef}, nil
}

func ptr[T any](value T) *T { return &value }

func TestUnionParameters(t *testing.T) {
	// ROUTER
	server.RegisterRoutes(router, service{})
	host := httptest.NewServer(router)
	defer host.Close()
	api := client.NewClient(host.URL)
	green := models.ColorGreen
	result, err := api.SRead(context.Background(), client.SReadRequest{
		PathId:      models.NewRefId(ptr(int32(7))),
		QueryMode:   models.NewModeRatio(ptr(1.5)),
		QueryStrict: models.NewStrictAuto(ptr("auto")),
		HeaderColor: &green,
	})
	if err != nil || result.Ref.Id == nil || *result.Ref.Id != 7 || result.Mode.Ratio == nil || *result.Mode.Ratio != 1.5 ||
		result.Strict == nil || result.Strict.Auto == nil || result.Color == nil || *result.Color != models.ColorGreen {
		t.Fatalf("round trip: %+v %v", result, err)
	}
	for path, status := range map[string]int{
		"/items/latest?mode=auto":        http.StatusOK,
		"/items/7?mode=verde":            http.StatusOK,
		"/items/x?mode=auto":             http.StatusBadRequest,
		"/items/7?mode=auto&strict=many": http.StatusBadRequest,
		"/items/7":                       http.StatusBadRequest,
		"/items/7?mode=auto&level=2":     http.StatusOK,
		"/items/7?mode=auto&level=3":     http.StatusBadRequest,
		"/items/7?mode=auto&level=+2":    http.StatusBadRequest,
		"/picks/2/verde/latest":          http.StatusOK,
		"/picks/2/verde/7":               http.StatusOK,
		"/picks/02/verde/7":              http.StatusBadRequest,
		"/picks/2/purple/7":              http.StatusBadRequest,
		"/picks/2/verde/x":               http.StatusBadRequest,
	} {
		response, err := http.Get(host.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != status {
			t.Fatalf("%s: status %d, want %d", path, response.StatusCode, status)
		}
	}
	picked, err := api.SPick(context.Background(), client.SPickRequest{
		PathLevel: models.LevelHigh, PathColor: models.ColorGreen, PathRef: models.NewRefLatest(ptr("latest")),
	})
	if err != nil || picked.Level != models.LevelHigh || picked.Color != models.ColorGreen || picked.Ref.Latest == nil {
		t.Fatalf("path round trip: %+v %v", picked, err)
	}
	for header, status := range map[string]int{"verde": http.StatusOK, "purple": http.StatusBadRequest} {
		request, _ := http.NewRequest(http.MethodGet, host.URL+"/items/7?mode=auto", nil)
		request.Header.Set("x-color", header)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != status {
			t.Fatalf("x-color %s: status %d, want %d", header, response.StatusCode, status)
		}
	}
}
