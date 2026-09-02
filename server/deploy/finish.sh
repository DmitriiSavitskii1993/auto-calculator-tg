#!/usr/bin/env bash
# Часть 2 из 2: миграции + systemd + nginx. Запускается НА СЕРВЕРЕ от root,
# ПОСЛЕ того как /root/wtcars/.env заполнен настоящими значениями:
#
#     bash /root/wtcars/deploy/finish.sh
#
# Отказывается запускать миграции, если .env всё ещё смотрит на SQLite или
# токен/секрет не заполнены — иначе прод молча накатится не на ту базу
# (см. комментарий в начале bootstrap.sh).
set -euo pipefail

APP_DIR="/root/wtcars"
ENV_FILE="$APP_DIR/.env"

say() { echo -e "\n\033[1m==> $*\033[0m"; }

[ -f "$ENV_FILE" ] || { echo "нет $ENV_FILE — сначала bootstrap.sh, потом заполни .env" >&2; exit 1; }

# --- проверка .env ----------------------------------------------------------
say "проверка .env"
get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }

DB_URL="$(get DATABASE_URL)"
BOT_TOKEN="$(get WT_BOT_TOKEN)"
JWT_SECRET="$(get WT_JWT_SECRET)"

fail=0
case "$DB_URL" in
  postgresql*) : ;;
  *) echo "  ✗ DATABASE_URL не похож на Postgres (сейчас: ${DB_URL:-пусто})"; fail=1 ;;
esac
[ -n "$BOT_TOKEN" ] || { echo "  ✗ WT_BOT_TOKEN пуст"; fail=1; }
[ ${#JWT_SECRET} -ge 20 ] || { echo "  ✗ WT_JWT_SECRET пуст или короче 20 символов"; fail=1; }

if [ "$fail" -eq 1 ]; then
  echo
  echo "заполни $ENV_FILE и запусти finish.sh снова" >&2
  exit 1
fi
echo "  ✓ DATABASE_URL, WT_BOT_TOKEN, WT_JWT_SECRET заполнены"

# --- миграции ----------------------------------------------------------
say "миграции на $(echo "$DB_URL" | sed -E 's#://[^@]+@#://***@#')"
cd "$APP_DIR" && ./venv/bin/alembic upgrade head

# --- systemd -----------------------------------------------------------
say "systemd"
cp "$APP_DIR/deploy/wtcars-api.service" /etc/systemd/system/wtcars-api.service
systemctl daemon-reload
systemctl enable --now wtcars-api
sleep 2
systemctl is-active wtcars-api

# --- nginx ---------------------------------------------------------------
say "nginx"
SITE=/etc/nginx/sites-available/publiosmm
if grep -q "location /wtapi/" "$SITE"; then
  echo "location /wtapi/ уже есть"
else
  cp "$SITE" "$SITE.bak-$(date +%Y%m%d-%H%M%S)"
  grep -q "zone=wt_api" /etc/nginx/nginx.conf \
    || sed -i '/limit_req_zone .*publio_hook/a \\tlimit_req_zone $binary_remote_addr zone=wt_api:10m rate=10r/s;' /etc/nginx/nginx.conf
  # Вставляем блок перед последним "location / {" в 443-серверблоке
  python3 - "$SITE" "$APP_DIR/deploy/nginx-wtcars.conf" <<'PY'
import re, sys
site_path, frag_path = sys.argv[1], sys.argv[2]
site = open(site_path).read()
frag = "\n".join(
    l for l in open(frag_path).read().splitlines() if not l.strip().startswith("#")
).strip()
anchor = site.rindex("    location / {")
open(site_path, "w").write(site[:anchor] + "    " + frag.replace("\n", "\n    ") + "\n\n" + site[anchor:])
PY
  if nginx -t; then
    systemctl reload nginx && echo "nginx перезагружен"
  else
    echo "nginx -t провалился — конфиг откачен из бэкапа" >&2
    cp "$SITE.bak-"* "$SITE" 2>/dev/null || true
    exit 1
  fi
fi

say "готово"
curl -fsS http://127.0.0.1:8082/wtapi/health && echo
echo "снаружи:  curl -s https://publiosmm.ru/wtapi/health"
free -m
