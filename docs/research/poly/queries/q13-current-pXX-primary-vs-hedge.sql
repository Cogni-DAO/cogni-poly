with token_cost as (
  -- Sum cost per (wallet, condition, token) over past 2 weeks
  select trader_wallet_id, condition_id, token_id, sum(size_usdc) as cost
  from poly_trader_fills
  where trader_wallet_id in (
    'a58df098-a862-4758-8954-7d14a2623ade',     -- RN1 prod
    '8c466f41-f6d0-4db2-b9fe-5c002b98f4fc'      -- swisstony prod
  )
    and observed_at >= now() - interval '14 days'
  group by 1, 2, 3
  having sum(size_usdc) > 0
),
classified as (
  -- Per (wallet, condition), classify each token as 'primary' (dominant) or 'hedge' (minority)
  -- For single-token conditions, the only token is primary.
  select tc.trader_wallet_id,
         tc.condition_id,
         tc.token_id,
         tc.cost,
         case
           when count(*) over (partition by tc.trader_wallet_id, tc.condition_id) = 1 then 'single'
           when tc.cost = max(tc.cost) over (partition by tc.trader_wallet_id, tc.condition_id) then 'primary'
           else 'hedge'
         end as role
  from token_cost tc
),
labeled as (
  select c.trader_wallet_id, c.cost, c.role, w.label
  from classified c
  join poly_trader_wallets w on w.id = c.trader_wallet_id
)
select label,
       role,
       count(*)::int as token_positions,
       sum(cost)::numeric(20,2) as total_cost,
       percentile_cont(0.50) within group (order by cost)::numeric(10,2) as p50,
       percentile_cont(0.75) within group (order by cost)::numeric(10,2) as p75,
       percentile_cont(0.90) within group (order by cost)::numeric(10,2) as p90,
       percentile_cont(0.95) within group (order by cost)::numeric(10,2) as p95,
       percentile_cont(0.99) within group (order by cost)::numeric(10,2) as p99,
       max(cost)::numeric(10,2) as max_cost
from labeled
group by 1, 2
order by 1, 2;
-- Q13 — pXX of token-position FINAL cost in last 14 days of prod, split primary/hedge/single.
-- ANSWERS: are the hardcoded pXX still accurate? Is the hedge distribution different from primary?
