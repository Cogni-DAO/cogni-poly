with cond_state as (
  -- Q08 — RN1 win rate per cost band.
  -- "Win" = condition has ANY winning_shares > 0 (i.e., the winning token was held).
  -- LIMITATION: a paired-arb position with shares on both YES and NO always
  --             counts as "won" by this definition since one side wins.
  --             For directional conviction analysis, use Q06 (P/L %) instead.
  select f.condition_id,
         sum(f.size_usdc) as total_cost,
         sum(case when o.outcome = 'winner' then f.shares else 0 end) as winning_shares
  from poly_trader_fills f
  join poly_market_outcomes o
    on o.condition_id = f.condition_id
   and o.token_id = f.token_id
  where f.trader_wallet_id = '43c12d6d-7847-467a-83e2-f41b901fca59'
    and f.observed_at >= '2025-07-01'
    and f.observed_at < '2025-12-01'
    and o.outcome in ('winner', 'loser')
  group by 1
)
select case
         when total_cost <= 100   then '1_le_100'
         when total_cost <= 545   then '2_le_545'
         when total_cost <= 1229  then '3_le_1229'
         when total_cost <= 5000  then '4_le_5k'
         else                          '5_gt_5k'
       end as bucket,
       count(*)::int as conds,
       count(*) filter (where winning_shares > 0)::int as had_winning_side,
       (count(*) filter (where winning_shares > 0) * 100.0 / count(*))::numeric(6,2) as pct_with_winner,
       avg(total_cost)::numeric(10,2) as avg_cost,
       avg(winning_shares)::numeric(10,2) as avg_payout
from cond_state
group by 1
order by 1;
