-- Safe transport metadata only: no credentials, request text, or raw provider error body.
alter table model_request_ledger add column failure jsonb;
