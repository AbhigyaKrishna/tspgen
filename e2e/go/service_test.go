package petstore_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	client "example.com/petstore/client"
	ginserver "example.com/petstore/gin"
	models "example.com/petstore/models/v2"
	nethttpserver "example.com/petstore/nethttp"
)

type petService struct {
	mu          sync.Mutex
	pets        map[int64]*models.Pet
	readError   func() error
	removeError func() error
}

var (
	_ nethttpserver.Service = (*petService)(nil)
	_ ginserver.Service     = (*petService)(nil)
)

func (s *petService) PetsCreate(_ context.Context, pet *models.Pet) (*models.Pet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pets[pet.ID] = pet
	return pet, nil
}

func (s *petService) PetsRead(_ context.Context, id int64) (*models.Pet, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pet, exists := s.pets[id]
	if !exists {
		return nil, fmt.Errorf("read pet: %w", s.readError())
	}
	return pet, nil
}

func (s *petService) PetsRemove(_ context.Context, id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.pets[id]; !exists {
		return fmt.Errorf("remove pet: %w", s.removeError())
	}
	delete(s.pets, id)
	return nil
}

func (s *petService) PetsList(_ context.Context, limit *int32) (*models.Page[*models.Pet], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := make([]*models.Pet, 0, len(s.pets))
	for _, pet := range s.pets {
		items = append(items, pet)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	total := int32(len(items))
	if limit != nil && *limit < total {
		items = items[:*limit]
	}
	return &models.Page[*models.Pet]{Items: items, Total: total}, nil
}

func (*petService) PetsLookup(_ context.Context, name string, active *bool, trace *string) (*models.Binding, error) {
	return &models.Binding{Name: name, Active: active, Trace: trace}, nil
}

func (*petService) PetsLabels(_ context.Context, labels []string) ([]string, error) {
	return labels, nil
}

func (*petService) PetsFail(context.Context) (*models.Pet, error) {
	return nil, errors.New("private database failure")
}

type serverTransport struct {
	name        string
	handler     func(*petService) http.Handler
	readError   func() error
	removeError func() error
}

var transports = []serverTransport{
	{
		name:    "nethttp",
		handler: func(service *petService) http.Handler { return nethttpserver.NewHandler(service) },
		readError: func() error {
			return &nethttpserver.PetsRead404Error{Body: &models.NotFound{Message: "pet not found"}}
		},
		removeError: func() error {
			return &nethttpserver.PetsRemove404Error{Body: &models.NotFound{Message: "pet not found"}}
		},
	},
	{
		name:    "gin",
		handler: func(service *petService) http.Handler { return ginserver.NewHandler(service) },
		readError: func() error {
			return &ginserver.PetsRead404Error{Body: &models.NotFound{Message: "pet not found"}}
		},
		removeError: func() error {
			return &ginserver.PetsRemove404Error{Body: &models.NotFound{Message: "pet not found"}}
		},
	},
}

func startServer(t *testing.T, transport serverTransport) (*httptest.Server, *client.Client) {
	t.Helper()
	service := &petService{
		pets: make(map[int64]*models.Pet), readError: transport.readError, removeError: transport.removeError,
	}
	host := httptest.NewServer(transport.handler(service))
	t.Cleanup(host.Close)
	api := client.NewClient(host.URL)
	api.HTTPClient = host.Client()
	api.HTTPClient.Timeout = 5 * time.Second
	return host, api
}

func samplePet(id int64) *models.Pet {
	return &models.Pet{
		ID: id, Name: "Milo", Species: models.SpeciesBird,
		BornAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	}
}

func (*petService) ToysEcho(_ context.Context, toy *models.Toy) (*models.Toy, error) {
	return toy, nil
}
