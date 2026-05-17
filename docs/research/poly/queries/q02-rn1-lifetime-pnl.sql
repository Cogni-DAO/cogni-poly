select trader_wallet_id,
       fidelity,
       count(*)::int as points,
       min(ts) as earliest_ts,
       max(ts) as latest_ts,
       min(pnl_usdc)::numeric(20,2) as min_pnl,
       max(pnl_usdc)::numeric(20,2) as max_pnl,
       (
         select pnl_usdc
         from poly_trader_user_pnl_points p2
         where p2.trader_wallet_id = p.trader_wallet_id
           and p2.fidelity = p.fidelity
         order by ts desc
         limit 1
       )::numeric(20,2) as latest_pnl
from poly_trader_user_pnl_points p
where trader_wallet_id in (
  'a58df098-a862-4758-8954-7d14a2623ade',     -- RN1 in prod
  '8c466f41-f6d0-4db2-b9fe-5c002b98f4fc'      -- swisstony in prod
)
group by 1, 2
order by 1, 2;
-- Q02 — RN1 + swisstony lifetime P/L from Polymarket user-pnl-api.
-- Datasource: cogni-production-poly-postgres
-- Output: latest_pnl = cumulative realized P/L per wallet per fidelity (1h, 1d).
