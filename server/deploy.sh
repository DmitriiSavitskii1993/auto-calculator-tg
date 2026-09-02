#!/usr/bin/env bash
# Деплой сервиса wtcars на прод (по образцу poster_saas/deploy.sh).
#
#   ./server/deploy.sh            # выкатить код и перезапустить сервис
#   ./server/deploy.sh --dry-run  # показать, что изменится, ничего не трогая
#
# Сервер: ssh-хост "publiosmm" (из ~/.ssh/config), код в /root/wtcars.
# .env, venv и локальную SQLite НИКОГДА не перезаписываем — они в исключениях.
set -euo pipefail

HOST="publiosmm"
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_APP="$BASE/wtcars/"
LOCAL_OPS="$BASE/deploy/"
REMOTE="/root/wtcars/"
SERVICE="wtcars-api"

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="-n"

echo "==> rsync ${DRY:+(dry-run) }код → $HOST:$REMOTE"
rsync -az $DRY --itemize-changes --no-owner --no-group --delete-after \
  --exclude '.git/' --exclude 'venv/' --exclude '__pycache__/' --exclude '*.pyc' \
  --exclude '.env' --exclude '*.db' --exclude '*.db-shm' --exclude '*.db-wal' \
  --exclude 'logs/' --exclude '*.log' \
  -e "ssh -o BatchMode=yes" \
  "$LOCAL_APP" "$HOST:$REMOTE"

# server/deploy/ (юнит, nginx-фрагмент, bootstrap.sh) — отдельная папка,
# rsync выше её не трогает. Синкаем и её, чтобы правки в юните/nginx не
# требовали ручного docs-копирования на сервер.
echo "==> rsync ${DRY:+(dry-run) }deploy-артефакты → $HOST:${REMOTE}deploy/"
rsync -az $DRY --itemize-changes --no-owner --no-group \
  -e "ssh -o BatchMode=yes" \
  "$LOCAL_OPS" "$HOST:${REMOTE}deploy/"

if [ -n "$DRY" ]; then
  echo "==> dry-run: ничего не изменено."
  exit 0
fi

echo "==> зависимости и миграции"
ssh -o BatchMode=yes "$HOST" bash -euo pipefail <<'REMOTE_CMDS'
  cd /root/wtcars
  if [ ! -x venv/bin/pip ]; then
    echo "venv не найден — на сервере ещё не запускался deploy/bootstrap.sh" >&2
    exit 1
  fi
  ./venv/bin/pip install -q -r requirements.txt
  ./venv/bin/alembic upgrade head
REMOTE_CMDS

echo "==> перезапуск: $SERVICE"
ssh -o BatchMode=yes "$HOST" \
  "systemctl restart $SERVICE && sleep 2 && systemctl is-active $SERVICE"

echo "==> проверка здоровья"
curl -fsS https://publiosmm.ru/wtapi/health && echo
echo "==> готово."
