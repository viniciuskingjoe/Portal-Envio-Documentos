import express from 'express';
import db, { verifyChain } from '../db.js';
import { requireAuth } from '../auth.js';

const router = express.Router();
router.use(requireAuth);

function mapEvent(r) {
  return {
    seq: r.seq,
    at: r.at,
    user: r.user_name,
    login: r.user_login,
    sector: r.sector_origin,
    origin: r.sector_origin,
    destination: r.sector_destination,
    action: r.action,
    protocol: r.protocol,
    invoice: r.invoice,
    documentId: r.document_id,
    note: r.note,
    hash: r.hash,
  };
}

// GET /api/audit — ledger completo (mais recente primeiro).
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, d.invoice AS invoice
    FROM audit_log a
    LEFT JOIN documents d ON d.id = a.document_id
    ORDER BY a.seq DESC
  `).all();
  res.json({ events: rows.map(mapEvent) });
});

// GET /api/audit/verify — confere integridade da cadeia de hashes.
router.get('/verify', (req, res) => {
  res.json(verifyChain());
});

// GET /api/audit/export — CSV (BOM + separador ; para Excel PT-BR).
router.get('/export', (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all();
  const headers = ['Seq', 'Data e hora', 'Protocolo', 'Usuário', 'Login', 'Setor origem', 'Setor destino', 'Ação', 'Observação', 'Hash'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(';')];
  for (const r of rows) {
    lines.push([r.seq, r.at, r.protocol, r.user_name, r.user_login, r.sector_origin, r.sector_destination, r.action, r.note, r.hash].map(esc).join(';'));
  }
  const csv = '﻿' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="log-auditoria-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.end(csv);
});

export default router;
