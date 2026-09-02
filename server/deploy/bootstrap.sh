#!/usr/bin/env bash
# Часть 1 из 2: подготовка сервера под сервис wtcars, БЕЗ автозапуска
# миграций/systemd/nginx. Запускается НА СЕРВЕРЕ от root:
#
#     bash /root/wtcars/deploy/bootstrap.sh
#
# Скрипт идемпотентен: повторный запуск ничего не ломает.
# Он не перезапускает PublioSMM и не трогает его конфиги.
#
# После него — заполнить /root/wtcars/.env (DATABASE_URL на Postgres,
# WT_BOT_TOKEN, WT_JWT_SECRET) и запустить finish.sh. Это разнесено
# намеренно: раньше здесь же сразу шли миграции, и при первом запуске они
# успевали накатиться на дефолтную SQLite из .env.example ДО того, как
# оператор пропишет настоящий Postgres — сервис поднимался бы на не той базе
# с пустым токеном бота, и это осталось бы незамеченным.
set -euo pipefail

DB_NAME="wtcars"
DB_USER="wtcars"
APP_DIR="/root/wtcars"
STORAGE="/var/lib/wtcars"
SWAPFILE="/swapfile"
SWAPSIZE_MB=2048

say() { echo -e "\n\033[1m==> $*\033[0m"; }

# --- 1. swap ---------------------------------------------------------------
# На машине 968 МБ RAM без свопа, и три боевых процесса PublioSMM уже держат
# ~440 МБ. Четвёртый сервис без свопа — это риск, что OOM-killer выберет
# боевого бота. 2 ГБ свопа на диске, где свободно 20 ГБ, снимают вопрос.
say "swap"
if swapon --show | grep -q "$SWAPFILE"; then
  echo "swap уже включён:"; swapon --show
else
  fallocate -l "${SWAPSIZE_MB}M" "$SWAPFILE" || dd if=/dev/zero of="$SWAPFILE" bs=1M count="$SWAPSIZE_MB"
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE"
  swapon "$SWAPFILE"
  grep -q "^$SWAPFILE" /etc/fstab || echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
  # Своп как страховка, а не как рабочий режим: лезем в него только под конец.
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q "^vm.swappiness" /etc/sysctl.conf || echo "vm.swappiness=10" >> /etc/sysctl.conf
  echo "swap создан:"; swapon --show
fi

# --- 2. база -----------------------------------------------------------
say "postgres: роль и база $DB_NAME"
if sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='$DB_USER'" | grep -q 1; then
  echo "роль $DB_USER уже есть — пароль не меняю (если забыт, сбрось вручную ALTER ROLE)"
else
  DB_PASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
  sudo -u postgres psql -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';"
  echo
  echo "  ЗАПОМНИ (больше нигде не покажу) — строка для $APP_DIR/.env:"
  echo "  DATABASE_URL=postgresql+asyncpg://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME"
  echo
fi
sudo -u postgres psql -tAc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
echo "база $DB_NAME готова"

# --- 3. каталоги -------------------------------------------------------
say "каталоги хранилища"
mkdir -p "$STORAGE"/{photos,kp,tmp}
chmod 750 "$STORAGE"
du -sh "$STORAGE"

# --- 4. venv -------------------------------------------------------------
# Отдельный от PublioSMM: три живых сервиса делят один venv, и подмешивать
# туда anthropic + Pillow ради нашей задачи — лишний риск для прода.
say "venv"
apt-get install -y -q python3-venv >/dev/null 2>&1 || true
[ -d "$APP_DIR/venv" ] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
"$APP_DIR/venv/bin/python" -V

# --- 5. .env ---------------------------------------------------------------
say ".env"
if [ -f "$APP_DIR/.env" ]; then
  echo ".env уже есть — не трогаю"
else
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "создан из .env.example"
  echo "сгенерированный секрет для WT_JWT_SECRET (впиши в .env):"
  echo "  $("$APP_DIR/venv/bin/python" -c 'import secrets;print(secrets.token_urlsafe(48))')"
fi

say "дальше — руками"
cat <<EOF

Прежде чем запускать finish.sh, открой $APP_DIR/.env и впиши:
  DATABASE_URL       — строку выше (postgresql+asyncpg://...), НЕ sqlite
  WT_BOT_TOKEN        — токен бота @wt_car_calc_bot (BotFather → тот же, что в bot/.env / Render)
  WT_JWT_SECRET       — сгенерированный секрет выше

Затем:
  bash $APP_DIR/deploy/finish.sh

finish.sh проверит, что .env заполнен правильно, и только тогда накатит
миграции, поднимет systemd-юнит и допишет nginx.
EOF
