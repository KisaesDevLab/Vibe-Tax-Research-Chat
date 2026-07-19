-- TP-15 — hand-written DB-level invariants (no schema shape change).
--
-- 1. plan_results freeze: a computed result row is immutable once its
--    owning plan has reached presented/engaged/delivered/archived. The
--    application already refuses mutations at status >= presented
--    (409 plan_frozen); this trigger makes the invariant hold against
--    ANY writer — psql, a buggy job, a future endpoint.
--    Draft/in-review plans keep the recompute flow (delete + insert).
--
-- 2. audit_log is append-only. No UPDATE, no DELETE, from anyone.
--
-- Functions are CREATE OR REPLACE + DROP TRIGGER IF EXISTS so the
-- migration is safe to re-run (0002 pattern).

CREATE OR REPLACE FUNCTION plan_results_freeze_guard() RETURNS trigger AS $$
DECLARE
  plan_status text;
  target_plan uuid;
BEGIN
  target_plan := COALESCE(OLD.plan_id, NEW.plan_id);
  SELECT status INTO plan_status FROM plans WHERE id = target_plan;
  IF plan_status IN ('presented', 'engaged', 'delivered', 'archived') THEN
    RAISE EXCEPTION 'plan_frozen: plan_results are immutable once the plan is % (plan %)',
      plan_status, target_plan;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS plan_results_freeze ON plan_results;--> statement-breakpoint

CREATE TRIGGER plan_results_freeze
  BEFORE UPDATE OR DELETE ON plan_results
  FOR EACH ROW EXECUTE FUNCTION plan_results_freeze_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_log_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log_append_only: audit rows can never be modified or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;--> statement-breakpoint

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only_guard();
