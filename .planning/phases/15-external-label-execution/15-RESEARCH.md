# Phase 15 Research: External Label Execution

## Research Complete

## Current State

The solver already can mark edge labels as `external-callout-required` and emit `routing.label-externalization.required`. That is useful but advisory. The long label may still be treated as a congestion symptom rather than an executed output shape.

## Needed Behavior

When policy allows external labels automatically:

1. Detect edges involved in `routing.label-congestion.unresolved`, `routing.route-label-loop.exhausted`, or dense inline label pileups.
2. Assign deterministic short keys such as `E1`, `E2`, sorted by edge ID or route order.
3. Put the original label text into an external shelf/legend annotation outside the route field.
4. Keep the local key small enough that routes can avoid it, or mark the long local label as not route-clearance text.
5. Emit a remediation plan with status `applied`.

## Validation Architecture

The key proof is not a lower warning count alone. The tests should assert that long edge-label boxes no longer intersect unrelated routes and that the output contains stable edge-to-callout mapping.
