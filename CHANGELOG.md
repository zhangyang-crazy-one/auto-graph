# Changelog

## v0.0.6 - 2026-06-04

### Fixed

- Fixed medium-density solver warnings reported in issue #13.
- Improved deterministic overlap repair for unlocked dense nodes by trying
  secondary-axis separation before primary-axis fallback.
- Expanded orthogonal routing with alternate automatic side anchors and outer
  dogleg candidates for dense obstacle layouts.
- Prevented automatic routes from crossing source or target node interiors when
  alternate anchors or doglegs are selected.
- Kept omitted endpoint anchors automatic when the opposite endpoint has an
  explicit anchor.
- Improved edge label placement so labels preserve the original clear offset and
  avoid crossing their owning edge or other routes.
- Added regression coverage for the issue #13 microservice fixture and Codex
  review routing cases.

## v0.0.5 - 2026-05-27

### Fixed

- Added MIT package metadata to npm-facing `package.json`.

## v0.0.4 - 2026-05-27

### Changed

- Previous patch release for the public auto-graph package.