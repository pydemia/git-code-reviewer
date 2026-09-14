-- Only new materializations record measured Git tree identities. Legacy snapshots remain unknown.
alter table snapshots add column source_trees jsonb;
