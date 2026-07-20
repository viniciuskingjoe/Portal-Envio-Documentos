#!/usr/bin/env bash
# Backup do Fluxo Fiscal: banco (ledger de auditoria + documentos) e anexos.
# Usa VACUUM INTO para copiar o SQLite de forma consistente mesmo com WAL ativo
# e o serviço rodando — copiar data.db "na mão" pode gerar arquivo corrompido.
#
# Uso:  ./backup.sh            (destino padrão /var/backups/portal-envio-documentos)
#       DEST=/mnt/nas ./backup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/portal-envio-documentos}"
DEST="${DEST:-/var/backups/portal-envio-documentos}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /usr/bin/node)}"

DB_PATH="${DB_PATH:-$APP_DIR/data.db}"
UPLOADS_DIR="${UPLOADS_DIR:-$APP_DIR/uploads}"

mkdir -p "$DEST"

echo "==> Backup do banco ($DB_PATH)"
if [ ! -f "$DB_PATH" ]; then
  echo "ERRO: banco não encontrado em $DB_PATH" >&2
  exit 1
fi
# VACUUM INTO gera uma cópia íntegra e já compactada do banco.
"$NODE_BIN" -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec(\`VACUUM INTO '\` + process.argv[2].replace(/'/g, \"''\") + \`'\`);
db.close();
" "$DB_PATH" "$DEST/data-$STAMP.db"

echo "==> Backup dos anexos ($UPLOADS_DIR)"
if [ -d "$UPLOADS_DIR" ]; then
  tar -czf "$DEST/uploads-$STAMP.tar.gz" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"
else
  echo "   (sem pasta de uploads, ignorando)"
fi

echo "==> Verificando integridade da cópia"
"$NODE_BIN" -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
const r = db.prepare('PRAGMA integrity_check').get();
db.close();
const ok = Object.values(r)[0];
if (ok !== 'ok') { console.error('FALHA na integridade:', ok); process.exit(1); }
console.log('   integridade: ok');
" "$DEST/data-$STAMP.db"

echo "==> Removendo backups com mais de $KEEP_DAYS dias"
find "$DEST" -name 'data-*.db' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'uploads-*.tar.gz' -mtime "+$KEEP_DAYS" -delete

echo "==> Concluído: $DEST/data-$STAMP.db"
ls -lh "$DEST" | tail -5
