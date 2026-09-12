# @gcr/client-contract

Server-independent contracts shared by Commit Defender and GCR clients. This initial artifact exposes package and protocol identity; review and knowledge contracts follow in P02. It has no runtime dependencies, Node-specific types, credentials or VS Code imports.

Build with `pnpm build:clients` from the GCR root. Produce and verify the versioned artifacts with `pnpm pack:clients --verify`. Distribution is documented in `docs/development/client-package-delivery.md` in GCR.
