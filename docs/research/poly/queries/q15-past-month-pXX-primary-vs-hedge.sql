with token_cost as (
  -- Sum cost per (wallet, condition, token) over past 30 days (PROD)
  select trader_wallet_id, condition_id, token_id, sum(size_usdc) as cost
  from poly_trader_fills
  where trader_wallet_id in (
    'a58df098-a862-4758-8954-7d14a2623ade',     -- RN1 prod
    '8c466f41-f6d0-4db2-b9fe-5c002b98f4fc'      -- swisstony prod
  )
    and observed_at >= now() - interval '30 days'
  group by 1, 2, 3
  having sum(size_usdc) > 0
),
classified as (
  -- Per (wallet, condition), classify each token as 'primary' (dominant)
  -- or 'hedge' (minority). Single-token conditions are 'single'.
  select tc.trader_wallet_id, tc.condition_id, tc.token_id, tc.cost,
         case
           when count(*) over (partition by tc.trader_wallet_id, tc.condition_id) = 1 then 'single'
           when tc.cost = max(tc.cost) over (partition by tc.trader_wallet_id, tc.condition_id) then 'primary'
           else 'hedge'
         end as role
  from token_cost tc
)
select w.label, c.role,
       count(*)::int as token_positions,
       sum(c.cost)::numeric(20,2) as total_cost,
       percentile_cont(0.50) within group (order by c.cost)::numeric(10,2) as p50,
       percentile_cont(0.75) within group (order by c.cost)::numeric(10,2) as p75,
       percentile_cont(0.90) within group (order by c.cost)::numeric(10,2) as p90,
       percentile_cont(0.95) within group (order by c.cost)::numeric(10,2) as p95,
       percentile_cont(0.99) within group (order by c.cost)::numeric(10,2) as p99,
       max(c.cost)::numeric(10,2) as max_cost
from classified c
join poly_trader_wallets w on w.id = c.trader_wallet_id
group by 1, 2
order by 1, 2;
-- Q15 — past-30-day pXX of token-position FINAL cost, split primary/hedge/single.
-- Datasource: cogni-production-poly-postgres
-- ANSWERS: what pXX values should TOP_TARGET_SIZE_SNAPSHOTS use, calibrated to
--          the most-recent month of activity? (Same shape as Q13 but 30d window.)
