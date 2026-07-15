import express from 'express';
import ldap from 'ldapjs';
import db, { appendAudit, tx, hashPassword, verifyPassword } from './db.js';

const LDAP_URL = process.env.LDAP_URL || 'ldap://192.168.1.4:389';
const LDAP_BASE_DN = process.env.LDAP_BASE_DN || 'DC=king,DC=local';
const LDAP_DOMAIN = process.env.LDAP_DOMAIN || 'king.local';
// Logins (sAMAccountName) que viram administrador+ativo no 1º acesso. Resolve o
// ovo-galinha: sem admin ninguém aprova ninguém. Ex: BOOTSTRAP_ADMIN=vlopes,tiadmin
const BOOTSTRAP_ADMIN = (process.env.BOOTSTRAP_ADMIN || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase() || '??';
}

/** Autentica identidade no AD por bind LDAP. Retorna nome do AD ou lança. */
function authenticateAD(username, password) {
  return new Promise((resolve, reject) => {
    if (!username || !password) return reject(new Error('Usuário e senha do domínio são obrigatórios.'));
    const upn = username.includes('@') ? username : `${username}@${LDAP_DOMAIN}`;
    const sam = username.includes('@') ? username.split('@')[0] : username;
    const client = ldap.createClient({ url: LDAP_URL, timeout: 8000, connectTimeout: 8000 });
    client.on('error', err => reject(err));
    client.bind(upn, password, err => {
      if (err) { client.destroy(); return reject(new Error('Credenciais do domínio inválidas.')); }
      const opts = { scope: 'sub', filter: `(sAMAccountName=${sam})`, attributes: ['displayName', 'cn'] };
      client.search(LDAP_BASE_DN, opts, (searchErr, res) => {
        if (searchErr) { client.unbind(); return resolve({ login: sam.toLowerCase(), name: sam }); }
        let entry = null;
        res.on('searchEntry', e => { entry = e.pojo || e.object; });
        res.on('error', () => { client.unbind(); resolve({ login: sam.toLowerCase(), name: sam }); });
        res.on('end', () => {
          client.unbind();
          const attr = {};
          for (const a of entry?.attributes || []) attr[a.type] = a.values?.[0] ?? a.vals?.[0];
          resolve({ login: sam.toLowerCase(), name: attr.displayName || attr.cn || sam });
        });
      });
    });
  });
}

/** Monta o objeto de sessão a partir da linha do usuário (com filial/setor). */
function sessionUserFor(login) {
  const row = db.prepare(`
    SELECT u.login, u.name, u.role, u.status, u.branch_id, u.sector_id,
           b.name AS branch_name, s.name AS sector_name
    FROM users u
    LEFT JOIN branches b ON b.id = u.branch_id
    LEFT JOIN sectors  s ON s.id = u.sector_id
    WHERE u.login = ?
  `).get(login);
  if (!row) return null;
  return {
    login: row.login,
    name: row.name,
    role: row.role,
    status: row.status,
    branchId: row.branch_id,
    sectorId: row.sector_id,
    branch: row.branch_name || null,
    sector: row.sector_name || null,
    initials: initials(row.name),
  };
}

export function requireAuth(req, res, next) {
  if (req.session?.user?.status === 'ativo') return next();
  res.status(401).json({ error: 'Não autenticado.' });
}

export function requireRole(...roles) {
  return (req, res, next) => {
    const user = req.session?.user;
    if (!user || user.status !== 'ativo') return res.status(401).json({ error: 'Não autenticado.' });
    if (!roles.includes(user.role)) return res.status(403).json({ error: 'Sem permissão para esta ação.' });
    next();
  };
}

const router = express.Router();

// Primeiro acesso: AD confirma identidade, usuário define senha do sistema.
router.post('/register', async (req, res) => {
  const { username, adPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter ao menos 6 caracteres.' });
  }
  try {
    const ad = await authenticateAD(username, adPassword);
    const existing = db.prepare('SELECT login FROM users WHERE login = ?').get(ad.login);
    if (existing) return res.status(409).json({ error: 'Usuário já cadastrado. Use "Entrar".' });

    const isBootstrap = BOOTSTRAP_ADMIN.includes(ad.login);
    const now = new Date().toISOString();
    tx(() => {
      db.prepare(`INSERT INTO users (login, name, password, role, status, created_at, updated_at)
        VALUES (@login, @name, @password, @role, @status, @now, @now)`).run({
        login: ad.login, name: ad.name, password: hashPassword(newPassword),
        role: isBootstrap ? 'administrador' : null,
        status: isBootstrap ? 'ativo' : 'pendente',
        now,
      });
      appendAudit({
        at: now, user_login: ad.login, user_name: ad.name,
        action: isBootstrap ? 'Cadastro de administrador inicial (primeiro acesso)' : 'Cadastro de usuário (primeiro acesso)',
        note: isBootstrap ? 'Conta bootstrap: administrador + ativo.' : 'Conta criada como pendente, aguardando liberação do administrador.',
      });
    })();

    res.status(201).json({
      ok: true,
      status: isBootstrap ? 'ativo' : 'pendente',
      message: isBootstrap
        ? 'Administrador criado. Faça login com sua nova senha.'
        : 'Cadastro criado. Aguarde um administrador liberar seu acesso.',
    });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Falha no cadastro.' });
  }
});

// Login normal: usuário + senha DO SISTEMA (não a do AD).
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const login = String(username || '').trim().toLowerCase().replace(/@.*/, '');
  const row = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
  if (!row || !verifyPassword(password, row.password)) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.', hint: !row ? 'primeiro-acesso' : undefined });
  }
  if (row.status === 'pendente') return res.status(403).json({ error: 'Acesso ainda não liberado. Aguarde um administrador.' });
  if (row.status === 'inativo') return res.status(403).json({ error: 'Acesso desativado. Fale com o administrador.' });

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET last_login = ? WHERE login = ?').run(now, login);
  const user = sessionUserFor(login);
  req.session.user = user;
  tx(() => appendAudit({ at: now, user_login: user.login, user_name: user.name, sector_origin: user.sector, action: 'Login realizado' }))();
  res.json({ user });
});

router.post('/logout', (req, res) => {
  const user = req.session?.user;
  if (user) tx(() => appendAudit({ user_login: user.login, user_name: user.name, action: 'Logout realizado' }))();
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Não autenticado.' });
  // Reidrata do banco (papel/status/setor podem ter mudado desde o login).
  const fresh = sessionUserFor(user.login);
  if (!fresh || fresh.status !== 'ativo') {
    return req.session.destroy(() => res.status(401).json({ error: 'Sessão encerrada.' }));
  }
  req.session.user = fresh;
  res.json({ user: fresh });
});

export { sessionUserFor };
export default router;
