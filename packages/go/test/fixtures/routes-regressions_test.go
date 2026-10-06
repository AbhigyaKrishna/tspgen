package server

import (
	"context"
	"net/http/httptest"
	"testing"
)

type routeService struct{ called string }

func (s *routeService) SRoot(context.Context, SRootRequest) error { s.called = "root"; return nil }
func (s *routeService) STrailing(context.Context, STrailingRequest) error {
	s.called = "trailing"
	return nil
}
func (s *routeService) SRead(_ context.Context, request SReadRequest) error {
	s.called = "read:" + request.PathId
	return nil
}
func (s *routeService) SLatest(context.Context, SLatestRequest) error {
	s.called = "latest"
	return nil
}
func (s *routeService) SWrite(context.Context, SWriteRequest) error { s.called = "write"; return nil }
func (s *routeService) SHead(context.Context, SHeadRequest) error   { s.called = "head"; return nil }
func (s *routeService) SSeparate(context.Context, SSeparateRequest) error {
	s.called = "separate"
	return nil
}

func TestExactRoutes(t *testing.T) {
	service := &routeService{}
	router := NewHandler(service)
	for _, test := range []struct {
		method, path, called string
		status               int
	}{
		{"GET", "/", "root", 204},
		{"GET", "/not-declared", "", 404},
		{"GET", "/things/", "trailing", 204},
		{"GET", "/things/id", "read:id", 204},
		{"GET", "/things/latest", "latest", 204},
		{"GET", "/things/id/details", "", 404},
		{"GET", "/things/a%2Fb", "read:a/b", 204},
		{"POST", "/things/id", "write", 204},
		{"GET", "/separate/id", "separate", 204},
		{"HEAD", "/separate/id", "head", 204},
	} {
		service.called = ""
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != test.status || service.called != test.called {
			t.Errorf("%s %s: status=%d called=%q", test.method, test.path, response.Code, service.called)
		}
	}
}
