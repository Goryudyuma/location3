package server

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"testing"
)

func TestParseFilterYear(t *testing.T) {
	tests := []struct {
		value string
		year  int
		valid bool
	}{
		{"", 0, true}, {"  ", 0, true}, {" 2024-02-29 ", 2024, true},
		{"2000-02-29", 2000, true}, {"0001-01-01", 1, true}, {"9999-12-31", 9999, true},
		{"0000-01-01", 0, false}, {"1900-02-29", 0, false}, {"2023-02-29", 0, false},
		{"2024-02-30", 0, false}, {"2024-04-31", 0, false}, {"2024-13-01", 0, false},
		{"2024-01-00", 0, false}, {"2024-1-01", 0, false}, {"2024-01-1", 0, false},
		{"2024", 0, false}, {"2024-01-01T00:00:00Z", 0, false}, {"not a date", 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			year, err := parseFilterYear(tt.value)
			if (err == nil) != tt.valid || year != tt.year {
				t.Fatalf("parseFilterYear(%q) = (%d, %v), want (%d, valid=%v)", tt.value, year, err, tt.year, tt.valid)
			}
		})
	}
}

func TestParseYearField(t *testing.T) {
	tests := []struct {
		name  string
		value any
		year  int
		valid bool
	}{
		{"string", " 1950 ", 1950, true}, {"number", float64(1950), 1950, true},
		{"json number", json.Number("1950"), 1950, true}, {"signed string", "+1950", 1950, true},
		{"unknown 999", "999", 0, false}, {"unknown 9999", float64(9999), 0, false},
		{"sentinel range", "9000", 0, false}, {"empty", "", 0, false}, {"nil", nil, 0, false},
		{"zero", "0", 0, false}, {"negative", float64(-1), 0, false},
		{"partial number", "1950year", 0, false}, {"decimal string", "1950.5", 0, false},
		{"decimal number", float64(1950.5), 0, false}, {"NaN", math.NaN(), 0, false},
		{"infinity", math.Inf(1), 0, false}, {"overflow", "9999999999999999999999999", 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			year, valid := parseYearField(tt.value)
			if year != tt.year || valid != tt.valid {
				t.Fatalf("parseYearField(%v) = (%d, %v), want (%d, %v)", tt.value, year, valid, tt.year, tt.valid)
			}
		})
	}
}

func TestDatasetHandler_YearFiltering(t *testing.T) {
	handler, err := NewHandler(Config{UTF8Dir: "testdata", StaticDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		path string
		ids  []string
	}{
		{"/api/railroads", []string{"historic", "modern", "boundary", "unknown", "malformed"}},
		{"/api/railroads?date=1899-12-31", []string{"unknown", "malformed"}},
		{"/api/railroads?date=1900-01-01", []string{"historic", "unknown", "malformed"}},
		{"/api/railroads?date=1950-01-01", []string{"historic", "boundary", "unknown", "malformed"}},
		{"/api/railroads?date=1950-12-31", []string{"historic", "boundary", "unknown", "malformed"}},
		{"/api/railroads?date=1951-01-01", []string{"modern", "unknown", "malformed"}},
		{"/api/stations", []string{"old-station", "modern-station", "boundary-station", "orphan-station", "nameless-station", "closed-station"}},
		{"/api/stations?date=1899-01-01", []string{}},
		{"/api/stations?date=1950-01-01", []string{"old-station", "boundary-station"}},
		{"/api/stations?date=1951-01-01", []string{"modern-station"}},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tt.path, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
			}
			var body struct {
				Type     string           `json:"type"`
				Name     string           `json:"name"`
				Features []map[string]any `json:"features"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			ids := make([]string, 0, len(body.Features))
			for _, f := range body.Features {
				ids = append(ids, f["id"].(string))
				if f["id"] == "historic" && f["sourceNote"] != "preserve foreign members" {
					t.Fatal("foreign feature member was lost")
				}
			}
			if !reflect.DeepEqual(ids, tt.ids) {
				t.Fatalf("features = %v, want %v", ids, tt.ids)
			}
			if body.Name == "" || body.Type != "FeatureCollection" || body.Features == nil {
				t.Fatal("collection metadata or empty features array was lost")
			}
			if rec.Header().Get("X-Feature-Count") != strconv.Itoa(len(tt.ids)) {
				t.Fatal("feature count header does not match response")
			}
			head := httptest.NewRecorder()
			handler.ServeHTTP(head, httptest.NewRequest(http.MethodHead, tt.path, nil))
			if head.Code != rec.Code || head.Body.Len() != 0 || !reflect.DeepEqual(head.Header(), rec.Header()) {
				t.Fatal("HEAD must return GET headers without a response body")
			}
		})
	}
}

func TestDatasetHandler_InvalidRequest(t *testing.T) {
	handler, err := NewHandler(Config{UTF8Dir: "testdata", StaticDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/railroads?date=2023-02-29", "/api/stations?date=0000-01-01", "/api/railroads?date=2024"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", path, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/railroads", nil))
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != "GET, HEAD" {
		t.Fatal("POST must return 405 with allowed methods")
	}
}
