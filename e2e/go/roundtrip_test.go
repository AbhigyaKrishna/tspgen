package petstore_test

import (
	"errors"
	"net/http"
	"reflect"
	"testing"

	client "example.com/petstore/client"
	models "example.com/petstore/models/v2"
)

func TestPetLifecycle(t *testing.T) {
	for _, transport := range transports {
		t.Run(transport.name, func(t *testing.T) {
			_, api := startServer(t, transport)
			input := samplePet(42)
			created, err := api.PetsCreate(t.Context(), client.PetsCreateRequest{Body: input})
			if err != nil {
				t.Fatal(err)
			}
			assertPet(t, created, 42)
			read, err := api.PetsRead(t.Context(), client.PetsReadRequest{PathID: 42})
			if err != nil {
				t.Fatal(err)
			}
			assertPet(t, read, 42)
			if err := api.PetsRemove(t.Context(), client.PetsRemoveRequest{PathID: 42}); err != nil {
				t.Fatal(err)
			}
			_, err = api.PetsRead(t.Context(), client.PetsReadRequest{PathID: 42})
			var missing *client.PetsRead404Error
			if !errors.As(err, &missing) || missing.Body == nil || missing.Body.Message != "pet not found" {
				t.Fatalf("deleted pet: expected typed 404, got %v", err)
			}
			assertHTTPError(t, err, http.StatusNotFound)
			err = api.PetsRemove(t.Context(), client.PetsRemoveRequest{PathID: 42})
			var removed *client.PetsRemove404Error
			if !errors.As(err, &removed) || removed.Body == nil || removed.Body.Message != "pet not found" {
				t.Fatalf("repeated delete: expected typed 404, got %v", err)
			}
		})
	}
}

func assertPet(t *testing.T, pet *models.Pet, id int64) {
	t.Helper()
	if pet == nil || pet.ID != id || pet.Name != "Milo" || pet.Species != models.SpeciesBird {
		t.Fatalf("pet fields lost: %+v", pet)
	}
	if pet.BornAt.Format("2006-01-02T15:04:05Z07:00") != "2026-01-02T03:04:05Z" {
		t.Fatalf("timestamp lost: %v", pet.BornAt)
	}
	if pet.Price == nil || *pet.Price != "1.25" || pet.Note != nil {
		t.Fatalf("defaults or nullability lost: %+v", pet)
	}
}

func assertHTTPError(t *testing.T, err error, status int) *client.HTTPError {
	t.Helper()
	var raw *client.HTTPError
	if !errors.As(err, &raw) || raw.StatusCode != status {
		t.Fatalf("expected HTTP %d in error chain, got %v", status, err)
	}
	return raw
}

func TestGenericPage(t *testing.T) {
	for _, transport := range transports {
		t.Run(transport.name, func(t *testing.T) {
			host, api := startServer(t, transport)
			for _, id := range []int64{2, 1} {
				if _, err := api.PetsCreate(t.Context(), client.PetsCreateRequest{Body: samplePet(id)}); err != nil {
					t.Fatal(err)
				}
			}
			limit := int32(1)
			page, err := api.PetsList(t.Context(), client.PetsListRequest{QueryLimit: &limit})
			if err != nil {
				t.Fatal(err)
			}
			if page == nil || page.Total != 2 || len(page.Items) != 1 {
				t.Fatalf("limited page: %+v", page)
			}
			assertPet(t, page.Items[0], 1)
			request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, host.URL+"/pets", nil)
			if err != nil {
				t.Fatal(err)
			}
			all, err := api.Do[models.Page[*models.Pet]](request, http.StatusOK, true)
			if err != nil {
				t.Fatal(err)
			}
			if all.Total != 2 || len(all.Items) != 2 {
				t.Fatalf("generic Do page: %+v", all)
			}
			assertPet(t, all.Items[1], 2)
		})
	}
}

func TestParameterBinding(t *testing.T) {
	for _, transport := range transports {
		t.Run(transport.name, func(t *testing.T) {
			_, api := startServer(t, transport)
			for _, name := range []string{"a/b", "雪 ?#%", "literal%2Fslash"} {
				t.Run(name, func(t *testing.T) {
					active, trace := false, ""
					binding, err := api.PetsLookup(t.Context(), client.PetsLookupRequest{
						PathName: name, QueryActive: &active, HeaderTrace: &trace,
					})
					if err != nil {
						t.Fatal(err)
					}
					if binding == nil || binding.Name != name || binding.Active == nil || *binding.Active || binding.Trace == nil || *binding.Trace != "" {
						t.Fatalf("escaped path or present zero values lost: %+v", binding)
					}
				})
			}
			binding, err := api.PetsLookup(t.Context(), client.PetsLookupRequest{PathName: "absent"})
			if err != nil {
				t.Fatal(err)
			}
			if binding == nil || binding.Active != nil || binding.Trace != nil {
				t.Fatalf("absent parameters became present: %+v", binding)
			}
			active, trace := true, "trace-123"
			binding, err = api.PetsLookup(t.Context(), client.PetsLookupRequest{
				PathName: "present", QueryActive: &active, HeaderTrace: &trace,
			})
			if err != nil {
				t.Fatal(err)
			}
			if binding == nil || binding.Active == nil || !*binding.Active || binding.Trace == nil || *binding.Trace != "trace-123" {
				t.Fatalf("query or header value lost: %+v", binding)
			}
		})
	}
}

func TestCollectionBody(t *testing.T) {
	for _, transport := range transports {
		t.Run(transport.name, func(t *testing.T) {
			_, api := startServer(t, transport)
			for _, input := range [][]string{{"cat", "雪", ""}, {}} {
				labels, err := api.PetsLabels(t.Context(), client.PetsLabelsRequest{Body: input})
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(labels, input) {
					t.Fatalf("collection body: expected %q, got %q", input, labels)
				}
			}
		})
	}
}
