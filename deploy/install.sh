#!/usr/bin/env bash
# Installs or updates My Avatar on an Ubuntu server. Idempotent; run as root.
#
#   RELEASE=/tmp/avatar-release.tgz ENV_FILE=/root/.avatar-deploy.env bash install.sh
#
# ENV_FILE provides DOMAIN, ZARINPAL_MERCHANT_ID, GEMINI_API_KEY (and optionally ZARINPAL_SANDBOX,
# GEMINI_IMAGE_MODEL, PLAN_*_TOMAN, AVATAR_*_LIMIT, AVATAR_UNLIMITED_LOGINS). Existing nginx sites are
# never modified: the app gets its own server block, and every nginx change is validated with `nginx -t`
# and rolled back if it fails.
set -euo pipefail

APP=/opt/avatar
APP_PORT=${APP_PORT:-3000}
TTS_PORT=${TTS_PORT:-5002}
PIPER_VERSION=1.8.0
VOICES=(en_US-amy-medium en_US-ryan-medium fa_IR-amir-medium fa_IR-gyro-medium)
ACME_ROOT=/var/www/avatar-acme

log() { echo "==> $*"; }
warn() { echo "::warning::$*"; }
fail() { echo "::error::$*"; exit 1; }

[ "$(id -u)" = 0 ] || fail "install.sh must run as root"
[ -f "${RELEASE:-}" ] || fail "RELEASE tarball not found"
# shellcheck disable=SC1090
[ -f "${ENV_FILE:-}" ] && . "$ENV_FILE"
[ -n "${DOMAIN:-}" ] || fail "DOMAIN is not set"
export DEBIAN_FRONTEND=noninteractive

apt_install() {
  local missing=()
  for pkg in "$@"; do dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg"); done
  [ ${#missing[@]} -eq 0 ] && return
  log "Installing packages: ${missing[*]}"
  apt-get update -qq
  apt-get install -y -qq "${missing[@]}" >/dev/null
}

# ---------- system prerequisites ----------
NODE=$(command -v node || true)
[ -n "$NODE" ] || fail "Node.js is not installed"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || fail "Node.js >= 22.13 is required (found $(node --version))"
apt_install python3-venv curl ffmpeg
command -v certbot >/dev/null || apt_install certbot

# A little swap keeps the voice model from starving other services on small (≤1 GB) servers.
if ! swapon --show | grep -q . && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1500000 ]; then
  if [ "$(df --output=avail -k / | tail -1)" -gt 2500000 ]; then
    log "Adding a 1 GB swap file"
    fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    warn "Low memory and too little free disk for swap; the voice service may be slow"
  fi
fi

id avatar >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin avatar
mkdir -p "$APP/releases" "$APP/shared/data" "$APP/shared/voices"
chown -R avatar:avatar "$APP/shared/data"

# ---------- application release ----------
REL="$APP/releases/$(date +%Y%m%d%H%M%S)"
log "Unpacking release into $REL"
mkdir -p "$REL"
tar xzf "$RELEASE" -C "$REL"
PREV=$(readlink -f "$APP/current" 2>/dev/null || true)
if [ -n "$PREV" ] && [ -d "$PREV/node_modules" ] && cmp -s "$PREV/package-lock.json" "$REL/package-lock.json"; then
  log "Dependencies unchanged; reusing node_modules"
  cp -a "$PREV/node_modules" "$REL/"
else
  log "Installing Node dependencies"
  (cd "$REL" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
fi

# ---------- configuration ----------
ENVF="$APP/shared/.env"
touch "$ENVF"
MANAGED='^(PORT|HOST|BASE_URL|DATA_DIR|TTS_URL|COOKIE_SECURE|TRUST_PROXY|ZARINPAL_MERCHANT_ID|ZARINPAL_SANDBOX|GEMINI_API_KEY|GEMINI_IMAGE_MODEL|GEMINI_TTS_MODEL|PLAN_MONTHLY_TOMAN|PLAN_QUARTERLY_TOMAN|AVATAR_DAILY_LIMIT|AVATAR_FREE_LIMIT|AVATAR_SUBSCRIBER_LIMIT|AVATAR_UNLIMITED_LOGINS)='
{
  grep -Ev "$MANAGED" "$ENVF" || true # keep any settings added by hand
  echo "PORT=$APP_PORT"
  echo "HOST=127.0.0.1"
  echo "BASE_URL=https://$DOMAIN"
  echo "DATA_DIR=$APP/shared/data"
  echo "TTS_URL=http://127.0.0.1:$TTS_PORT"
  echo "COOKIE_SECURE=true"
  echo "TRUST_PROXY=true"
  echo "ZARINPAL_MERCHANT_ID=${ZARINPAL_MERCHANT_ID:-}"
  echo "GEMINI_API_KEY=${GEMINI_API_KEY:-}"
  for v in ZARINPAL_SANDBOX GEMINI_IMAGE_MODEL GEMINI_TTS_MODEL PLAN_MONTHLY_TOMAN PLAN_QUARTERLY_TOMAN AVATAR_DAILY_LIMIT AVATAR_FREE_LIMIT AVATAR_SUBSCRIBER_LIMIT AVATAR_UNLIMITED_LOGINS; do
    [ -n "${!v:-}" ] && echo "$v=${!v}"
  done
} > "$ENVF.new"
mv "$ENVF.new" "$ENVF"
chown root:avatar "$ENVF"
chmod 640 "$ENVF"
ln -sfn "$ENVF" "$REL/.env"

# ---------- text-to-speech (Piper) ----------
VENV="$APP/shared/venv"
if [ ! -x "$VENV/bin/python" ]; then
  log "Creating Python environment for the voice service"
  python3 -m venv "$VENV"
fi
# Read the version first: `pip show | grep -q` can fail under pipefail when grep exits early.
installed=$("$VENV/bin/pip" show piper-tts 2>/dev/null | awk '/^Version:/ {print $2}' || true)
if [ "$installed" != "$PIPER_VERSION" ]; then
  log "Installing Piper $PIPER_VERSION"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q "piper-tts==$PIPER_VERSION"
fi
# onnx lets Piper report phoneme timings, which drive the avatar's lip-sync.
"$VENV/bin/python" -c 'import onnx' 2>/dev/null || {
  log "Installing onnx (phoneme timings)"
  "$VENV/bin/pip" install -q onnx
}
for voice in "${VOICES[@]}"; do
  if [ ! -f "$APP/shared/voices/$voice.onnx" ]; then
    log "Downloading voice $voice"
    "$VENV/bin/python" -m piper.download_voices --download-dir "$APP/shared/voices" "$voice" >/dev/null 2>&1 \
      || warn "Voice $voice could not be downloaded"
  fi
done
# Lip-sync needs the time of every phoneme, one extra output of the voice model. It is added to the files
# once here: adding it in memory on every load needs more memory than this server has.
to_patch=()
for voice in "${VOICES[@]}"; do
  model="$APP/shared/voices/$voice.onnx"
  [ -f "$model" ] && [ ! -f "$model.aligned" ] && to_patch+=("$model")
done
if [ ${#to_patch[@]} -gt 0 ]; then
  systemctl stop avatar-tts 2>/dev/null || true
  for model in "${to_patch[@]}"; do
    log "Adding phoneme timings to $(basename "$model")"
    if "$VENV/bin/python" -m piper.patch_voice_with_alignment "$model" >/dev/null 2>&1; then
      touch "$model.aligned"
    else
      warn "Could not add phoneme timings to $(basename "$model")"
    fi
  done
fi

# ---------- services ----------
cat > /etc/systemd/system/avatar-tts.service <<EOF
[Unit]
Description=My Avatar text-to-speech (Piper)
After=network.target

[Service]
User=avatar
WorkingDirectory=$APP/current
ExecStart=$VENV/bin/python $APP/current/tts/server.py --host 127.0.0.1 --port $TTS_PORT --voices-dir $APP/shared/voices --max-loaded 1
Restart=always
RestartSec=3
Nice=10
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/avatar-web.service <<EOF
[Unit]
Description=My Avatar web app
After=network.target avatar-tts.service

[Service]
User=avatar
WorkingDirectory=$APP/current
Environment=NODE_ENV=production
ExecStart=$NODE --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
ReadWritePaths=$APP/shared/data

[Install]
WantedBy=multi-user.target
EOF

log "Switching to the new release"
ln -sfn "$REL" "$APP/current"
systemctl daemon-reload
systemctl enable -q avatar-tts avatar-web
systemctl restart avatar-tts avatar-web

# Keep the three most recent releases.
ls -1dt "$APP"/releases/* | tail -n +4 | xargs -r rm -rf

# ---------- nginx + HTTPS ----------
NGINX_DUMP=$(nginx -T 2>/dev/null || true)
if grep -q 'ssl_preread' <<<"$NGINX_DUMP"; then
  fail "nginx routes port 443 by SNI (stream module); the site block must be added by hand"
fi
if grep -q 'include /etc/nginx/sites-enabled' <<<"$NGINX_DUMP"; then
  SITE=/etc/nginx/sites-available/avatar.conf
  LINK=/etc/nginx/sites-enabled/avatar.conf
else
  SITE=/etc/nginx/conf.d/avatar.conf
  LINK=""
fi
if grep -E "server_name[^;]*[[:space:]]$DOMAIN[[:space:];]" <<<"$NGINX_DUMP" | grep -vq "avatar-managed"; then
  fail "Another nginx site already serves $DOMAIN; not touching it"
fi

write_site() { # $1 = with_tls (0/1)
  {
    echo "# avatar-managed: generated by deploy/install.sh, do not edit"
    cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN; # avatar-managed

    location /.well-known/acme-challenge/ { root $ACME_ROOT; }
EOF
    if [ "$1" = 1 ]; then
      echo '    location / { return 301 https://$host$request_uri; }'
    else
      cat <<EOF
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
EOF
    fi
    echo "}"
    if [ "$1" = 1 ]; then
      cat <<EOF

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN; # avatar-managed

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;

    client_max_body_size 5m;
    # Slow connections (uploads are often throttled) get more time between packets of a photo upload.
    client_body_timeout 120s;
    gzip on;
    gzip_types text/css application/javascript text/javascript application/json application/wasm image/svg+xml;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 180s;
    }
}
EOF
    fi
  } > "$SITE.new"
}

apply_site() {
  local backup=""
  [ -f "$SITE" ] && backup=$(mktemp) && cp "$SITE" "$backup"
  mv "$SITE.new" "$SITE"
  [ -n "$LINK" ] && ln -sfn "$SITE" "$LINK"
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    [ -n "$backup" ] && rm -f "$backup"
    return 0
  fi
  nginx -t 2>&1 | tail -3 | sed 's/^/    /'
  if [ -n "$backup" ]; then mv "$backup" "$SITE"; else rm -f "$SITE"; [ -n "$LINK" ] && rm -f "$LINK"; fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  return 1
}

mkdir -p "$ACME_ROOT"
CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
if [ ! -f "$CERT" ]; then
  log "Configuring nginx for $DOMAIN (HTTP) to request a certificate"
  write_site 0
  apply_site || fail "nginx rejected the HTTP site configuration (rolled back)"
  log "DNS for $DOMAIN resolves to: $(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')"
  log "Requesting a Let's Encrypt certificate"
  if ! certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" --non-interactive --agree-tos \
      --register-unsafely-without-email --deploy-hook "systemctl reload nginx" >/tmp/avatar-certbot.log 2>&1; then
    tail -5 /tmp/avatar-certbot.log | sed 's/^/    /'
    fail "Could not get a certificate. Check that $DOMAIN points to this server, then deploy again. The site is reachable over plain http meanwhile (camera needs https)."
  fi
fi
log "Configuring nginx for https://$DOMAIN"
write_site 1
apply_site || fail "nginx rejected the HTTPS site configuration (rolled back)"

# ---------- health checks ----------
sleep 2
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/api/auth/me" || true)
[ "$code" = 200 ] && log "Web app: OK" || fail "Web app is not responding (HTTP $code); see: journalctl -u avatar-web"
code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true)
[ "$code" = 200 ] && log "HTTPS via nginx: OK" || warn "HTTPS check returned HTTP $code"
for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://127.0.0.1:$TTS_PORT/health" && break
  sleep 1
done
voices=$(curl -s "http://127.0.0.1:$TTS_PORT/voices" | grep -o '"id"' | wc -l || true)
[ "$voices" -gt 0 ] && log "Voice service: OK ($voices voices)" || warn "Voice service is not ready yet; see: journalctl -u avatar-tts"
zp=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' \
  https://payment.zarinpal.com/pg/v4/payment/request.json || true)
case "$zp" in
  000) warn "ZarinPal API is not reachable from this server (connection failed/timed out)" ;;
  403) warn "ZarinPal API refused this server (HTTP 403) — it may block non-Iranian IPs" ;;
  *) log "ZarinPal API reachable (HTTP $zp)" ;;
esac
[ -n "${GEMINI_API_KEY:-}" ] && log "Gemini key: configured" || warn "GEMINI_API_KEY is empty; 3D characters are disabled"
log "Done: https://$DOMAIN"
