import express from 'express';
import db, { appendAudit, tx } from '../db.js';
import { requireRole } from '../auth.js';
import { query, queryOne, transaction } from '../sqlserver.js';
import { registrarAuditoria } from '../auditoria.js';

const ROLES = ['administrador', 'fiscal', 'conferente'];
const STATUSES = ['pendente', 'ativo', 'inativo'];

const router = express.Router();
const adminOnly = requireRole('administrador');
const adminOrFiscal = requireRole('administrador', 'fiscal');

/* ---------- Usuários (SQL Server) ---------- */
// Admin e fiscal listam usuários. Fiscal só ajusta filial/setor (não papel/status).
router.get('/users', adminOrFiscal, async (req, res) => {
  const rows = await query(`
    SELECT LOGIN, NOME, PAPEL, SITUACAO, FILIAL, SETOR, CRIADO_EM, ULTIMO_LOGIN
    FROM dbo.KING_PORTAL_ENTRADAS_USUARIOS
    ORDER BY CASE WHEN SITUACAO = 'pendente' THEN 0 ELSE 1 END, NOME
  `);
  res.json({
    users: rows.map(r => ({
      login: r.LOGIN,
      name: r.NOME,
      role: r.PAPEL,
      status: r.SITUACAO,
      filial: r.FILIAL,
      setor: r.SETOR,
      created_at: r.CRIADO_EM,
      last_login: r.ULTIMO_LOGIN,
    })),
  });
});

// Filiais existentes na ENTRADAS — alimentam o select do cadastro de usuário.
// Não há mais catálogo próprio de filial: a fonte é o Linx.
router.get('/filiais', adminOrFiscal, async (req, res) => {
  const rows = await query(`
    SELECT DISTINCT LTRIM(RTRIM(FILIAL)) AS FILIAL
    FROM dbo.ENTRADAS
    WHERE FILIAL IS NOT NULL AND LTRIM(RTRIM(FILIAL)) <> ''
    ORDER BY FILIAL
  `);
  res.json({ items: rows.map(r => r.FILIAL) });
});

// Setores já usados — servem de sugestão; o campo aceita texto livre.
router.get('/setores', adminOrFiscal, async (req, res) => {
  const rows = await query(`
    SELECT DISTINCT SETOR FROM dbo.KING_PORTAL_ENTRADAS_USUARIOS
    WHERE SETOR IS NOT NULL AND SETOR <> '' ORDER BY SETOR
  `);
  res.json({ items: rows.map(r => r.SETOR) });
});

router.patch('/users/:login', adminOrFiscal, async (req, res) => {
  const admin = req.session.user;
  const login = String(req.params.login).toLowerCase();
  const user = await queryOne(`
    SELECT LOGIN, NOME, PAPEL, SITUACAO, FILIAL, SETOR
    FROM dbo.KING_PORTAL_ENTRADAS_USUARIOS WHERE LOGIN = @login
  `, { login });
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

  const { role, status, filial, setor } = req.body || {};
  // Fiscal só pode ajustar filial/setor — nunca papel ou status.
  if (admin.role === 'fiscal' && (role !== undefined || status !== undefined)) {
    return res.status(403).json({ error: 'Fiscal não pode alterar papel ou status de usuários.' });
  }
  if (role != null && !ROLES.includes(role)) return res.status(400).json({ error: 'Papel inválido.' });
  if (status != null && !STATUSES.includes(status)) return res.status(400).json({ error: 'Status inválido.' });

  // Trava anti-lockout: admin não pode se rebaixar nem se desativar.
  if (login === admin.login) {
    if (role != null && role !== 'administrador') return res.status(400).json({ error: 'Você não pode remover seu próprio papel de administrador.' });
    if (status != null && status !== 'ativo') return res.status(400).json({ error: 'Você não pode desativar a própria conta.' });
  }
  // A filial precisa existir na ENTRADAS — não há catálogo próprio.
  if (filial) {
    const existe = await queryOne(`
      SELECT TOP 1 1 AS ok FROM dbo.ENTRADAS
      WHERE LTRIM(RTRIM(FILIAL)) = @filial
    `, { filial: String(filial).trim() });
    if (!existe) return res.status(400).json({ error: 'Filial inexistente na base do Linx.' });
  }

  const antes = { papel: user.PAPEL, situacao: user.SITUACAO, filial: user.FILIAL, setor: user.SETOR };
  const depois = {
    papel: role !== undefined ? role : user.PAPEL,
    situacao: status !== undefined ? status : user.SITUACAO,
    filial: filial !== undefined ? (String(filial).trim() || null) : user.FILIAL,
    setor: setor !== undefined ? (String(setor).trim() || null) : user.SETOR,
  };
  const agora = new Date();

  await transaction(async run => {
    await run(`
      UPDATE dbo.KING_PORTAL_ENTRADAS_USUARIOS
      SET PAPEL = @papel, SITUACAO = @situacao, FILIAL = @filial, SETOR = @setor,
          ATUALIZADO_EM = @agora
      WHERE LOGIN = @login
    `, { ...depois, agora, login });
    await registrarAuditoria(run, {
      ocorridoEm: agora,
      usuarioLogin: admin.login,
      usuarioNome: admin.name,
      acao: 'Usuário atualizado (papel/acesso)',
      observacao: `Alvo: ${user.NOME} (${login}).`,
      detalhe: { alvo: login, antes, depois },
    });
  });
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
