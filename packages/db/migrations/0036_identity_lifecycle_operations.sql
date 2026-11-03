-- Lifecycle operations bind the exact security epoch they are authorized to
-- complete. Earlier provisioning operations and unbound legacy rows are retained.
alter table identity_admin_operations
  add column expected_security_epoch bigint check (expected_security_epoch > 0),
  add constraint identity_admin_operations_lifecycle_epoch_check check (
    kind not in ('disable','enable','logout-all') or idp_issuer is null or expected_security_epoch is not null
  );
