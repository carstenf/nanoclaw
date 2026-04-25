# voice-stack (briefing v8)

FreeSWITCH als reiner SIP-Gateway + sip-to-ai als interner Endpoint.

- **Etappe A** (dieser Stand): nur FreeSWITCH, REGISTER bei Sipgate, Dialplan bridged nach `127.0.0.1:5080`. sip-to-ai noch nicht da.
- **Etappe B+**: sip-to-ai Service als zweiter Compose-Service.

Siehe `~/nanoclaw-state/briefing.md` v8 fuer den vollen Plan.

## Layout

```
docker-compose.yml              # FS (Etappe A), spaeter +sip-to-ai
conf/overlay/                   # Mount → /overlay im FS-Container
  autoload_configs/modules.conf.xml
  sip_profiles/external-profile.xml
  sip_profiles/external/sipgate.xml
  dialplan/public.xml
  dialplan/public/01_sipgate_inbound.xml
  vars-override.xml             # (rendered at deploy, NICHT in git)
  vars-override.xml.tmpl        # Template mit __SIPGATE_PASSWORD__
scripts/
  deploy.sh                     # rendert vars-override.xml, rsync, compose up
runs/                           # pcap/log Artefakte (nicht in git)
```

## Deploy (Etappe A)

```bash
cd ~/nanoclaw/voice-stack
./scripts/deploy.sh
```

Was das Script tut:
1. Liest `SIPGATE_SIP_PASSWORD` aus `~/nanoclaw/.env` (altes Code-Repo)
2. Rendert `conf/overlay/vars-override.xml` lokal (600 perms)
3. rsync `voice-stack/` nach `voice_bot@Python1:~/voice-stack/` — exclusive `runs/`
4. `ssh ... docker compose up -d`
5. Wartet 10 s, prueft `sofia status gateway sipgate`

Bei Fehler: Decision-Doc in `~/nanoclaw-state/decisions/2026-04-12-v8-etappe-a-fs-minimal.md`.

## Image

Wiederverwendet `nanoclaw-freeswitch:dual` (auf Hetzner, ~2 GB, MPL + FS-Standardmodule). Der Image-Entrypoint `/custom-entrypoint.sh` kopiert die `/overlay/`-Dateien in `/usr/local/freeswitch/conf/` beim Start. Das heisst: wir kontrollieren nur die Files in `conf/overlay/`, der Rest bleibt Vanilla-FS.
