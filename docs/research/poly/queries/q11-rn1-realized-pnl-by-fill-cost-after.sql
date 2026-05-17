with fills_with_state as (
  -- Each fill, with its cumulative cost AT THAT FILL TIME (cost_after).
  -- This matches what bet-sizer-v1 sees per fill (targetTokenCostUsdc).
  select f.condition_id,
         f.token_id,
         f.observed_at,
         f.size_usdc,
         sum(f.size_usdc) over (
           partition by f.trader_wallet_id, f.condition_id, f.token_id
           order by f.observed_at
         ) as cost_after
  from poly_trader_fills f
  where f.trader_wallet_id = '43c12d6d-7847-467a-83e2-f41b901fca59'
    and f.observed_at >= '2025-07-01'
    and f.observed_at < '2025-12-01'
),
fill_outcome as (
  -- Each fill joined to its EVENTUAL outcome (winner/loser/unknown).
  -- If the token is the eventual winner, this fill's share contribution is realized at $1.
  select fws.condition_id,
         fws.token_id,
         fws.observed_at,
         fws.size_usdc,
         fws.cost_after,
         o.outcome
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
       sum(case when outcome = 'winner' then size_usdc / nullif(cost_after, 0) * cost_after else 0 end)::numeric(20,2) as winners_cost,
       count(*) filter (where outcome = 'winner')::int as winner_fills,
       (count(*) filter (where outcome = 'winner') * 100.0 / count(*))::numeric(6,2) as winner_pct
from fill_outcome
group by 1
order by 1;
-- Q11 — RN1 realized result bucketed by FILL'S cost_after (the algorithm's view).
-- ANSWERS: "At the moment of each fill, given cost_after = X, did this fill belong to a winning or losing token?"
-- This is the bucketing that matches plan-mirror.ts's gate behavior.
