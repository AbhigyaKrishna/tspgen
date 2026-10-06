package server_test

import (
 "context"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"
 "time"
 // GIN_IMPORT
 client "example.com/config/client"
 models "example.com/config/models"
 server "example.com/config/server"
)

type service struct{}
func animal() *models.Animal { return &models.Animal{ID: 1, Name: "ok", Created: time.Date(2026,1,1,0,0,0,0,time.UTC)} }
func (service) PetsEcho(ctx context.Context, call *CALL_TYPE, body *models.Animal) (*models.Animal, error) {
 if body.Name == "missing" { return nil, fmt.Errorf("wrapped: %w", &server.PetsEcho404Error{Body: &models.Missing{Message: "gone"}}) }
 if body.Name == "broken" { return nil, errors.New("private failure") }
 if body.Name == "access" && CALL_CHECK != "yes" { return nil, errors.New("call access missing") }
 return body, nil
}
func (service) PetsPage(_ context.Context, _ *CALL_TYPE) (*models.Page[*models.Animal], error) {
 return &models.Page[*models.Animal]{Items: []*models.Animal{animal()}}, nil
}
func (service) PetsAt(_ context.Context, _ *CALL_TYPE, date time.Time) (*models.Animal, error) { value := animal(); value.Created = date; return value, nil }

func TestConfiguredRoundTrip(t *testing.T) {
 // ROUTER
 server.RegisterRoutes(router, service{})
 host := httptest.NewServer(router)
 defer host.Close()
 api := client.NewGateway(host.URL)
 value, err := api.PetsEcho(context.Background(), client.PetsEchoInput{Body: animal()})
 if err != nil || value.ID != 1 || value.Price == nil || *value.Price != "1.25" { t.Fatalf("echo: %+v %v", value, err) }
 page, err := api.PetsPage(context.Background(), client.PetsPageInput{})
 if err != nil || len(page.Items) != 1 || page.Items[0].ID != 1 { t.Fatalf("generic models: %+v %v", page, err) }
 date := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)
 value, err = api.PetsAt(context.Background(), client.PetsAtInput{QueryDate: date})
 if err != nil || !value.Created.Equal(date) { t.Fatalf("date mapping: %+v %v", value, err) }
 input := animal(); input.Name = "missing"
 _, err = api.PetsEcho(context.Background(), client.PetsEchoInput{Body: input})
 var typed *client.PetsEcho404Error
 var raw *client.HTTPError
 if !errors.As(err, &typed) || typed.Body.Message != "gone" || !errors.As(err, &raw) || raw.StatusCode != 404 { t.Fatalf("typed error: %v", err) }
 input.ID = 0
 _, err = api.PetsEcho(context.Background(), client.PetsEchoInput{Body: input})
 var validation *models.ValidationError
 if !errors.As(err, &validation) { t.Fatalf("client validation: %v", err) }
 req, _ := http.NewRequest("GET", host.URL + "/page", nil)
 generic, err := api.Do[models.Page[*models.Animal]](req, 200, true)
 if err != nil || len(generic.Items) != 1 { t.Fatalf("generic method: %+v %v", generic, err) }
}

func TestServerPolicy(t *testing.T) {
 // ROUTER
 server.RegisterRoutes(router, service{})
 for _, test := range []struct { body string; status int }{
  {`{"id":1,"name":"ok","created":"2026-01-01T00:00:00Z","note":null}`, 200},
  {`{"id":1,"name":"ok","created":"2026-01-01T00:00:00Z","note":null,"extra":1}`, 400},
  {`{"id":1,"name":"x","created":"2026-01-01T00:00:00Z","note":null}`, 400},
  {`{"id":1,"name":"broken","created":"2026-01-01T00:00:00Z","note":null}`, 500},
  {`{"id":1,"name":"access","created":"2026-01-01T00:00:00Z","note":null}`, 200},
  {strings.Repeat("x", 513), 413},
 } {
  req := httptest.NewRequest("POST", "/echo", strings.NewReader(test.body)); req.Header.Set("Content-Type", "application/json"); req.Header.Set("x-test", "yes")
  response := httptest.NewRecorder(); router.ServeHTTP(response, req)
  if response.Code != test.status { t.Fatalf("%s => %d: %s", test.body, response.Code, response.Body.String()) }
  if test.status >= 400 {
   if response.Header().Get("Content-Type") != "application/problem+json" { t.Fatal("problem content type") }
   var problem map[string]any
   if err := json.Unmarshal(response.Body.Bytes(), &problem); err != nil || int(problem["status"].(float64)) != test.status || strings.Contains(response.Body.String(), "private failure") { t.Fatalf("problem: %s %v", response.Body.String(), err) }
  }
 }
}

func TestClientRuntimeSettings(t *testing.T) {
 host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
  switch r.URL.Path {
  case "/large": _, _ = io.WriteString(w, strings.Repeat("x", 513))
  case "/unknown": _, _ = io.WriteString(w, `{"items":[],"extra":1}`)
  case "/slow": time.Sleep(200 * time.Millisecond); _, _ = io.WriteString(w, `{}`)
  }
 }))
 defer host.Close()
 api := client.NewGateway(host.URL)
 for _, path := range []string{"large", "unknown", "slow"} {
  req, _ := http.NewRequest("GET", host.URL + "/" + path, nil)
  if _, err := api.Do[models.Page[*models.Animal]](req, 200, true); err == nil { t.Errorf("accepted %s", path) }
 }
 api.HTTPClient = &http.Client{Timeout: time.Second}
 req, _ := http.NewRequest("GET", host.URL + "/slow", nil)
 if _, err := api.Do[map[string]any](req, 200, true); err != nil { t.Fatalf("custom HTTPClient: %v", err) }
}
