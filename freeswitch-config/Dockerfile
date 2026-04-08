# FreeSWITCH for NanoClaw Voice — SIP bridge to OpenAI Realtime API
#
# Based on stock safarov/freeswitch with vanilla config.
# We overlay: Sipgate gateway, vars override, inbound dialplan.

FROM safarov/freeswitch:latest

# Sipgate gateway
COPY sipgate-gateway.xml /overlay/sip_profiles/external/sipgate.xml

# Vars override (Hetzner IP, credentials, codecs)
COPY vars-override.xml /overlay/vars-override.xml

# Inbound dialplan
COPY dialplan-public.xml /overlay/dialplan/public/01_sipgate_inbound.xml

# Entrypoint script: copy overlays after stock config is written, then start FS
COPY entrypoint.sh /custom-entrypoint.sh
RUN chmod +x /custom-entrypoint.sh

EXPOSE 8021/tcp 5060/udp 5060/tcp 5061/tcp

ENTRYPOINT ["/custom-entrypoint.sh"]
