# Phase 04: Pattern Map

## Candidate Files

| Planned File | Role | Closest Existing Analog | Pattern To Reuse |
|--------------|------|-------------------------|------------------|
| `src/exporters/index.ts` | barrel | `src/routing/index.ts`, `src/solver/index.ts` | Re-export submodule barrels with `.js` specifiers. |
| `src/exporters/types.ts` | public contracts | `src/routing/types.ts`, `src/layout/types.ts` | Small exported interfaces and string literal unions. |
| `src/exporters/svg.ts` | serializer | `src/serialization/canonical.ts` | Pure function, deterministic output, explicit validation. |
| `src/exporters/excalidraw.ts` | JSON adapter | `src/serialization/canonical.ts` | Deterministic object construction and stable IDs. |
| `src/exporters/arrow.ts` | helper | `src/routing/routes.ts` | Point-array processing without mutating input. |
| `src/ir/label-layout.ts` | core IR label layout types | `src/labels/types.ts` | Move renderer-neutral label layout contracts down to IR layer. |
| `src/ir/elements.ts` | coordinated label field | `src/ir/elements.ts` existing optional fields | Add optional fields without breaking existing fixtures. |
| `src/labels/types.ts` | label module compatibility | `src/labels/types.ts` | Re-export/import IR label layout types to avoid duplicate contracts. |
| `src/solver/solve.ts` | pass-through label layout | `src/solver/solve.ts` node/group construction | Preserve optional fields from normalized/coordinated inputs without exporter logic. |
| `test/exporters.test.ts` | exporter tests | `test/routing.test.ts`, `test/public-api.test.ts` | Focused behavioral tests with exact strings/patterns. |
| `test/fixtures/phase-04/*` | golden fixtures | `test/fixtures/phase-03/*` | Committed canonical fixtures compared byte-for-byte. |

## Existing Code Rules

### Public Entry Point

Current `src/index.ts` exports feature barrels:

```ts
export * from "./constraints/index.js";
export * from "./geometry/index.js";
export * from "./ir/index.js";
export * from "./labels/index.js";
export * from "./layout/index.js";
export * from "./routing/index.js";
export * from "./serialization/index.js";
export * from "./solver/index.js";
export * from "./text/index.js";
```

Phase 04 should add:

```ts
export * from "./exporters/index.js";
```

### Type Shape

Existing coordinated types are in `src/ir/elements.ts` and `src/ir/diagram.ts`. Optional additions should preserve existing tests:

```ts
export interface CoordinatedNode extends NodeBase {
  shape: NodeShape;
  box: Box;
  anchors: AnchorPoint[];
  parentId?: string;
}
```

Add `labelLayout?: LabelLayout` only where needed, and avoid exporter-specific fields. Keep the type in IR, not in exporters and not as a reverse dependency from IR to labels.

### Deterministic Fixtures

Existing tests read committed fixture files:

```ts
const fixture = readFileSync(
  new URL(`./fixtures/phase-03/${fixtureName}`, import.meta.url),
  "utf8",
);

expect(stringifyCanonical(solveDiagram(input))).toBe(fixture);
```

Phase 04 should follow the same pattern for Excalidraw JSON and exact SVG strings.

### Forbidden Geometry Recompute

Exporters must not import these modules:

- `../solver/`
- `../layout/`
- `../routing/`
- `../text/`
- `../labels/`
- `../geometry/`

Allow imports from:

- `../ir/`
- `../serialization/`

## Test Strategy

- Add `test/exporters.test.ts` for SVG and Excalidraw.
- Extend `test/public-api.test.ts` for root exporter imports.
- Extend `test/determinism.test.ts` or add exporter fixture tests to prove stable golden output.
- Update `biome.json` to exclude `test/fixtures/phase-04` if exact fixture formatting must remain serializer-owned.
