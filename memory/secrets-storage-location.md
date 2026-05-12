---
name: System-wide secrets storage on Lenovo1
description: API-keys, tokens, passwords on Lenovo1 live in /etc/secrets/, mode 0640, group `secrets`. Access requires being in the secrets group; use `sg secrets -c ...` if your shell login predates the group add.
type: reference
originSessionId: 1797ab25-3535-43e5-92c8-c2b2ae9bca17
---
System-weite Secrets auf Lenovo1 (Carsten's Server) liegen unter `/etc/secrets/`. Files sind `root:secrets 0640`. Lesen geht nur als Mitglied der `secrets`-Group. Nanoclaw-interne Secrets dagegen liegen im OneCLI-Vault (`onecli secrets list/get`) — das ist disjunkt zu `/etc/secrets/`.

**MASTER.md Sektion 4 (`H2. Keine Secrets in Git oder Logs.`)** und `secrets-management.md` (auf Lenovo1 unter `/opt/server-docs/`) sind die kanonische Doku.

Bekannte Secrets in `/etc/secrets/` (Stand 2026-05-10): `openai-api-key`, `hindsight-mcp-tokens`, `hindsight-mcp-tokens-by-client`, `github-pat` (in dieser Session ergänzt). Liste ist nicht abgeschlossen — `ls /etc/secrets/` aufrufen.

**Group-Mitgliedschaften per MASTER.md §2:**
- `hindsight-mcp` (uid 1006): in `secrets` group
- `voice_bot` (auf Hetzner): in `secrets` group lokal
- `carsten_bot`: ab 2026-05-10 in `secrets` group hinzugefügt für nanoclaw-related Secret-Zugriffe

**Praktischer Zugriff aus laufender Claude-Session als carsten_bot:** Group-Adds wirken nicht in laufenden Prozessen — wenn `groups | grep -q secrets` `false` zurückgibt aber der User in `/etc/group` drinsteht, dann `sg secrets -c "cat /etc/secrets/<file>"` benutzen (gleicher Trick wie für die `claudestate`-Group beim state-repo-Push). Andernfalls: neue Session.

**Ablage neuer Secrets:** als Carsten via sudo direkt in `/etc/secrets/<name>` schreiben (mode 0640 root:secrets). Niemals als carsten_bot anlegen — dem fehlt write-access auf `/etc/secrets/` (only owner: root).
