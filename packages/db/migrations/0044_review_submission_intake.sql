-- Intake disposition follows the raw submission's 30-day retention. Adopted
-- criterion sources and feedback requests follow their own existing lifecycle.
create table client_review_submission_decisions (
  submission_id uuid primary key references client_review_submissions(id) on delete cascade,
  action text not null check(action in ('dismiss','create-candidate','link-feedback')),
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
  note text not null check(char_length(note) between 1 and 2000),
  actor_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  rule_id uuid references review_rules(id),
  feedback_id uuid references review_rule_feedback(id),
  check((action='dismiss' and rule_id is null and feedback_id is null)
     or (action='create-candidate' and rule_id is not null and feedback_id is null)
     or (action='link-feedback' and rule_id is not null and feedback_id is not null))
);

-- A curator's adopted request retains attribution after raw intake expires.
create table review_rule_feedback_client_sources (
  feedback_id uuid primary key references review_rule_feedback(id) on delete cascade,
  content text not null check(char_length(content) between 1 and 8000)
);
