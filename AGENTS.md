# Development rules

- Keep core independent of Harness, GitHub, and UI packages.
- Confine Harness-specific APIs to adapters and the Cordis entry point.
- Preserve event and DB schema compatibility; add migrations instead of deleting data.
- Store state changes and their audit events in the same transaction.
- Do not equate queued/accepted/processing/task-completed states.
- Never automatically retry an uncertain delivery.
- Derive model-tool identity from the exact live execution Agent, not input arguments.
- Do not add outbound messaging, merging, or publishing as implicit side effects.
- Keep examples explicit about simulated versus real model execution.
- Verify changes with `npm run check` and `npm test`.
- Use focused tests for persistence, delivery, authorization, and state transitions.
