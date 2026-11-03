-- NULL represents an explicitly requested key without a time-based expiry.
-- Keep existing timestamps and the positive expiry / 90-day upper bound for dated keys unchanged.
-- PostgreSQL CHECK allows NULL; revocation and current access checks still apply.
alter table client_api_keys alter column expires_at drop not null;
