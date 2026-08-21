#!/usr/bin/env sh
# One-time first-deployment bootstrap: front door credentials, then the initial
# Let's Encrypt certificate.
#
# There is a chicken and egg problem on a fresh server. nginx refuses to start
# without a certificate file, and certbot's webroot method needs nginx running
# to serve the challenge. So the first certificate is issued in standalone
# mode, with certbot binding port 80 itself. Every renewal after this uses the
# webroot through nginx and needs no downtime.
#
#   ./deploy/bootstrap-tls.sh            issue a real certificate
#   ./deploy/bootstrap-tls.sh --staging  rehearse against the staging CA
#
# Run from the repository root or any directory; it locates itself.

set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

COMPOSE="docker compose -f docker-compose.prod.yml"
STAGING=""
[ "${1:-}" = "--staging" ] && STAGING="--staging"

if [ ! -f .env ]; then
    echo "error: no .env. Copy .env.example to .env and fill it in first." >&2
    exit 1
fi

# Read values without sourcing: a password or hash could contain shell syntax.
val() { sed -n "s/^$1=//p" .env | head -1; }
APP_DOMAIN=$(val APP_DOMAIN)
ACME_EMAIL=$(val ACME_EMAIL)
APP_USER=$(val APP_USER)

[ -n "$APP_DOMAIN" ] || { echo "error: APP_DOMAIN is empty in .env" >&2; exit 1; }
[ -n "$ACME_EMAIL" ] || { echo "error: ACME_EMAIL is empty in .env" >&2; exit 1; }
[ -n "$APP_USER" ]   || { echo "error: APP_USER is empty in .env" >&2; exit 1; }

# --- 1. DNS preflight -------------------------------------------------------
# Let's Encrypt allows five validation failures per hostname per hour. Pointing
# at the wrong address is the usual cause, so check before spending an attempt.

echo "==> checking DNS for $APP_DOMAIN"
MY_IP=$(curl -4 -s --max-time 15 https://ifconfig.me || true)
RESOLVED=$(getent ahostsv4 "$APP_DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')

echo "    this server: ${MY_IP:-unknown}"
echo "    resolves to: ${RESOLVED:-nothing}"

if [ -z "$MY_IP" ]; then
    echo "warning: could not determine this server's public IP, skipping the check" >&2
elif ! echo "$RESOLVED" | grep -qw "$MY_IP"; then
    cat >&2 <<MSG

error: $APP_DOMAIN does not resolve to this server.

  If it resolves to a Cloudflare address (104.x, 172.67.x, 188.114.x), the
  record is proxied. Set it to "DNS only" (grey cloud) so Let's Encrypt can
  reach this host directly, wait for propagation, then run this again.

MSG
    exit 1
fi

# --- 2. Front door credentials ---------------------------------------------
# nginx reads a plain htpasswd file, so unlike an env var there is no shell or
# compose interpolation to escape around the hash.

if [ -f deploy/htpasswd ]; then
    echo "==> deploy/htpasswd already exists, leaving it alone"
else
    echo "==> generating front door credentials"
    APP_PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
    docker run --rm httpd:2.4-alpine htpasswd -nbB "$APP_USER" "$APP_PASSWORD" \
        | head -1 > deploy/htpasswd
    chmod 600 deploy/htpasswd
    cat <<MSG

    ==========================================================
      FRONT DOOR LOGIN - save this now, it is not stored
        URL:      https://$APP_DOMAIN
        Username: $APP_USER
        Password: $APP_PASSWORD
    ==========================================================

MSG
fi

# --- 3. Issue the certificate ----------------------------------------------
# Port 80 has to be free for standalone mode, so stop nginx if it is up.

echo "==> freeing port 80"
$COMPOSE stop nginx 2>/dev/null || true

echo "==> requesting certificate${STAGING:+ (staging)}"
$COMPOSE run --rm --publish 80:80 --entrypoint certbot certbot \
    certonly --standalone \
    -d "$APP_DOMAIN" \
    --email "$ACME_EMAIL" \
    --agree-tos --no-eff-email --non-interactive \
    $STAGING

echo
echo "==> certificate in place. Start the stack with:"
echo "    docker compose -f docker-compose.prod.yml up -d --build"
