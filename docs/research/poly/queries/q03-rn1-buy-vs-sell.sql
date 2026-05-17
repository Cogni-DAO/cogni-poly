select trader_wallet_id,
       side,
       count(*)::int as fills,
       sum(size_usdc)::numeric(20,2) as usdc,
       avg(price)::numeric(8,6) as avg_price
from poly_trader_fills
where trader_wallet_id in (
  'a58df098-a862-4758-8954-7d14a2623ade',     -- RN1 in prod
  '8c466f41-f6d0-4db2-b9fe-5c002b98f4fc'      -- swisstony in prod
)
  and observed_at >= now() - interval '7 days'
group by 1, 2
order by 1, 2;
-- Q03 — RN1 + swisstony BUY vs SELL split for last 7 days (prod observation).
-- ANSWERS: confirm both wallets are net BUY-only with ~0 sells.
