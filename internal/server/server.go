package server

import (
	"encoding/json"
	"errors"
	"fmt"
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
	original []byte
	raw      map[string]json.RawMessage
	features []feature
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
	type alias feature
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
		original: rawBytes,
		raw:      raw,
		features: features,
	}, nil
}

func datasetHandler(ds *dataset, modifier featureModifier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var (
			body        []byte
			featureSize int
			err         error
		)

		dateParam := strings.TrimSpace(r.URL.Query().Get("date"))
		if dateParam == "" {
			body = ds.original
			featureSize = len(ds.features)
		} else {
			filterTime, parseErr := time.Parse("2006-01-02", dateParam)
			if parseErr != nil {
				http.Error(w, "invalid date format, use YYYY-MM-DD", http.StatusBadRequest)
				return
			}

			body, featureSize, err = ds.filterAndMarshal(filterTime.Year(), modifier)
			if err != nil {
				http.Error(w, "failed to build filtered dataset", http.StatusInternalServerError)
				return
			}

			w.Header().Set("X-Filter-Year", strconv.Itoa(filterTime.Year()))
		}

		w.Header().Set("Content-Type", "application/geo+json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		w.Header().Set("X-Feature-Count", strconv.Itoa(featureSize))

		if r.Method == http.MethodHead {
			return
		}

		if _, err := w.Write(body); err != nil {
			http.Error(w, "failed to write response", http.StatusInternalServerError)
		}
	}
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
	switch v := value.(type) {
	case string:
		v = strings.TrimSpace(v)
		if v == "" {
			return 0, false
		}
		year, err := strconv.Atoi(v)
		if err != nil {
			return 0, false
		}
		if year >= 9000 || year == 999 {
			return 0, false
		}
		return year, true
	case float64:
		year := int(v)
		if year >= 9000 || year == 999 {
			return 0, false
		}
		return year, true
	case json.Number:
		year, err := v.Int64()
		if err != nil {
			return 0, false
		}
		if year >= 9000 || year == 999 {
			return 0, false
		}
		return int(year), true
	default:
		return 0, false
	}
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
