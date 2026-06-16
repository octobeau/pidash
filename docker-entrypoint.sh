#!/bin/sh
set -eu

# Ensure nodeuser can write to /data (mounted volumes may have root ownership)
if [ -d /data ]; then
  chown -R nodeuser:nodeuser /data
  chmod 750 /data
fi

if [ "${ENABLE_HTTPS:-false}" = "true" ]; then
  cert_file="${TLS_CERT_FILE:-/app/certs/selfsigned.crt}"
  key_file="${TLS_KEY_FILE:-/app/certs/selfsigned.key}"

  if [ ! -f "$cert_file" ] || [ ! -f "$key_file" ]; then
    mkdir -p "$(dirname "$cert_file")" "$(dirname "$key_file")"
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
      -keyout "$key_file" \
      -out "$cert_file" \
      -days "${TLS_CERT_DAYS:-3650}" \
      -subj "${TLS_CERT_SUBJECT:-/CN=pihole-dashboard}" \
      -addext "subjectAltName=DNS:localhost,DNS:pihole-dashboard,IP:127.0.0.1"
  fi
fi

exec "$@"
