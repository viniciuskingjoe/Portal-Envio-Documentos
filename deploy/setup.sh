#!/usr/bin/env bash
# Deploy do Portal-Envio-Documentos na VM AKR (srvappweb, 192.168.2.150).
# Rodar como usuário king. Pede sudo nos passos de systemd.
# Uso:  bash setup.sh
set -euo pipefail

APP=portal-envio-documentos
DIR=/opt/$APP
REPO=https://github.com/viniciuskingjoe/Portal-Envio-Documentos.git
NODE=/home/king/.nvm/versions/node/v24.18.0/bin/node
NPM=/home/king/.nvm/versions/node/v24.18.0/bin/npm
PORT=3003

echo "==> 1/6 Pasta e código"
if [ ! -d "$DIR/.git" ]; then
  sudo mkdir -p "$DIR"
  sudo chown king:king "$DIR"
  git clone "$REPO" "$DIR"
else
  git -C "$DIR" pull --ff-only
fi
cd "$DIR"

echo "==> 2/6 Node em uso: $($NODE -v)"
"$NODE" -e "require('node:sqlite'); console.log('node:sqlite OK')"

echo "==> 3/6 Dependências"
"$NPM" install --omit=dev --no-audit --no-fund

echo "==> 4/6 .env"
if [ ! -f "$DIR/.env" ]; then
  cp .env.example .env
  SECRET=$("$NODE" -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  # ajusta valores de produção
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
  sed -i "s|^COOKIE_SECURE=.*|COOKIE_SECURE=true|" .env
  sed -i "s|^PORT=.*|PORT=$PORT|" .env
  sed -i "s|^DB_PATH=.*|DB_PATH=$DIR/data.db|" .env
  sed -i "s|^UPLOAD_DIR=.*|UPLOAD_DIR=$DIR/uploads|" .env
  echo "   .env criado (revise LDAP_URL/BASE_DN se necessário)."
else
  echo "   .env já existe — mantido."
fi
# Garante a variável nova em .env antigos (redeploy).
if ! grep -q '^BOOTSTRAP_ADMIN=' "$DIR/.env"; then
  printf '\n# sAMAccountName(s) que viram administrador no 1o acesso (vírgula). Ex: BOOTSTRAP_ADMIN=vlopes\nBOOTSTRAP_ADMIN=\n' >> "$DIR/.env"
  echo "   >> Adicionei BOOTSTRAP_ADMIN vazio no .env. EDITE com seu usuário do dominio antes do 1o acesso!"
fi
mkdir -p "$DIR/uploads"

echo "==> 5/6 systemd"
sudo cp "$DIR/deploy/$APP.service" /etc/systemd/system/$APP.service
sudo systemctl daemon-reload
sudo systemctl enable $APP
sudo systemctl restart $APP   # restart (não enable --now) p/ carregar código novo no redeploy
sleep 1
sudo systemctl --no-pager --lines=8 status $APP || true

echo "==> 6/6 Teste local"
curl -fsS -o /dev/null -w "  GET /login -> HTTP %{http_code}\n" http://localhost:$PORT/login || echo "  falhou o curl local"

cat <<EOF

Pronto no servidor. Falta o passo MANUAL (não automatizável):

  Cloudflare Zero Trust -> túnel portal-modelagem -> Rotas de aplicativos publicados -> Adicionar:
    Subdomain: portal-envio-documentos   Domain: akrbrands.com.br   Path: (vazio)
    Type: HTTP   URL: localhost:$PORT   -> Save

  Se o host não abrir logo após criar: cache NXDOMAIN no DC 192.168.1.4.
    No DC (PowerShell):  Clear-DnsServerCache -Force
    Confirme antes:      nslookup portal-envio-documentos.akrbrands.com.br 1.1.1.1
EOF
