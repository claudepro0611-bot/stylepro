-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Daily penalty job - runs every day at midnight
SELECT cron.schedule(
  'daily-penalty-check',
  '0 0 * * *',
  $$
    UPDATE public.companies
    SET
      -- Start grace period tracking
      grace_period_start = CASE
        WHEN payment_due_date < CURRENT_DATE AND grace_period_start IS NULL AND has_contract = true
        THEN CURRENT_DATE
        ELSE grace_period_start
      END,

      -- Increment penalty days if in grace period
      penalty_days = CASE
        WHEN payment_due_date < CURRENT_DATE AND has_contract = true AND penalty_days < max_grace_days
        THEN penalty_days + 1
        ELSE penalty_days
      END,

      -- Add daily penalty to total
      total_penalty = CASE
        WHEN payment_due_date < CURRENT_DATE AND has_contract = true AND penalty_days < max_grace_days
        THEN total_penalty + daily_penalty
        ELSE total_penalty
      END
    WHERE payment_due_date IS NOT NULL;
  $$
);
