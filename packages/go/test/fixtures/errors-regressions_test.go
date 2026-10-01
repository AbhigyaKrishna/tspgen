package client

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestErrorPrecedence(t *testing.T) {
	for _, status := range []int{404, 409, 500} {
		host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			fmt.Fprint(w, `{"message":"gone","broad":"conflict","reason":"broken"}`)
		}))
		api := NewClient(host.URL)
		_, err := api.SRead(context.Background(), SReadRequest{})
		host.Close()
		var raw *HTTPError
		if !errors.As(err, &raw) || raw.StatusCode != status {
			t.Fatalf("lost raw error: %v", err)
		}
		var missing *SRead404Error
		var broad *SRead400To499Error
		var fallback *SReadDefaultError
		if (status == 404 && (!errors.As(err, &missing) || missing.Body.Message != "gone")) ||
			(status == 409 && (!errors.As(err, &broad) || broad.Body.Broad != "conflict")) ||
			(status == 500 && (!errors.As(err, &fallback) || fallback.Body.Reason != "broken")) {
			t.Errorf("HTTP %d: unexpected error %T: %v", status, err, err)
		}
	}
}
