#!/bin/sh
set -eu

# Ensure nodeuser can write to /data (mounted volumes may have root ownership)
# Note: chown/chmod may fail in restrictive Docker setups, but the directory should still be writable
mkdir -p /data 2>/dev/null || true
chown -R nodeuser:nodeuser /data 2>/dev/null || true
chmod 777 /data 2>/dev/null || true

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
