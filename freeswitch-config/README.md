# nanoclaw-freeswitch:dual — build instructions

The voice-stack on Hetzner pulls the FreeSWITCH image from this directory by
the tag `nanoclaw-freeswitch:dual`. There is no `build:` directive in
`mcp-voice-channel/telephony/docker-compose.yml` (the image is built
out-of-band, then referenced by tag), so the image must be built manually
the first time and after any change to this directory.

## Build

From this directory:

```bash
docker build -t nanoclaw-freeswitch:dual .
```

Or from the repo root:

```bash
docker build -t nanoclaw-freeswitch:dual freeswitch-config/
```

## What this image contains

- Base: `safarov/freeswitch:latest` (vanilla FS install at `/usr/local/freeswitch`)
- `entrypoint.sh` → installed as `/custom-entrypoint.sh` and used as ENTRYPOINT
- Sipgate gateway, vars override, inbound dialplan baked in under `/overlay/`

## What `:dual` means

Historical tag name from when this image had to switch between two SIP
profile sets. Today it's effectively the production FS image. Don't change
the tag — `mcp-voice-channel/telephony/docker-compose.yml` references it
verbatim.

## DR note

If the image cache on Hetzner is lost, rebuild from this Dockerfile and tag
exactly `nanoclaw-freeswitch:dual` so the existing compose file picks it up
without modification. Runtime FS-config (modules.conf.xml, sip_profiles,
dialplan extras) is bind-mounted from `mcp-voice-channel/telephony/conf/overlay/`
at startup — also on github.
