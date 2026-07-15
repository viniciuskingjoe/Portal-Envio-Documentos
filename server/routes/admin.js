import express from 'express';
import db, { appendAudit, tx } from '../db.js';
import { requireRole } from '../auth.js';

const ROLES = ['administrador', 'fiscal', 'conferente'];
const STATUSES = ['pendente', 'ativo', 'inativo'];

const router = express.Router();
const adminOnly = requireRole('administrador');
const adminOrFiscal = requireRole('administrador', 'fiscal');

/* ---------- Usuários (só administrador) ---------- */
router.get('/users', adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT u.login, u.name, u.role, u.status, u.branch_id, u.sector_id,
           b.name AS branch, s.name AS sector, u.created_at, u.last_login
    FROM users u
    LEFT JOIN branches b ON b.id = u.branch_id
    LEFT JOIN sectors  s ON s.id = u.sector_id
    ORDER BY u.status='pendente' DESC, u.name ASC
  `).all();
  res.json({ users: rows });
});

router.patch('/users/:login', adminOnly, (req, res) => {
  const admin = req.session.user;
  const login = String(req.params.login).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const { role, status, branchId, sectorId } = req.body || {};
  if (role != null && !ROLES.includes(role)) return res.status(400).json({ error: 'Papel inválido.' });
  if (status != null && !STATUSES.includes(status)) return res.status(400).json({ error: 'Status inválido.' });

  // Trava anti-lockout: admin não pode se rebaixar nem se desativar.
  if (login === admin.login) {
    if (role != null && role !== 'administrador') return res.status(400).json({ error: 'Você não pode remover seu próprio papel de administrador.' });
    if (status != null && status !== 'ativo') return res.status(400).json({ error: 'Você não pode desativar a própria conta.' });
  }
  if (branchId != null && branchId !== null && !db.prepare('SELECT 1 FROM branches WHERE id = ?').get(branchId)) {
    return res.status(400).json({ error: 'Filial inexistente.' });
  }
  if (sectorId != null && sectorId !== null && !db.prepare('SELECT 1 FROM sectors WHERE id = ?').get(sectorId)) {
    return res.status(400).json({ error: 'Setor inexistente.' });
  }

  const before = { role: user.role, status: user.status, branch_id: user.branch_id, sector_id: user.sector_id };
  const next = {
    role: role !== undefined ? role : user.role,
    status: status !== undefined ? status : user.status,
    branch_id: branchId !== undefined ? branchId : user.branch_id,
    sector_id: sectorId !== undefined ? sectorId : user.sector_id,
    now: new Date().toISOString(),
    login,
  };
  tx(() => {
    db.prepare('UPDATE users SET role=@role, status=@status, branch_id=@branch_id, sector_id=@sector_id, updated_at=@now WHERE login=@login').run(next);
    appendAudit({
      at: next.now, user_login: admin.login, user_name: admin.name,
      action: 'Usuário atualizado (papel/acesso)',
      note: `Alvo: ${user.name} (${login}).`,
      detail: { target: login, before, after: { role: next.role, status: next.status, branch_id: next.branch_id, sector_id: next.sector_id } },
    });
  })();
  res.json({ ok: true });
});

/* ---------- Filiais e Setores (genérico) ---------- */
function makeCatalog(table, labelSingular) {
  const r = express.Router();
  r.get('/', (req, res) => res.json({ items: db.prepare(`SELECT id, name, active FROM ${table} ORDER BY name`).all() }));

  r.post('/', (req, res) => {
    const admin = req.session.user;
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: `Nome do ${labelSingular} é obrigatório.` });
    if (db.prepare(`SELECT 1 FROM ${table} WHERE name = ?`).get(name)) return res.status(409).json({ error: 'Já existe com esse nome.' });
    const now = new Date().toISOString();
    let id;
    tx(() => {
      id = Number(db.prepare(`INSERT INTO ${table} (name, active) VALUES (?, 1)`).run(name).lastInsertRowid);
      appendAudit({ at: now, user_login: admin.login, user_name: admin.name, action: `${labelSingular} cadastrado`, note: name, detail: { table, id, name } });
    })();
    res.status(201).json({ id, name, active: 1 });
  });

  r.patch('/:id', (req, res) => {
    const admin = req.session.user;
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Não encontrado.' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : row.name;
    const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : row.active;
    if (!name) return res.status(400).json({ error: 'Nome não pode ser vazio.' });
    if (name !== row.name && db.prepare(`SELECT 1 FROM ${table} WHERE name = ?`).get(name)) return res.status(409).json({ error: 'Já existe com esse nome.' });
    const now = new Date().toISOString();
    tx(() => {
      db.prepare(`UPDATE ${table} SET name = ?, active = ? WHERE id = ?`).run(name, active, id);
      appendAudit({ at: now, user_login: admin.login, user_name: admin.name, action: `${labelSingular} atualizado`, note: name, detail: { table, id, before: { name: row.name, active: row.active }, after: { name, active } } });
    })();
    res.json({ id, name, active });
  });

  return r;
}

// Filiais e setores: administrador E fiscal podem gerenciar.
router.use('/branches', adminOrFiscal, makeCatalog('branches', 'Filial'));
router.use('/sectors', adminOrFiscal, makeCatalog('sectors', 'Setor'));

export default router;
