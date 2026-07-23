#!/bin/bash
# coturn start wrapper — auto-detects public IP for dynamic IP setups
PUBLIC_IP=$(curl -s ifconfig.me)
echo "coturn starting — external IP: ${PUBLIC_IP}"

# Update the config with current public IP
sed -i "s/^external-ip=.*/external-ip=${PUBLIC_IP}\/192.168.100.13/" /etc/turnserver.conf

exec /usr/bin/turnserver -c /etc/turnserver.conf