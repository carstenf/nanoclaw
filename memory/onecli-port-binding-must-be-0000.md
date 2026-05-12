---
name: OneCLI port binding must NOT be restricted to a single host IP
description: ~/.onecli/docker-compose.yml ports must bind to 0.0.0.0 (no IP prefix) — container agents need host.docker.internal:10255 reachable, which maps to docker-bridge IP 172.17.0.1, not a WireGuard IP
type: feedback
originSessionId: dfa58332-9972-4c31-b972-d6bb34c83afb
---
OneCLI's `~/.onecli/docker-compose.yml` ports MUST stay as `"10254:10254"` and `"10255:10255"` (no IP prefix → binds to `0.0.0.0`, all interfaces).

If someone narrows it to e.g. `"10.0.0.2:10254:10254"` and `"10.0.0.2:10255:10255"`:
- Host nanoclaw can still talk to OneCLI by updating `ONECLI_URL=http://10.0.0.2:10254` in `.env`
- BUT container agents talk to OneCLI **gateway** via `HTTPS_PROXY=http://...@host.docker.internal:10255`. Linux Docker resolves `host.docker.internal` to the bridge gateway IP (`172.17.0.1`), NOT the WireGuard IP. So the proxy becomes unreachable → every API call retries → 401-style failure.

**Why:** Discovered 2026-05-11 when Andy's container couldn't reach Anthropic API — saw "API retry (retryable: true)" loop. Root cause: a docker-compose tweak around the NextAuth-URL fix (`docker-compose.yml.bak-20260510-2032-pre-nextauth-url`) had narrowed the bindings to `10.0.0.2`-only. Containers timed out trying to reach `172.17.0.1:10255`.

**How to apply:** Before/after any edit to `~/.onecli/docker-compose.yml`, verify `ss -tlnp | grep -E '10254|10255'` shows `0.0.0.0:` binding. If you see `10.0.0.2:` (or any other host IP), revert to no-IP-prefix. The "narrowed to WG IP" version looks security-conscious but breaks container access. If you genuinely want to restrict, list multiple binds: `"127.0.0.1:10254:10254"`, `"172.17.0.1:10254:10254"`, plus whatever WG/public IP — but `0.0.0.0` is the path of least surprise.
