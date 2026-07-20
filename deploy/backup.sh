#!/usr/bin/env bash
# Backup dos anexos do Fluxo Fiscal (os PDFs das notas).
#
# O banco NÃO é copiado aqui: protocolos, auditoria e usuários agora vivem no
# SQL Server (KINGEJOE), coberto pela rotina de backup da instância. Confirme
# com o TI que KINGEJOE está no plano de manutenção — o ledger de auditoria
# depende disso.
#
# Os PDFs ficam no disco da VM e não estão em nenhuma rotina: é o que este
# script protege.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/portal-envio-documentos}"
DEST="${DEST:-/var/backups/portal-envio-documentos}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
UPLOADS_DIR="${UPLOAD_DIR:-$APP_DIR/uploads}"

mkdir -p "$DEST"

if [ ! -d "$UPLOADS_DIR" ]; then
  echo "ERRO: pasta de anexos não encontrada em $UPLOADS_DIR" >&2
  exit 1
fi

echo "==> Compactando anexos ($UPLOADS_DIR)"
tar -czf "$DEST/uploads-$STAMP.tar.gz" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"

echo "==> Verificando o pacote"
tar -tzf "$DEST/uploads-$STAMP.tar.gz" > /dev/null
echo "   $(tar -tzf "$DEST/uploads-$STAMP.tar.gz" | wc -l) arquivo(s)"

echo "==> Removendo backups com mais de $KEEP_DAYS dias"
find "$DEST" -name 'uploads-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
# Limpa também os dumps do SQLite da fase anterior, que não são mais gerados.
find "$DEST" -name 'data-*.db' -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true

echo "==> Concluído: $DEST/uploads-$STAMP.tar.gz"
