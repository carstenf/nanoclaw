# Ports

Network mode: **host** (FreeSWITCH). Ports werden direkt auf Hetzners Public-IP gebunden.

## Extern

| Port | Proto | Dienst | Zweck |
|---|---|---|---|
| 5060 | UDP | FreeSWITCH sofia/external | SIP Signaling (Sipgate ↔ FS) |
| 60000-60100 | UDP | FreeSWITCH RTP | Media zu/von Sipgate (iptables-Whitelist matcht) |

## Lokal (loopback)

| Port | Proto | Dienst | Zweck |
|---|---|---|---|
| 5080 | UDP | sip-to-ai | Interner SIP-Endpoint (Etappe B) |
| 8021 | TCP | FreeSWITCH ESL | `fs_cli` lokal im Container |

## Firewall

`iptables` auf Python1 erlaubt 5060/udp + 60000-60100/udp aus den Sipgate-Subnetzen:
- `212.9.32.0/19`
- `217.116.112.0/20`
- `217.10.64.0/20`

Kein Firewall-Aenderung noetig.
