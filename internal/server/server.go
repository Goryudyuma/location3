package server

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	startYearKey = "N05_005b"
	endYearKey   = "N05_005e"
	lineNameKey  = "N05_002"
)

// Config holds configuration for the web server.
type Config struct {
	UTF8Dir   string
	StaticDir string
}

// NewHandler constructs an HTTP handler serving the dataset and static assets.
func NewHandler(cfg Config) (http.Handler, error) {
	if cfg.UTF8Dir == "" {
		return nil, errors.New("UTF-8 dataset directory is required")
	}
	if cfg.StaticDir == "" {
		return nil, errors.New("static directory is required")
	}

	railDataset, err := loadDataset(filepath.Join(cfg.UTF8Dir, "N05-24_RailroadSection2.geojson"))
	if err != nil {
		return nil, fmt.Errorf("load railroad GeoJSON: %w", err)
	}

	stationDataset, err := loadDataset(filepath.Join(cfg.UTF8Dir, "N05-24_Station2.geojson"))
	if err != nil {
		return nil, fmt.Errorf("load station GeoJSON: %w", err)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/api/railroads", datasetHandler(railDataset, nil))
	mux.HandleFunc("/api/stations", datasetHandler(stationDataset, func(year int, features []feature) []feature {
		if year == 0 {
			return features
		}

		allowed := activeLineNames(railDataset.filterByYear(year))
		if len(allowed) == 0 {
			return features[:0]
		}

		filtered := make([]feature, 0, len(features))
		for _, f := range features {
			name := propertyString(f.Properties, lineNameKey)
			if name == "" {
				continue
			}
			if _, ok := allowed[name]; ok {
				filtered = append(filtered, f)
			}
		}
		return filtered
	}))

	fileServer := http.FileServer(http.Dir(cfg.StaticDir))
	mux.Handle("/", fileServer)

	return mux, nil
}

type dataset struct {
	original     []byte
	originalETag string
	raw          map[string]json.RawMessage
	features     []feature
}

type feature struct {
	Type       string          `json:"type"`
	ID         any             `json:"id,omitempty"`
	Properties map[string]any  `json:"properties"`
	Geometry   json.RawMessage `json:"geometry"`
	BBox       json.RawMessage `json:"bbox,omitempty"`
	Extras     map[string]any  `json:"-"`
}

func (f *feature) UnmarshalJSON(data []byte) error {
	type alias feature
	aux := struct {
		*alias
		Extras map[string]json.RawMessage `json:"-"`
	}{alias: (*alias)(f)}

	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}

	// Capture any unknown keys to round-trip them later.
	if err := json.Unmarshal(data, &aux.Extras); err != nil {
		return err
	}
	delete(aux.Extras, "type")
	delete(aux.Extras, "id")
	delete(aux.Extras, "properties")
	delete(aux.Extras, "geometry")
	delete(aux.Extras, "bbox")

	if len(aux.Extras) > 0 {
		f.Extras = make(map[string]any, len(aux.Extras))
		for k, raw := range aux.Extras {
			var v any
			if err := json.Unmarshal(raw, &v); err != nil {
				return err
			}
			f.Extras[k] = v
		}
	} else {
		f.Extras = nil
	}

	return nil
}

func (f feature) MarshalJSON() ([]byte, error) {
	base := map[string]any{
		"type":       f.Type,
		"properties": f.Properties,
		"geometry":   json.RawMessage(f.Geometry),
	}
	if f.ID != nil {
		base["id"] = f.ID
	}
	if len(f.BBox) > 0 {
		base["bbox"] = json.RawMessage(f.BBox)
	}
	for k, v := range f.Extras {
		base[k] = v
	}
	return json.Marshal(base)
}

type featureModifier func(year int, features []feature) []feature

func loadDataset(path string) (*dataset, error) {
	rawBytes, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rawBytes, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal GeoJSON root: %w", err)
	}

	featuresRaw, ok := raw["features"]
	if !ok {
		return nil, errors.New("missing features array")
	}

	var features []feature
	if err := json.Unmarshal(featuresRaw, &features); err != nil {
		return nil, fmt.Errorf("unmarshal GeoJSON features: %w", err)
	}

	return &dataset{
		original:     rawBytes,
		originalETag: contentETag(rawBytes),
		raw:          raw,
		features:     features,
	}, nil
}

func datasetHandler(ds *dataset, modifier featureModifier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var (
			body        []byte
			etag        string
			featureSize int
			err         error
		)

		filterYear, parseErr := parseFilterYear(r.URL.Query().Get("date"))
		if parseErr != nil {
			http.Error(w, "invalid date format, use YYYY-MM-DD", http.StatusBadRequest)
			return
		}
		if filterYear == 0 {
			body = ds.original
			etag = ds.originalETag
			featureSize = len(ds.features)
		} else {
			body, featureSize, err = ds.filterAndMarshal(filterYear, modifier)
			if err != nil {
				http.Error(w, "failed to build filtered dataset", http.StatusInternalServerError)
				return
			}
			etag = contentETag(body)

			w.Header().Set("X-Filter-Year", strconv.Itoa(filterYear))
		}

		w.Header().Set("Content-Type", "application/geo+json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		w.Header().Set("X-Feature-Count", strconv.Itoa(featureSize))
		w.Header().Set("ETag", etag)

		if matchesETag(strings.Join(r.Header.Values("If-None-Match"), ","), etag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}

		if r.Method == http.MethodHead {
			return
		}

		// A failed write means the response has already started; a second error
		// response cannot replace it.
		_, _ = w.Write(body)
	}
}

func contentETag(body []byte) string {
	return fmt.Sprintf(`"%x"`, sha256.Sum256(body))
}

// GET and HEAD use weak comparison. Parse quoted tags rather than splitting on
// commas, which may themselves be part of an opaque entity tag.
func matchesETag(value, current string) bool {
	value = strings.TrimSpace(value)
	if value == "*" {
		return true
	}
	matched := false
	for value != "" {
		value = strings.TrimLeft(value, " \t,")
		if value == "" {
			break
		}
		value = strings.TrimPrefix(value, "W/")
		if len(value) < 2 || value[0] != '"' {
			return false
		}
		end := 1
		for end < len(value) && value[end] != '"' {
			if value[end] < 0x21 || value[end] == 0x7f {
				return false
			}
			end++
		}
		if end == len(value) {
			return false
		}
		matched = matched || value[:end+1] == current
		value = strings.TrimLeft(value[end+1:], " \t")
		if value != "" {
			if value[0] != ',' {
				return false
			}
			value = value[1:]
		}
	}
	return matched
}

// A zero return value is reserved for an omitted filter, never a calendar year.
func parseFilterYear(value string) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}
	const layout = "2006-01-02"
	date, err := time.Parse(layout, value)
	if err != nil {
		return 0, err
	}
	if date.Year() < 1 || date.Format(layout) != value {
		return 0, errors.New("invalid calendar date")
	}
	return date.Year(), nil
}

func (d *dataset) filterAndMarshal(year int, modifier featureModifier) ([]byte, int, error) {
	filtered := d.filterByYear(year)
	if modifier != nil {
		filtered = modifier(year, filtered)
	}

	base := make(map[string]json.RawMessage, len(d.raw))
	for k, v := range d.raw {
		base[k] = v
	}

	featuresBytes, err := json.Marshal(filtered)
	if err != nil {
		return nil, 0, err
	}

	base["features"] = featuresBytes

	body, err := json.Marshal(base)
	if err != nil {
		return nil, 0, err
	}

	return body, len(filtered), nil
}

func (d *dataset) filterByYear(year int) []feature {
	filtered := make([]feature, 0, len(d.features))
	for _, f := range d.features {
		if isActiveForYear(f, year) {
			filtered = append(filtered, f)
		}
	}
	return filtered
}

func isActiveForYear(f feature, year int) bool {
	if year == 0 {
		return true
	}

	startYear, hasStart := parseYearField(f.Properties[startYearKey])
	if hasStart && year < startYear {
		return false
	}

	endYear, hasEnd := parseYearField(f.Properties[endYearKey])
	if hasEnd && year > endYear {
		return false
	}

	return true
}

func parseYearField(value any) (int, bool) {
	var year int
	switch v := value.(type) {
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil {
			return 0, false
		}
		year = parsed
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || math.Trunc(v) != v || v < 1 || v >= 9000 {
			return 0, false
		}
		year = int(v)
	case json.Number:
		parsed, err := v.Int64()
		if err != nil || parsed < 1 || parsed >= 9000 {
			return 0, false
		}
		year = int(parsed)
	default:
		return 0, false
	}
	if year < 1 || year >= 9000 || year == 999 {
		return 0, false
	}
	return year, true
}

func propertyString(props map[string]any, key string) string {
	if props == nil {
		return ""
	}
	value, ok := props[key]
	if !ok {
		return ""
	}
	if s, ok := value.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func activeLineNames(features []feature) map[string]struct{} {
	names := make(map[string]struct{}, len(features))
	for _, f := range features {
		name := propertyString(f.Properties, lineNameKey)
		if name != "" {
			names[name] = struct{}{}
		}
	}
	return names
}
