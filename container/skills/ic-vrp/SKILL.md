---
name: ic-vrp
description: Compute and analyze the 0DTE SPX volatility risk premium (VRP = implied - realized vol) as an edge/filter for Iron Condors and other premium-selling strategies. Use when Carsten asks about IV vs RV, VRP, vol premium for Iron Condors/straddles, or wants to refresh or extend the Feb-2026 ic_vrp research.
---

# ic_vrp — 0DTE SPX volatility risk premium (IV − RV)

Carsten's research project from Feb 2026 (originally Hetzner `~/code/ic_vrp`). Read-only copy at
`/workspace/extra/quant-research/ic_vrp/`. **Read `RESEARCH_SUMMARY.md` there first** — it holds the
literature, the methodology fixes and all results. Answer Carsten in German.

## Method (do not change without telling Carsten)

- **IV:** Black-Scholes IV backed out of the 0DTE ATM straddle price (OptionOmega straddle backtests,
  `optionomega data/00-multi-straddle-test.csv`), per entry time, r = 4.5 %, solved with `brentq`.
- **RV:** **Garman-Klass same-day** RV from SPX OHLC:
  `σ²_GK = 0.5·ln(H/L)² − (2·ln2 − 1)·ln(C/O)²`, annualised `· sqrt(252)`.
- **VRP = IV − RV** (vol points).
- **Do NOT** use 5-day close-to-close RV against 0DTE IV: it contains overnight gaps that 0DTE IV
  does not price → systematically negative VRP (mean −3.1). That was the original mistake.
- Reference result (09:45 entry, GK 1d RV): mean VRP +0.45, positive on 60.5 % of days.
- Further work in the scripts: event filters (FOMC/CPI/NFP), weekday effects, HAR model to forecast RV
  (`11_har_vrp_forecast.py`) — forecast RV is what a live entry filter needs (same-day RV is only known ex post).

## Running it

The mount is read-only. Copy it, then run in order (paths are relative to the script folder):

```bash
cp -r /workspace/extra/quant-research/ic_vrp /workspace/group/ic_vrp && cd /workspace/group/ic_vrp
python3 06_proper_vrp.py && python3 08_vrp_gk1d.py   # daily VRP → output/daily_vrp_*.csv
```

| Script | Purpose |
|---|---|
| 01_download_data.py | SPX/VIX/VIX9D/VIX3M via yfinance → `data/combined_market_data.csv` |
| 02_event_calendar.py | FOMC/CPI/NFP flags |
| 03/04 | Regime filters, straddle VRP with regimes |
| 05/05b | Plots |
| 06_proper_vrp.py | Corrected VRP (5d RV + GK 1d RV) |
| 07_full_vrp_analysis.py | VRP across all entry times |
| 08_vrp_gk1d.py | GK 1d RV analysis, IV per entry time |
| 09/10 | Weekday analysis / significance tests |
| 11_har_vrp_forecast.py | HAR RV forecast |

Existing results are already in `output/` (`daily_vrp_proper.csv`, `daily_vrp_gk1d.csv`, `trade_level_iv.csv`, PNGs) — use them before re-running anything.

## Refreshing data (beyond Feb 2026)

- **Market data:** `yfinance` is not preinstalled. Try `pip install --user --break-system-packages yfinance`;
  if the network blocks it, take SPX daily OHLC and the VIX family from the **TradeBlocks MCP**
  (`market.duckdb` via `run_sql`; see skill `tradeblocks-market-data`) and write the same columns into
  `data/combined_market_data.csv`.
- **Straddle IVs:** need a fresh OptionOmega 0DTE straddle backtest (OO MCP). Ask Carsten before running
  new OO backtests (usage limits).
- Report every number with its source (file or tool call). Never invent figures.
