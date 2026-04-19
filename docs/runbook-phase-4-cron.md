# Phase 4 Cron Runbook

**Scope:** Post-Wave-4 deployment of the 6 systemd timer units + the 3 in-process scheduled jobs added by plan 04-04 (+ companion jobs from 04-01/04-02 that share the same alert surface).

**Hosts:**

| Host    | User                | systemd units                                                  | Nanoclaw clone path     |
| ------- | ------------------- | -------------------------------------------------------------- | ----------------------- |
| Lenovo1 | `carsten_bot`       | `nanoclaw-audit-audio.{service,timer}`                         | `~/nanoclaw`            |
| Hetzner | `carsten` (not voice_bot) | `voice-audit-audio.{service,timer}` + `voice-pricing-refresh.{service,timer}` | `~/nanoclaw`            |

**Hetzner user choice: `carsten`** (not `voice_bot`). Rationale: MASTER.md §2 designates `carsten` as the admin account authorised to run filesystem audits + outbound HTTPS scrapes; `voice_bot` is scoped to FreeSWITCH runtime only and does not own a nanoclaw checkout or OneCLI profile. Only `carsten` has the SSH key + WireGuard peer ID allow-listed on Lenovo1:3200 (CORE_MCP_TOKEN bearer path).

## Alert Contract

Two distinct Discord channels fan out Phase-4 signals:

| Env var                         | Purpose                                 | Fired by                                         |
| ------------------------------- | --------------------------------------- | ------------------------------------------------ |
| `DISCORD_ALERT_WEBHOOK_URL`     | cost-cap warn/hard-stop, drift-monitor  | Bridge sideband + Core drift/recon workers       |
| `DISCORD_AUDIT_WEBHOOK_URL`     | §201 audit + pricing-refresh drift      | `audit-audio.sh` + `pricing-refresh.sh`          |

Keeping §201 signals on their own channel prevents cost noise from drowning legally significant audit findings.

## In-Process Scheduled Jobs (Lenovo1 only — run inside nanoclaw.service)

Per `CLAUDE.md` the orchestrator is a single Node.js process; we do NOT spawn new daemons for these three jobs. They register with `src/task-scheduler.ts` at boot and run inside the main event loop.

| Job                   | Module                  | Cron (local)        | Alert channel                     |
| --------------------- | ----------------------- | ------------------- | --------------------------------- |
| drift-monitor (P50)   | `src/drift-monitor.ts`  | daily 03:00         | `DISCORD_ALERT_WEBHOOK_URL`       |
| 3-way reconciliation  | `src/recon-3way.ts`     | daily 03:15         | `DISCORD_ALERT_WEBHOOK_URL` + `~/nanoclaw-state/open_points.md` |
| invoice reconciliation | `src/recon-invoice.ts` | monthly 2nd @ 04:00 | `DISCORD_ALERT_WEBHOOK_URL` + `~/nanoclaw-state/open_points.md` |

No systemd units for these three — reboot of `nanoclaw.service` re-registers them automatically.

## Systemd Timer Units (6 files total)

### 1. §201 Audit — Lenovo1

```bash
# One-time install (carsten_bot@lenovo1):
mkdir -p ~/.config/systemd/user ~/.config/nanoclaw
cp ~/nanoclaw/systemd/user/nanoclaw-audit-audio.service ~/.config/systemd/user/
cp ~/nanoclaw/systemd/user/nanoclaw-audit-audio.timer   ~/.config/systemd/user/

# Provision alert webhook secret via OneCLI:
onecli get DISCORD_AUDIT_WEBHOOK_URL > /tmp/audit.env.raw
echo "DISCORD_AUDIT_WEBHOOK_URL=$(cat /tmp/audit.env.raw)" > ~/.config/nanoclaw/audit.env
chmod 600 ~/.config/nanoclaw/audit.env
rm /tmp/audit.env.raw

# Enable user-linger so timers keep firing after logout:
sudo loginctl enable-linger carsten_bot

systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-audit-audio.timer
systemctl --user list-timers nanoclaw-audit-audio.timer    # verify next elapse
```

### 2. §201 Audit — Hetzner (+30 min staggered)

```bash
# One-time install (carsten@hetzner):
mkdir -p ~/.config/systemd/user ~/.config/nanoclaw
cp ~/nanoclaw/systemd/hetzner/voice-audit-audio.service ~/.config/systemd/user/
cp ~/nanoclaw/systemd/hetzner/voice-audit-audio.timer   ~/.config/systemd/user/

echo "DISCORD_AUDIT_WEBHOOK_URL=$(onecli get DISCORD_AUDIT_WEBHOOK_URL)" > ~/.config/nanoclaw/audit.env
chmod 600 ~/.config/nanoclaw/audit.env

sudo loginctl enable-linger carsten
systemctl --user daemon-reload
systemctl --user enable --now voice-audit-audio.timer
systemctl --user list-timers voice-audit-audio.timer
```

### 3. Pricing-Refresh — Hetzner (daily 02:00)

```bash
# One-time install (carsten@hetzner):
cp ~/nanoclaw/systemd/hetzner/voice-pricing-refresh.service ~/.config/systemd/user/
cp ~/nanoclaw/systemd/hetzner/voice-pricing-refresh.timer   ~/.config/systemd/user/

# Pricing-refresh env (SEPARATE file from audit.env because it has more secrets):
cat > ~/.config/nanoclaw/pricing.env <<EOF
DISCORD_AUDIT_WEBHOOK_URL=$(onecli get DISCORD_AUDIT_WEBHOOK_URL)
CORE_MCP_BASE_URL=http://10.0.0.2:3200
CORE_MCP_TOKEN=$(onecli get CORE_MCP_TOKEN)
OPENAI_PRICING_SOURCE_URL=https://platform.openai.com/docs/models/gpt-realtime-mini
EOF
chmod 600 ~/.config/nanoclaw/pricing.env

systemctl --user daemon-reload
systemctl --user enable --now voice-pricing-refresh.timer
systemctl --user list-timers voice-pricing-refresh.timer
```

### Timer Schedule Summary

| Unit                             | Host    | OnCalendar            | Randomise |
| -------------------------------- | ------- | --------------------- | --------- |
| nanoclaw-audit-audio.timer       | Lenovo1 | `*-*-01 02:00:00`     | 10 min    |
| voice-audit-audio.timer          | Hetzner | `*-*-01 02:30:00`     | 10 min    |
| voice-pricing-refresh.timer      | Hetzner | `*-*-* 02:00:00`      | 15 min    |

Randomisation is explicit so two workers on the same host don't all fire at `02:00:00` sharp. The `+30 min` stagger between the two §201 audits also keeps Discord from throttling us on the 02:00 UTC minute.

## OneCLI Env-Registration Checklist

Before enabling any of the units above, these secrets must exist in the OneCLI vault (scope: `carsten_bot` on Lenovo1, `carsten` on Hetzner):

| Secret                      | Scope   | Purpose                                                    |
| --------------------------- | ------- | ---------------------------------------------------------- |
| `DISCORD_AUDIT_WEBHOOK_URL` | both    | §201 audit + pricing-refresh drift alerts                  |
| `DISCORD_ALERT_WEBHOOK_URL` | Lenovo1 | cost/drift/recon alerts (already provisioned in Phase 4-02) |
| `CORE_MCP_BASE_URL`         | Hetzner | `http://10.0.0.2:3200` — pricing-refresh target            |
| `CORE_MCP_TOKEN`            | Hetzner | bearer for `voice.insert_price_snapshot`                   |
| `OPENAI_PRICING_SOURCE_URL` | Hetzner | optional — only override if OpenAI moves the docs page     |

## Post-Deploy Verification (Plan 04-05 smoke checks)

```bash
# 1. All 3 Lenovo1 + all 3 Hetzner timers active?
#    (Lenovo1):
systemctl --user list-timers nanoclaw-*

#    (Hetzner):
systemctl --user list-timers voice-*

# 2. Synthetic §201 seeded run (verifies exit-1 + Discord POST):
touch /tmp/test-audit-seed.wav
systemctl --user start nanoclaw-audit-audio.service
journalctl --user -u nanoclaw-audit-audio.service -n 40
# Expect: "AUDIT FAIL: 1 files found" in journal + Discord message in audit channel.
rm /tmp/test-audit-seed.wav

# 3. Dry-run pricing refresh (Hetzner):
systemctl --user start voice-pricing-refresh.service
journalctl --user -u voice-pricing-refresh.service -n 60
# Expect either "pricing-refresh OK" or a "source unreachable / parse failed"
# Discord alert — NEVER "pricing drift detected" on the first run (nothing to
# diff against). Check ~/nanoclaw-state/voice-pricing.json now exists.

# 4. Verify in-process jobs registered (Lenovo1):
journalctl --user -u nanoclaw.service -g "phase4_cron_registered" -n 5
# Expect 3 lines: drift-monitor, recon-3way, recon-invoice
```

## Runaway / Failure Mode Response

If a timer unit fails repeatedly (`systemctl --user list-units --state=failed`):

1. Check `journalctl --user -u <unit> -n 100` for the exit stacktrace.
2. For `audit-audio.sh` exit-1: that is the SUCCESS signal when files are found — do NOT "fix" by suppressing exit. Move the flagged files off-disk first, then verify the next cycle passes.
3. For `pricing-refresh.sh`: non-fatal by design (Pitfall 5). If drift is alerted, Carsten reviews https://platform.openai.com/docs/models/gpt-realtime-mini and manually bumps `voice-bridge/src/cost/prices.ts`. The scraper NEVER auto-updates code.

## Pitfall 5 (locked invariant)

`scripts/pricing-refresh.sh` must NEVER contain:

- `sed -i` on any `.ts` file
- `git commit` against the Core repo
- any write to `voice-bridge/src/cost/prices.ts`

Grep-verified: the script only writes to `voice_price_snapshots` (via MCP tool POST), `~/nanoclaw-state/voice-pricing.json`, and Discord webhook. Treat any future patch that breaks this as a P0 revert.
