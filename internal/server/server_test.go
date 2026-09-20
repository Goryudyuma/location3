package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
	"time"
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

func TestDatasetHandler_ConditionalRequests(t *testing.T) {
	handler, err := NewHandler(Config{UTF8Dir: "testdata", StaticDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/railroads", "/api/stations", "/api/railroads?date=1950-01-01",
		"/api/stations?date=1950-01-01", "/api/stations?date=1899-01-01",
	} {
		t.Run(path, func(t *testing.T) {
			original := httptest.NewRecorder()
			handler.ServeHTTP(original, httptest.NewRequest(http.MethodGet, path, nil))
			etag := original.Header().Get("ETag")
			if expected := fmt.Sprintf(`"%x"`, sha256.Sum256(original.Body.Bytes())); etag != expected {
				t.Fatalf("ETag = %q, want actual response SHA-256 %q", etag, expected)
			}
			tests := []struct {
				name   string
				values []string
				status int
			}{
				{"strong", []string{etag}, http.StatusNotModified},
				{"weak", []string{"W/" + etag}, http.StatusNotModified},
				{"list", []string{`"different", W/` + etag + `, "another"`}, http.StatusNotModified},
				{"multiple headers", []string{`"different"`, "W/" + etag}, http.StatusNotModified},
				{"comma in opaque tag", []string{`"other,tag", ` + etag}, http.StatusNotModified},
				{"optional whitespace", []string{" \tW/" + etag + " \t"}, http.StatusNotModified},
				{"wildcard", []string{"*"}, http.StatusNotModified},
				{"nonmatching", []string{`"different"`}, http.StatusOK},
				{"invalid unquoted", []string{etag[1 : len(etag)-1]}, http.StatusOK},
				{"invalid suffix", []string{etag + "suffix"}, http.StatusOK},
				{"invalid weak prefix", []string{"w/" + etag}, http.StatusOK},
				{"invalid wildcard list", []string{"*, " + etag}, http.StatusOK},
				{"invalid quoted contents", []string{`"invalid space", ` + etag}, http.StatusOK},
				{"unterminated tag", []string{`"unterminated, ` + etag}, http.StatusOK},
				{"no validator", nil, http.StatusOK},
			}
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				for _, tt := range tests {
					t.Run(method+"/"+tt.name, func(t *testing.T) {
						request := httptest.NewRequest(method, path, nil)
						for _, value := range tt.values {
							request.Header.Add("If-None-Match", value)
						}
						// A future IMS must not turn a nonmatching ETag into 304.
						request.Header.Set("If-Modified-Since", "Fri, 31 Dec 9999 23:59:59 GMT")
						rec := httptest.NewRecorder()
						handler.ServeHTTP(rec, request)
						if rec.Code != tt.status {
							t.Fatalf("status = %d, want %d", rec.Code, tt.status)
						}
						for _, key := range []string{"ETag", "Cache-Control", "X-Feature-Count", "X-Filter-Year"} {
							if rec.Header().Get(key) != original.Header().Get(key) {
								t.Errorf("%s changed on conditional response", key)
							}
						}
						if tt.status == http.StatusNotModified || method == http.MethodHead {
							if rec.Body.Len() != 0 {
								t.Fatal("304 and HEAD responses must not contain a body")
							}
						} else if !bytes.Equal(rec.Body.Bytes(), original.Body.Bytes()) {
							t.Fatal("nonmatching conditional GET must return the complete original body")
						}
					})
				}
			}
		})
	}
}

func TestDatasetHandler_ValidatorsDoNotBypassInputValidation(t *testing.T) {
	handler, err := NewHandler(Config{UTF8Dir: "testdata", StaticDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		request := httptest.NewRequest(method, "/api/railroads?date=2024-02-30", nil)
		request.Header.Set("If-None-Match", "*")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, request)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s invalid date with wildcard: status = %d, want 400", method, rec.Code)
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/api/railroads", nil)
	request.Header.Set("If-None-Match", "*")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, request)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatal("wildcard must not bypass method validation")
	}
}

func TestDatasetHandler_ETagTracksDatasetSnapshotAndRailwayDependencies(t *testing.T) {
	directory := t.TempDir()
	for _, name := range []string{"N05-24_RailroadSection2.geojson", "N05-24_Station2.geojson"} {
		data, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	cfg := Config{UTF8Dir: directory, StaticDir: t.TempDir()}
	original, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}
	get := func(handler http.Handler, path, etag string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		if etag != "" {
			request.Header.Set("If-None-Match", etag)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, request)
		return rec
	}
	railPath := "/api/railroads?date=1950-01-01"
	stationPath := "/api/stations?date=1950-01-01"
	rail := get(original, railPath, "")
	railAll := get(original, "/api/railroads", "")
	station := get(original, stationPath, "")
	stationAll := get(original, "/api/stations", "")
	if get(original, "/api/railroads?date=1950-12-31", "").Header().Get("ETag") != rail.Header().Get("ETag") {
		t.Fatal("identical year-filtered bytes must have the same ETag")
	}
	if get(original, "/api/railroads?date=1951-01-01", "").Header().Get("ETag") == rail.Header().Get("ETag") {
		t.Fatal("different year-filtered bytes must have different ETags")
	}

	file := filepath.Join(directory, "N05-24_RailroadSection2.geojson")
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	// Only change a railway's closing year; the station source is unchanged.
	changed := bytes.Replace(data, []byte(`"N05_005e": "1950"`), []byte(`"N05_005e": "1949"`), 1)
	if bytes.Equal(data, changed) {
		t.Fatal("fixture did not contain the railway year to update")
	}
	if err := os.WriteFile(file, changed, 0600); err != nil {
		t.Fatal(err)
	}
	updated, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for path, previous := range map[string]*httptest.ResponseRecorder{
		railPath: rail, "/api/railroads": railAll, stationPath: station,
	} {
		etag := previous.Header().Get("ETag")
		if rec := get(original, path, etag); rec.Code != http.StatusNotModified {
			t.Errorf("%s: running handler must retain its loaded snapshot", path)
		}
		rec := get(updated, path, etag)
		if rec.Code != http.StatusOK || rec.Header().Get("ETag") == etag || bytes.Equal(rec.Body.Bytes(), previous.Body.Bytes()) {
			t.Errorf("%s: reloaded railway change must invalidate the previous response ETag", path)
		}
	}
	if rec := get(updated, "/api/stations", stationAll.Header().Get("ETag")); rec.Code != http.StatusNotModified {
		t.Fatal("unchanged full station data must retain its ETag")
	}
}

func TestNewHandler_StaticIfModifiedSince(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "asset.txt")
	if err := os.WriteFile(file, []byte("static fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	modified := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(file, modified, modified); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(Config{UTF8Dir: "testdata", StaticDir: directory})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/asset.txt", nil)
	request.Header.Set("If-Modified-Since", modified.UTC().Format(http.TimeFormat))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, request)
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Fatal("static FileServer must keep its If-Modified-Since behavior")
	}
}
