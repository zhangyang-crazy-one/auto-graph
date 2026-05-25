# Diagram Geometry Engine

Diagram Geometry Engine (DGE) is a deterministic geometry computation engine for diagrams. It is not a renderer or editor; it turns declarative diagram intent into stable geometry data that downstream SVG, HTML, canvas, or design-tool exporters can consume.

## Commands

```bash
rtk npm run verify
```

## CLI

Build the package before running the compiled `dge` binary:

```bash
rtk npm run build
```

Generate neutral SVG from a YAML diagram:

```bash
dge --input examples/architecture.yaml --format svg --output architecture.svg
```

Pipe YAML into the CLI and emit editable Excalidraw JSON to stdout:

```bash
cat examples/architecture.yaml | dge --format excalidraw
```

Emit machine-readable diagnostics for automation:

```bash
cat bad.yaml | dge --json
```

The default output format is `svg`. Format precedence is CLI `--format`, then DSL `output.format`, then `svg`.

## Credits

DGE reuses the text measurement and line-breaking work from Pretext through `@chenglou/pretext` instead of rebuilding multilingual text algorithms from scratch. We appreciate the Pretext project and its MIT-licensed contribution to practical text layout.
