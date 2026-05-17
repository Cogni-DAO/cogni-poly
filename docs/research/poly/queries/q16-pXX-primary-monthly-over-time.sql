with token_cost as (
  -- Sum cost per (wallet, month, condition, token) — monthly buckets
  select trader_wallet_id,
         date_trunc('month', observed_at) as month,
         condition_id, token_id,
         sum(size_usdc) as cost
  from poly_trader_fills
  where trader_wallet_id in (
    '43c12d6d-7847-467a-83e2-f41b901fca59',     -- RN1 candidate-a
    '20875825-a325-4df9-8593-dee42c45c509'      -- swisstony candidate-a
  )
    and observed_at >= '2025-07-01'
  group by 1, 2, 3, 4
  having sum(size_usdc) > 0
),
classified as (
  select tc.trader_wallet_id, tc.month, tc.condition_id, tc.token_id, tc.cost,
         case
           when count(*) over (partition by tc.trader_wallet_id, tc.month, tc.condition_id) = 1 then 'single'
           when tc.cost = max(tc.cost) over (partition by tc.trader_wallet_id, tc.month, tc.condition_id) then 'primary'
           else 'hedge'
         end as role
  from token_cost tc
)
select w.label, c.month, c.role,
       count(*)::int as positions,
       percentile_cont(0.50) within group (order by c.cost)::numeric(10,2) as p50,
       percentile_cont(0.75) within group (order by c.cost)::numeric(10,2) as p75,
       percentile_cont(0.90) within group (order by c.cost)::numeric(10,2) as p90,
       percentile_cont(0.95) within group (order by c.cost)::numeric(10,2) as p95,
       percentile_cont(0.99) within group (order by c.cost)::numeric(10,2) as p99
from classified c
join poly_trader_wallets w on w.id = c.trader_wallet_id
where c.role = 'primary'   -- only primary; that's what bet-sizer-v1 effectively gates on
group by 1, 2, 3
order by 1, 2;
-- Q16 — primary-side pXX position cost, per month, for both wallets.
-- Datasource: cogni-candidate-a-poly-postgres (continuous backfill)
-- ANSWERS: how have pXX position sizes evolved month-over-month?
