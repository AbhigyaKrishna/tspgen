package petstore_test

import (
	"testing"

	models "example.com/petstore/models/v2"
	"github.com/go-playground/validator/v10"
)

func TestStructValidator(t *testing.T) {
	validate := validator.New(validator.WithRequiredStructEnabled())
	if err := validate.Struct(samplePet(1)); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		change func(*models.Pet)
	}{
		{"id", func(pet *models.Pet) { pet.ID = 0 }},
		{"name", func(pet *models.Pet) { pet.Name = "x" }},
		{"species", func(pet *models.Pet) { pet.Species = "unknown" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			pet := samplePet(1)
			test.change(pet)
			if err := validate.Struct(&models.Page[*models.Pet]{Items: []*models.Pet{pet}}); err == nil {
				t.Fatal("invalid nested pet accepted")
			}
		})
	}
}
