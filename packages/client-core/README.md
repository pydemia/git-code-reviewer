# @gcr/client-core

GCR-owned client logic for extension and headless consumers. The initial artifact establishes the build and distribution boundary. Review execution, persistence and sync are not implemented by this baseline export.

Core depends on the pure client contract. Host adapters supply editor, credential-store and executor capabilities; this package must not import VS Code, GCR server/DB packages or Commit Defender source.
