import express from 'express';
import { requireRole } from '../auth.js';
import { query, queryOne, transaction } from '../sqlserver.js';
import { registrarAuditoria } from '../auditoria.js';

const ROLES = ['administrador', 'fiscal', 'conferente'];
const STATUSES = ['pendente', 'ativo', 'inativo'];

const router = express.Router();
const adminOnly = requireRole('administrador');
const adminOrFiscal = requireRole('administrador', 'fiscal');

/* ---------- Usuários (SQL Server) ---------- */
// Admin e fiscal listam usuários. Fiscal só ajusta o setor (não papel/status).
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

  const { role, status, setor } = req.body || {};
  // Fiscal só pode ajustar o setor — nunca papel ou status.
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
  // A filial deixou de ser atributo do usuário: vem da própria nota (ENTRADAS).
  // A coluna continua na tabela apenas por histórico, sem ser editada.
  const antes = { papel: user.PAPEL, situacao: user.SITUACAO, setor: user.SETOR };
  const depois = {
    papel: role !== undefined ? role : user.PAPEL,
    situacao: status !== undefined ? status : user.SITUACAO,
    setor: setor !== undefined ? (String(setor).trim() || null) : user.SETOR,
  };
  const agora = new Date();

  await transaction(async run => {
    await run(`
      UPDATE dbo.KING_PORTAL_ENTRADAS_USUARIOS
      SET PAPEL = @papel, SITUACAO = @situacao, SETOR = @setor, ATUALIZADO_EM = @agora
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

/* Os catálogos próprios de filial e setor deixaram de existir: a filial vem da
   dbo.ENTRADAS (Linx é a fonte) e o setor é campo livre no cadastro do usuário.
   As rotas /branches e /sectors foram removidas junto com o SQLite. */

export default router;
