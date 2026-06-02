# Pi-hole Multi-Dashboard

A small Dockerized dashboard for multiple Pi-hole servers. It shows aggregate metrics across all configured servers plus individual server cards, top lists, and comparisons.

The backend proxies Pi-hole API calls so the browser avoids CORS issues. It tries the Pi-hole v6 REST API first, then falls back to the v5 `admin/api.php` API when `version` is set to `auto`.

## Run

```bash
docker compose up --build
```

Open `http://localhost:8080` or `https://localhost:8443`.

The app stores server settings in SQLite at `/data/pidash.sqlite`. `config/piholes.json` is optional and only used to seed an empty database when `PIHOLE_CONFIG` is set.

## Configure

Use the Settings UI to add Pi-hole servers. For Pi-hole v6, use the web/app password. For Pi-hole v5, use the API token. Server records are stored in SQLite, and passwords are encrypted before they are written.

Set `CONFIG_ENCRYPTION_KEY` before saving Pi-hole passwords:

```yaml
environment:
  CONFIG_ENCRYPTION_KEY: "use-a-long-random-secret"
```

Generate a good key with:

```bash
openssl rand -base64 32
```

The browser never receives stored passwords. It only receives `hasPassword: true` for saved credentials.

## Dashboard Authentication

Set a strong `DASHBOARD_PASSWORD` to protect both the UI and `/api/*` endpoints with Basic Auth:

```yaml
environment:
  DASHBOARD_USERNAME: admin
  DASHBOARD_PASSWORD: "use-a-long-random-password"
```

Use the same scheme that the Pi-hole API accepts from this container. For many LAN installs, `http://192.168.x.x` works even when the admin UI is usually opened as `https://192.168.x.x/admin/`.

If you use HTTPS with a self-signed Pi-hole certificate, Node will reject it unless you uncomment `NODE_TLS_REJECT_UNAUTHORIZED: "0"` in `docker-compose.yml`.

## Dashboard HTTPS

The dashboard can serve HTTPS with an automatically generated self-signed certificate. The included `docker-compose.yml` enables this with:

```yaml
ports:
  - "8080:8080"
  - "8443:8443"
environment:
  ENABLE_HTTPS: "true"
  HTTPS_PORT: 8443
```

Open `https://localhost:8443` and accept the browser warning for the self-signed certificate.

To use your own certificate, mount files into the container and set:

```yaml
environment:
  TLS_CERT_FILE: /certs/fullchain.pem
  TLS_KEY_FILE: /certs/privkey.pem
volumes:
  - ./certs:/certs:ro
```

## Optional JSON Seed

To seed a fresh SQLite database from a JSON file, copy and edit the example, then mount it and set `PIHOLE_CONFIG`:

```bash
cp config/piholes.example.json config/piholes.json
```

```yaml
environment:
  PIHOLE_CONFIG: /app/config/piholes.json
volumes:
  - ./config/piholes.json:/app/config/piholes.json:ro
```

The seed only runs when the SQLite database has no server records.
