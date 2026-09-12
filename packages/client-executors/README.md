# @gcr/client-executors

Account execution adapters shared by GCR clients and Commit Defender. This baseline export establishes package identity only. P02 moves the verified adapters from Commit Defender, preserving their Apache-2.0 attribution, and connects them to a fixed source view.

Executors depend on the pure client contract; core receives an executor through a port rather than importing this package. No adapter is enabled merely by installing this initial artifact.
