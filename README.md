# Diagram Geometry Engine

Diagram Geometry Engine (DGE) is a deterministic geometry computation engine for diagrams. It is not a renderer or editor; it turns declarative diagram intent into stable geometry data that downstream SVG, HTML, canvas, or design-tool exporters can consume.

## Commands

```bash
rtk npm run verify
```

## Credits

DGE reuses the text measurement and line-breaking work from Pretext through `@chenglou/pretext` instead of rebuilding multilingual text algorithms from scratch. We appreciate the Pretext project and its MIT-licensed contribution to practical text layout.
