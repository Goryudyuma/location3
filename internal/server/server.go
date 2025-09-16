package server

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
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

	railPath := filepath.Join(cfg.UTF8Dir, "N05-24_RailroadSection2.geojson")
	railData, err := os.ReadFile(railPath)
	if err != nil {
		return nil, fmt.Errorf("read railroad GeoJSON: %w", err)
	}

	stationPath := filepath.Join(cfg.UTF8Dir, "N05-24_Station2.geojson")
	stationData, err := os.ReadFile(stationPath)
	if err != nil {
		return nil, fmt.Errorf("read station GeoJSON: %w", err)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/api/railroads", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/geo+json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		if r.Method == http.MethodHead {
			return
		}
		if _, err := w.Write(railData); err != nil {
			http.Error(w, "failed to write response", http.StatusInternalServerError)
		}
	})

	mux.HandleFunc("/api/stations", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/geo+json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		if r.Method == http.MethodHead {
			return
		}
		if _, err := w.Write(stationData); err != nil {
			http.Error(w, "failed to write response", http.StatusInternalServerError)
		}
	})

	fileServer := http.FileServer(http.Dir(cfg.StaticDir))
	mux.Handle("/", fileServer)

	return mux, nil
}
