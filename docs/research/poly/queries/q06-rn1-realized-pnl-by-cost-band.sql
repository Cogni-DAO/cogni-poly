with cond_state as (
  -- Q06 — RN1 realized P/L per cost band (LOAD-BEARING).
  -- Datasource: cogni-candidate-a-poly-postgres
  -- Wallet:     RN1 (43c12d6d-7847-467a-83e2-f41b901fca59 in candidate-a)
  -- Window:     2025-07-01 → 2025-12-01 (5 months of backfilled fills)
  -- ANSWERS:    For RN1 conditions that resolved, what's the realized P/L
  --             grouped by total cost basis?
  -- KNOWN LIMITS: only ~6% of conditions have outcomes; resolved subset may
  --             not be representative.
  -- See: docs/research/poly/queries/README.md
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
       sum(total_cost)::numeric(20,2) as cost,
       sum(winning_shares)::numeric(20,2) as payout,
       (sum(winning_shares) - sum(total_cost))::numeric(20,2) as realized_pnl,
       ((sum(winning_shares) - sum(total_cost)) / nullif(sum(total_cost), 0) * 100)::numeric(6,2) as pct_return
from cond_state
group by 1
order by 1;
