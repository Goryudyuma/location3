# Repository Guidelines

## Project Structure & Module Organization
The module root is the repository base, defined by `go.mod` (`github.com/Goryudyuma/location3`). Domain datasets live in `N05-24_GML`, with parallel `Shift-JIS` and `UTF-8` directories plus the original `N05-24_GML.zip` archive and `KS-META-N05-24.xml` metadata. New Go packages should stay under `internal/` for shared logic and `cmd/` for binaries to keep geospatial processors separated from raw data.

## Build, Test, and Development Commands
Work with the toolchain declared in `go.mod` (Go 1.25.1 or the closest available release). Run `go mod tidy` after adding dependencies so module metadata stays minimal. Use `go test ./...` for unit suites and integration checks, and invoke experimental binaries with `go run ./cmd/<tool>` once command packages land. Keep dataset conversions reproducible by scripting them and capturing the invocation (e.g., `go run ./cmd/convert -input N05-24_GML/UTF-8/N05-24_RailroadSection2.geojson`).

## Coding Style & Naming Conventions
Follow `gofmt` defaults (tabs for indentation, camelCase identifiers, exported types with leading capitals). Group geospatial helpers by feature type, mirroring file stems like `RailroadSection` and `Station`. Check in generated assets only when indispensable and suffix them with the source encoding, e.g., `*_utf8.geojson`.

## Testing Guidelines
Favor table-driven tests for parsing and reprojection helpers, keeping fixtures in `testdata/` with the minimal subset of XML or GeoJSON needed. Name tests after the function plus the scenario (`TestStationParser_InvalidEncoding`). Run `go test -run …` to scope checks while iterating, and add coverage thresholds once core packages stabilize.

## Commit & Pull Request Guidelines
There is no commit history yet, so establish a precedent with imperative subject lines (`Add station decoder`) and optional `feat:` or `fix:` prefixes when they add clarity. Each pull request should summarize the data affected, list new commands or binaries, and note validation steps (`go test`, sample conversion output). Attach before/after snippets or small GeoJSON diffs when data artifacts change to speed up review.

## Data Handling & Encoding Tips
Preserve both encodings: adjust source edits in `Shift-JIS` and regenerate the UTF-8 copy to keep parity. Document any external tooling (OGR, GDAL) used for conversions in the pull request body, including exact flags. Never overwrite the original ZIP; add new archives with timestamped names under `N05-24_GML/backups/` if retention is required.
