---
name: OneCLI env-vars for app-OAuth redirect_uri
description: Which env vars actually control the OAuth redirect_uri OneCLI sends to Google (and which one breaks container proxies)
type: project
originSessionId: 07a163f5-028f-460c-875b-2cc088576b1c
---
When you want OneCLI's app-OAuth flow (Gmail, Calendar, GitHub, etc.) to use a public domain like `https://onecli.carstenfreek.de` instead of `localhost:10254`, set these env vars **together** in `~/.onecli/docker-compose.yml`:

```yaml
environment:
  NEXTAUTH_URL: https://onecli.carstenfreek.de
  AUTH_URL: https://onecli.carstenfreek.de
  NEXT_PUBLIC_APP_URL: https://onecli.carstenfreek.de
  API_BASE_URL: https://onecli.carstenfreek.de
```

**Found empirically — OneCLI doesn't document which of these is load-bearing.** Setting only `NEXTAUTH_URL` reverts redirect_uri to `localhost:10254`. Setting all four works. One of `AUTH_URL` / `NEXT_PUBLIC_APP_URL` / `API_BASE_URL` is the real driver — didn't isolate which.

**DO NOT set `GATEWAY_BASE_URL`** — that one corrupts the container HTTPS_PROXY URL. OneCLI builds the per-container proxy as `http://<token>@<GATEWAY_BASE_URL host>:10255`, and if `GATEWAY_BASE_URL=https://...` the proxy URL becomes `http://...@https://onecli.carstenfreek.de` which is malformed → `ConnectionRefused` from every container. The gateway must stay reachable as `host.docker.internal:10255` from inside containers, and OneCLI defaults to that correctly.

**Why:** Discovered 2026-05-10 during Gmail-OAuth onboarding for Andy. The OneCLI v1.22.0 Apps framework uses NextAuth-style env-driven URL construction for OAuth callbacks but a separate code path for the gateway proxy URL. Setting `GATEWAY_BASE_URL` overrides the latter incorrectly.

**How to apply:**
- For any new OAuth-app onboarding (Calendar, Drive, GitHub, Notion, etc.) that needs a public callback URL → just leave the existing four env-vars; don't add more.
- If container logs show `ConnectionRefused` to `api.anthropic.com` (or any host that should go through OneCLI) → check `docker exec <container> env | grep -i proxy`. If the URL has `@https://...` in it, GATEWAY_BASE_URL has been set somewhere and needs to come out.
