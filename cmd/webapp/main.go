package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/Goryudyuma/location3/internal/server"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	utf8Dir := flag.String("utf8-dir", "N05-24_GML/UTF-8", "path to UTF-8 dataset directory")
	staticDir := flag.String("static-dir", "web/static", "path to static asset directory")
	flag.Parse()

	handler, err := server.NewHandler(server.Config{
		UTF8Dir:   *utf8Dir,
		StaticDir: *staticDir,
	})
	if err != nil {
		log.Fatalf("failed to create handler: %v", err)
	}

	log.Printf("serving on %s", *addr)
	if err := http.ListenAndServe(*addr, handler); err != nil {
		log.Fatalf("server exited: %v", err)
	}
}
