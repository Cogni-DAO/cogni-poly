with rn1_conds as (
  select distinct condition_id
  from poly_trader_fills
  where trader_wallet_id = '43c12d6d-7847-467a-83e2-f41b901fca59'
    and observed_at >= '2025-07-01'
    and observed_at < '2025-12-01'
),
swiss_conds as (
  select distinct condition_id
  from poly_trader_fills
  where trader_wallet_id = '20875825-a325-4df9-8593-dee42c45c509'
    and observed_at >= '2025-08-01'
    and observed_at < '2025-12-01'
),
resolved as (
  select condition_id, max(outcome) as outcome
  from poly_market_outcomes
  group by 1
)
select 'rn1' as wallet,
       (select count(*) from rn1_conds)::int as total,
       (select count(*) from rn1_conds r join resolved o on o.condition_id = r.condition_id)::int as resolved,
       ((select count(*) from rn1_conds r join resolved o on o.condition_id = r.condition_id) * 100.0
        / nullif((select count(*) from rn1_conds), 0))::numeric(6,2) as pct
union all
select 'swisstony',
       (select count(*) from swiss_conds)::int,
       (select count(*) from swiss_conds s join resolved o on o.condition_id = s.condition_id)::int,
       ((select count(*) from swiss_conds s join resolved o on o.condition_id = s.condition_id) * 100.0
        / nullif((select count(*) from swiss_conds), 0))::numeric(6,2);
-- Q10 — % of backfilled conditions with outcomes in poly_market_outcomes.
-- ANSWERS: how stale is our realized-P/L analysis? Track over time.
