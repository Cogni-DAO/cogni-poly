with cond_state as (
  -- Q07 — swisstony realized P/L per cost band.
  -- Datasource: cogni-candidate-a-poly-postgres
  -- Wallet:     swisstony (20875825-a325-4df9-8593-dee42c45c509 in candidate-a)
  -- Window:     2025-08-01 → 2025-12-01 (4 months — wallet started Aug 10 2025)
  -- ANSWERS:    swisstony's realized P/L grouped by cost-band per condition,
  --             for cross-comparison against Q06 (RN1).
  -- KNOWN LIMITS: same as Q06 — only ~6% resolved.
  select f.condition_id,
         sum(f.size_usdc) as total_cost,
         sum(case when o.outcome = 'winner' then f.shares else 0 end) as winning_shares
  from poly_trader_fills f
  join poly_market_outcomes o
    on o.condition_id = f.condition_id
   and o.token_id = f.token_id
  where f.trader_wallet_id = '20875825-a325-4df9-8593-dee42c45c509'
    and f.observed_at >= '2025-08-01'
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
