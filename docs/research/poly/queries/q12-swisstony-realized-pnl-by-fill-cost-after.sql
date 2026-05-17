with fills_with_state as (
  select f.condition_id,
         f.token_id,
         f.observed_at,
         f.size_usdc,
         sum(f.size_usdc) over (
           partition by f.trader_wallet_id, f.condition_id, f.token_id
           order by f.observed_at
         ) as cost_after
  from poly_trader_fills f
  where f.trader_wallet_id = '20875825-a325-4df9-8593-dee42c45c509'
    and f.observed_at >= '2025-08-01'
    and f.observed_at < '2025-12-01'
),
fill_outcome as (
  select fws.condition_id, fws.token_id, fws.observed_at, fws.size_usdc, fws.cost_after, o.outcome
  from fills_with_state fws
  join poly_market_outcomes o
    on o.condition_id = fws.condition_id
   and o.token_id = fws.token_id
  where o.outcome in ('winner', 'loser')
)
select case
         when cost_after <= 100   then '1_le_100'
         when cost_after <= 545   then '2_le_545'
         when cost_after <= 1229  then '3_le_1229'
         when cost_after <= 5000  then '4_le_5k'
         else                          '5_gt_5k'
       end as bucket_at_fill,
       count(*)::int as fills,
       sum(size_usdc)::numeric(20,2) as cost,
       count(*) filter (where outcome = 'winner')::int as winner_fills,
       (count(*) filter (where outcome = 'winner') * 100.0 / count(*))::numeric(6,2) as winner_pct
from fill_outcome
group by 1
order by 1;
-- Q12 — swisstony fill-level winner rate by cost_after. Companion to Q11 (RN1).
