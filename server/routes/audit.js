import express from 'express';
import { query } from '../sqlserver.js';
import { verificarCadeia } from '../auditoria.js';
import { requireRole } from '../auth.js';

const router = express.Router();
// Auditoria é só para fiscal e administrador (conferente não vê logs).
router.use(requireRole('fiscal', 'administrador'));

function mapEvent(r) {
  return {
    seq: Number(r.SEQ),
    at: r.OCORRIDO_EM,
    user: r.USUARIO_NOME,
    login: r.USUARIO_LOGIN,
    sector: r.SETOR_ORIGEM,
    origin: r.SETOR_ORIGEM,
    destination: r.SETOR_DESTINO,
    action: r.ACAO,
    protocol: r.PROTOCOLO,
    invoice: r.NF_ENTRADA,
    // O front usa este campo para abrir o documento: a identidade é a chave.
    documentId: r.CHAVE_NFE,
    note: r.OBSERVACAO,
    hash: r.HASH?.trim(),
  };
}

// GET /api/audit — ledger completo (mais recente primeiro).
router.get('/', async (req, res) => {
  const rows = await query(`
    SELECT a.*, n.NF_ENTRADA
    FROM dbo.KING_PORTAL_ENTRADAS_AUDITORIA a
    LEFT JOIN dbo.VW_KING_PORTAL_NOTAS n ON n.CHAVE_NFE = a.CHAVE_NFE
    ORDER BY a.SEQ DESC
  `);
  res.json({ events: rows.map(mapEvent) });
});

// GET /api/audit/verify — confere integridade da cadeia de hashes.
router.get('/verify', async (req, res) => {
  res.json(await verificarCadeia());
});

// GET /api/audit/export — CSV (BOM + separador ; para Excel PT-BR).
router.get('/export', async (req, res) => {
  const rows = await query(`
    SELECT SEQ, OCORRIDO_EM, PROTOCOLO, CHAVE_NFE, USUARIO_NOME, USUARIO_LOGIN,
           SETOR_ORIGEM, SETOR_DESTINO, ACAO, OBSERVACAO, HASH
    FROM dbo.KING_PORTAL_ENTRADAS_AUDITORIA ORDER BY SEQ ASC
  `);
  const headers = ['Seq', 'Data e hora', 'Protocolo', 'Chave NF-e', 'Usuário', 'Login',
                   'Setor origem', 'Setor destino', 'Ação', 'Observação', 'Hash'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(';')];
  for (const r of rows) {
    lines.push([
      r.SEQ, r.OCORRIDO_EM?.toISOString?.() ?? r.OCORRIDO_EM, r.PROTOCOLO, r.CHAVE_NFE,
      r.USUARIO_NOME, r.USUARIO_LOGIN, r.SETOR_ORIGEM, r.SETOR_DESTINO,
      r.ACAO, r.OBSERVACAO, r.HASH?.trim(),
    ].map(esc).join(';'));
  }
  const csv = '﻿' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="log-auditoria-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.end(csv);
});

export default router;
