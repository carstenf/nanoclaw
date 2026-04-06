# NanoClaw Port-Konvention

Alle NanoClaw-Services nutzen ausschliesslich die Port-Range **4400-4499**.

| Port | Service | Status |
|------|---------|--------|
| 4400 | nanoclaw-main (agent/API, falls extern erreichbar) | reserviert |
| 4401 | nanoclaw voice-server (Twilio/ElevenLabs) | aktiv |
| 4410 | nanoclaw-hindsight API (intern 8888) | aktiv |
| 4411 | nanoclaw-hindsight Web UI (intern 9999) | aktiv |
| 4420 | twilio-bridge / inbound webhook | reserviert |
| 4421 | elevenlabs-webhook | reserviert |
| 4430 | health endpoint | reserviert |
| 4431 | metrics endpoint | reserviert |
| 4440-4499 | Reserve | frei |

## Inventar: nanoclaw-main (Agent-Container)

Agent-Container werden **on-demand** pro Nachricht gestartet (`docker run -i --rm --name nanoclaw-{group}-{timestamp}`). Sie binden **keine Host-Ports** — rein outbound (Anthropic API via OneCLI, Hindsight via Netzwerk). Kein Port-Mapping noetig.

## Regeln

1. Niemals Ports ausserhalb 4400-4499 binden.
2. Vor jedem neuen Port-Mapping: `ss -tlnp | grep :44` pruefen, freien Port waehlen, hier eintragen.
3. Falls ein Port ausserhalb der Range noetig ist: stoppen und zurueckmelden.
