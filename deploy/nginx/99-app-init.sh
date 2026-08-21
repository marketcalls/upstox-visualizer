#!/bin/sh
# Runs from the nginx image's /docker-entrypoint.d/ hook, after the envsubst
# step at 20- has rendered app.conf.template into conf.d.
#
# This has to be a hook rather than a `command:` override in compose. The image
# entrypoint only runs the template rendering when the command starts with
# "nginx", so overriding the command to wrap a loop around it silently ships a
# server with nothing but the stock welcome page and no TLS listener at all.

set -e

# Drop the stock welcome server so nothing but the app is reachable.
rm -f /etc/nginx/conf.d/default.conf

# nginx only re-reads a certificate on reload, so a renewal stays invisible
# until something signals the master process. Without this the certificate
# renews on disk and still expires in place on the running server.
( while :; do sleep 6h; nginx -s reload 2>/dev/null || true; done ) &
