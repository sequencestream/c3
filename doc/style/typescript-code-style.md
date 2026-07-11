# TypeScript Code Style

- **No `enum`**: use `as const` arrays + derived string unions; `enum` bloats emit and breaks tree-shaking
- **No `any`**: use `unknown` + type guards; `any` silences the compiler, `unknown` forces narrowing
- **`import type` for type-only imports**: keeps imports erased at runtime, prevents circular refs
- **Explicit return types on all exported functions**: the public API is a contract; inference hides breaks
- **`interface` for object shapes, `type` for everything else**: `interface` = named record; `type` = unions, intersections, mapped/conditional types, type aliases
