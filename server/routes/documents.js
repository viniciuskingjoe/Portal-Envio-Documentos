import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db, { appendAudit, tx } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const STATUSES = ['Aguardando análise', 'Conferido', 'Pendente', 'Lançamento incorreto'];
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.includes(file.mimetype)),
});

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function generateProtocol() {
  const year = new Date().getFullYear();
  const row = db.prepare(
    `SELECT protocol FROM documents WHERE protocol LIKE ? ORDER BY protocol DESC LIMIT 1`
  ).get(`PROT-${year}-%`);
  const last = row ? Number(row.protocol.match(/(\d+)$/)?.[1] || 1000) : 1000;
  return `PROT-${year}-${String(last + 1).padStart(6, '0')}`;
}

// Histórico de um documento = eventos do ledger append-only filtrados por doc.
const historyStmt = db.prepare(
  `SELECT at, user_name, sector_origin, sector_destination, action, note
   FROM audit_log WHERE document_id = ? ORDER BY seq ASC`
);
function historyFor(documentId) {
  return historyStmt.all(documentId).map(r => ({
    action: r.action,
    user: r.user_name,
    sector: r.sector_origin,
    origin: r.sector_origin,
    destination: r.sector_destination,
    note: r.note,
    at: r.at,
  }));
}

function mapDoc(row, withHistory = false) {
  const doc = {
    id: row.id,
    protocol: row.protocol,
    invoice: row.invoice,
    branch: row.branch,
    origin: row.origin,
    destination: row.destination,
    supplier: row.supplier,
    amount: row.amount,
    status: row.status,
    responsible: row.responsible,
    responsibleLogin: row.responsible_login,
    initials: row.responsible.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase(),
    fileName: row.file_name,
    fileSize: row.file_size,
    hasFile: !!row.file_path,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (withHistory) doc.history = historyFor(row.id);
  return doc;
}

const router = express.Router();
router.use(requireAuth);

// GET /api/documents — lista com histórico embutido (front usa doc.history).
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM documents ORDER BY updated_at DESC').all();
  res.json({ documents: rows.map(r => mapDoc(r, true)) });
});

// GET /api/documents/:id
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Documento não encontrado.' });
  res.json({ document: mapDoc(row, true) });
});

// GET /api/documents/:id/file — visualizar/baixar anexo.
router.get('/:id/file', (req, res) => {
  const row = db.prepare('SELECT file_path, file_name, mime FROM documents WHERE id = ?').get(req.params.id);
  if (!row?.file_path || !fs.existsSync(row.file_path)) {
    return res.status(404).json({ error: 'Arquivo não encontrado.' });
  }
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.file_name || 'documento')}"`);
  fs.createReadStream(row.file_path).pipe(res);
});

// POST /api/documents — cria protocolo + anexo + evento de auditoria (atômico).
// Só conferente/admin. Filial e setor de origem vêm da lotação do usuário
// (definida pelo admin), não do cliente — evita adulteração da origem.
router.post('/', requireRole('conferente', 'administrador'), upload.single('file'), (req, res) => {
  const user = req.session.user;
  const { invoice, supplier, amount, notes } = req.body || {};
  const branch = user.branch;
  const origin = user.sector;
  if (!branch || !origin) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Sua filial e setor ainda não foram definidos pelo administrador.' });
  }
  if (!invoice?.trim() || !supplier?.trim()) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Nota fiscal e fornecedor são obrigatórios.' });
  }

  const now = new Date().toISOString();
  const id = `doc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  try {
    const created = tx(() => {
      const protocol = generateProtocol();
      db.prepare(`
        INSERT INTO documents
          (id, protocol, invoice, branch, origin, destination, supplier, amount, status,
           responsible, responsible_login, file_name, file_path, file_size, mime, notes, created_at, updated_at)
        VALUES
          (@id, @protocol, @invoice, @branch, @origin, 'Fiscal', @supplier, @amount, 'Aguardando análise',
           @responsible, @responsible_login, @file_name, @file_path, @file_size, @mime, @notes, @now, @now)
      `).run({
        id, protocol,
        invoice: invoice.trim(),
        branch, origin,
        supplier: supplier.trim(),
        amount: amount?.trim() || 'Não informado',
        responsible: user.name,
        responsible_login: user.login,
        file_name: req.file?.originalname || null,
        file_path: req.file?.path || null,
        file_size: req.file ? formatFileSize(req.file.size) : null,
        mime: req.file?.mimetype || null,
        notes: notes?.trim() || 'Sem observações adicionais.',
        now,
      });
      appendAudit({
        at: now,
        user_login: user.login,
        user_name: user.name,
        sector_origin: origin,
        sector_destination: 'Fiscal',
        action: 'Documento protocolado e encaminhado',
        protocol,
        document_id: id,
        note: req.file
          ? `Arquivo ${req.file.originalname} anexado e encaminhado para conferência.`
          : 'Documento encaminhado para conferência.',
        detail: { invoice: invoice.trim(), branch, supplier: supplier.trim() },
      });
      return protocol;
    })();

    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    res.status(201).json({ document: mapDoc(row, true), protocol: created });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Falha ao registrar documento.', detail: err.message });
  }
});

// POST /api/documents/:id/status — nova movimentação (muda status + audita).
// Só fiscal/admin conferem e alteram status.
router.post('/:id/status', requireRole('fiscal', 'administrador'), (req, res) => {
  const user = req.session.user;
  const { status, note } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Status inválido.' });
  if (!note?.trim()) return res.status(400).json({ error: 'Observação da movimentação é obrigatória.' });

  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Documento não encontrado.' });

  const now = new Date().toISOString();
  // Destino do fluxo: se devolvido (pendente/incorreto), volta ao setor de origem;
  // se conferido/em análise, permanece no Fiscal.
  const destination = ['Pendente', 'Lançamento incorreto'].includes(status) ? doc.origin : 'Fiscal';

  tx(() => {
    db.prepare('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?').run(status, now, doc.id);
    appendAudit({
      at: now,
      user_login: user.login,
      user_name: user.name,
      sector_origin: user.sector || 'Fiscal',
      sector_destination: destination,
      action: `Status alterado de ${doc.status} para ${status}`,
      protocol: doc.protocol,
      document_id: doc.id,
      note: note.trim(),
      detail: { from: doc.status, to: status },
    });
  })();

  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
  res.json({ document: mapDoc(row, true) });
});

export default router;
