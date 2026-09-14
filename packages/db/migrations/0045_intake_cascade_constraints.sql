-- Repository deletion cascades through criteria and raw client submissions.
-- Validate their cross-links after both cascades finish, while still rejecting
-- a standalone rule/request deletion that would leave a live intake orphaned.
alter table client_review_submission_decisions
  alter constraint client_review_submission_decisions_rule_id_fkey
  deferrable initially deferred;
alter table client_review_submission_decisions
  alter constraint client_review_submission_decisions_feedback_id_fkey
  deferrable initially deferred;
