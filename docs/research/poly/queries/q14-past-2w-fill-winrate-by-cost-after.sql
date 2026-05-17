with fills_state as (
  select trader_wallet_id, condition_id, token_id, observed_at, size_usdc,
         sum(size_usdc) over (
           partition by trader_wallet_id, condition_id, token_id
           order by observed_at
         ) as cost_after
  from poly_trader_fills
  where trader_wallet_id in (
    'a58df098-a862-4758-8954-7d14a2623ade',     -- RN1 prod
    '8c466f41-f6d0-4db2-b9fe-5c002b98f4fc'      -- swisstony prod
  )
    and observed_at >= now() - interval '14 days'
),
w_label as (
  select id, label
  from poly_trader_wallets
  where label in ('RN1', 'swisstony')
)
select wl.label,
       case
         when fs.cost_after <= 545    then '1_le_545'
         when fs.cost_after <= 1770   then '2_le_1770'
         when fs.cost_after <= 5372   then '3_le_5372'
         when fs.cost_after <= 14615  then '4_le_14615'
         else                              '5_gt_14615'
       end as bucket,
       count(*)::int as fills,
       count(*) filter (where o.outcome = 'winner')::int as winner_fills,
       count(*) filter (where o.outcome in ('winner','loser'))::int as resolved,
       (count(*) filter (where o.outcome = 'winner') * 100.0
        / nullif(count(*) filter (where o.outcome in ('winner','loser')), 0))::numeric(6,2) as winner_pct_of_resolved
from fills_state fs
join w_label wl on wl.id = fs.trader_wallet_id
left join poly_market_outcomes o
  on o.condition_id = fs.condition_id
 and o.token_id = fs.token_id
group by 1, 2
order by 1, 2;
-- Q14 — past-14-day fill winner rate by cost_after bucket, both wallets.
-- Datasource: cogni-production-poly-postgres
-- Coverage: 90-98% (most past-2w positions have resolved).
-- Bucket boundaries use swisstony's primary-side pXX (p50=498, p75=1770, p90=5372, p95=10593).
