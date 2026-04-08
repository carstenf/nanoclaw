#!/bin/sh
# Custom entrypoint: let stock entrypoint write vanilla config,
# then overlay our files, then start FreeSWITCH.

# Run the stock entrypoint logic (copies vanilla config to /etc/freeswitch/)
if [ ! -f /etc/freeswitch/freeswitch.xml ]; then
  cp -a /usr/share/freeswitch/conf/vanilla/* /etc/freeswitch/
fi

# Overlay our config files
cp -f /overlay/sip_profiles/external/sipgate.xml /etc/freeswitch/sip_profiles/external/sipgate.xml
cp -f /overlay/dialplan/public/01_sipgate_inbound.xml /etc/freeswitch/dialplan/public/01_sipgate_inbound.xml

# Inject vars-override at the TOP of vars.xml (before stock vars)
if ! grep -q "vars-override" /etc/freeswitch/vars.xml; then
  sed -i '1s|^|<X-PRE-PROCESS cmd="include" data="vars-override.xml"/>\n|' /etc/freeswitch/vars.xml
  cp -f /overlay/vars-override.xml /etc/freeswitch/vars-override.xml
fi

# Set RTP port range to the firewall-allowed range (60000-61000)
# Stock config has these commented out — uncomment and set values
sed -i 's|.*<!-- <param name="rtp-start-port".*|    <param name="rtp-start-port" value="60000"/>|' /etc/freeswitch/autoload_configs/switch.conf.xml
sed -i 's|.*<!-- <param name="rtp-end-port".*|    <param name="rtp-end-port" value="60100"/>|' /etc/freeswitch/autoload_configs/switch.conf.xml

# Allow ESL connections from WireGuard network (10.0.0.0/24)
sed -i 's|<!--<param name="apply-inbound-acl" value="loopback.auto"/>-->|<param name="apply-inbound-acl" value="any_v4.auto"/>|' /etc/freeswitch/autoload_configs/event_socket.conf.xml

# Enable TLS on external profile (needed for OpenAI SIP)
# Generate self-signed cert if none exists (OpenAI doesn't verify our cert)
mkdir -p /etc/freeswitch/tls
# Use FreeSWITCH's auto-generated dtls-srtp.pem as agent.pem (openssl not available)
if [ ! -s /etc/freeswitch/tls/agent.pem ] && [ -s /etc/freeswitch/tls/dtls-srtp.pem ]; then
  cp /etc/freeswitch/tls/dtls-srtp.pem /etc/freeswitch/tls/agent.pem
  cp /etc/freeswitch/tls/dtls-srtp.pem /etc/freeswitch/tls/cafile.pem
fi

# Enable TLS on external profile (for outbound to OpenAI)
sed -i 's|external_ssl_enable=false|external_ssl_enable=true|' /etc/freeswitch/vars.xml
sed -i 's|value="\$\${external_tls_dir}"|value="/etc/freeswitch/tls"|' /etc/freeswitch/sip_profiles/external.xml

# Move external profile to port 5060 (guaranteed open in firewall)
# Internal profile moves to 15060 to avoid conflict
sed -i 's|data="external_sip_port=5080"|data="external_sip_port=5060"|' /etc/freeswitch/vars.xml
sed -i 's|data="external_tls_port=5081"|data="external_tls_port=5061"|' /etc/freeswitch/vars.xml
sed -i 's|data="internal_sip_port=5060"|data="internal_sip_port=15060"|' /etc/freeswitch/vars.xml

# Set external IP (override stun detection)
sed -i 's|<X-PRE-PROCESS cmd="stun-set".*external_rtp_ip.*|<X-PRE-PROCESS cmd="set" data="external_rtp_ip=128.140.104.236"/>|' /etc/freeswitch/vars.xml
sed -i 's|<X-PRE-PROCESS cmd="stun-set".*external_sip_ip.*|<X-PRE-PROCESS cmd="set" data="external_sip_ip=128.140.104.236"/>|' /etc/freeswitch/vars.xml

echo "NanoClaw overlay applied. Starting FreeSWITCH..."
exec freeswitch -nonat -nf
