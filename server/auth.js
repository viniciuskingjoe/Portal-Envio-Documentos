import express from 'express';
import ldap from 'ldapjs';
import { hashPassword, verifyPassword } from './db.js';
import { query, queryOne, transaction } from './sqlserver.js';
import { registrarAuditoria, registrarAuditoriaAvulsa } from './auditoria.js';

const LDAP_URL = process.env.LDAP_URL || 'ldap://192.168.1.4:389';
const LDAP_BASE_DN = process.env.LDAP_BASE_DN || 'DC=king,DC=local';
const LDAP_DOMAIN = process.env.LDAP_DOMAIN || 'king.local';
// Logins (sAMAccountName) que viram administrador+ativo no 1º acesso. Resolve o
// ovo-galinha: sem admin ninguém aprova ninguém. Ex: BOOTSTRAP_ADMIN=vlopes,tiadmin
const BOOTSTRAP_ADMIN = (process.env.BOOTSTRAP_ADMIN || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/* ---------- Proteção contra força bruta ----------
 * A senha do sistema é local, então tentativas ilimitadas permitiriam quebrar
 * por repetição. Conta falhas por login+IP em memória e bloqueia por um tempo.
 * Em memória basta: um restart libera, mas o atacante perde o progresso junto.
 */
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000; // 15 min
const attempts = new Map(); // chave -> { count, until }

function throttleKey(req, login) {
  return `${login}|${req.ip}`;
}
function isLocked(key) {
  const entry = attempts.get(key);
  if (!entry?.until) return 0;
  if (Date.now() > entry.until) { attempts.delete(key); return 0; }
  return Math.ceil((entry.until - Date.now()) / 60000); // minutos restantes
}
function registerFailure(key) {
  const entry = attempts.get(key) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) entry.until = Date.now() + LOCK_MS;
  attempts.set(key, entry);
}
function clearFailures(key) {
  attempts.delete(key);
}
// Limpeza periódica para a memória não crescer sem limite.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (entry.until && now > entry.until) attempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

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
async function sessionUserFor(login) {
  const row = await queryOne(`
    SELECT LOGIN, NOME, PAPEL, SITUACAO, FILIAL, SETOR
    FROM dbo.KING_PORTAL_ENTRADAS_USUARIOS
    WHERE LOGIN = @login
  `, { login });
  if (!row) return null;
  return {
    login: row.LOGIN,
    name: row.NOME,
    role: row.PAPEL,
    status: row.SITUACAO,
    // Filial e setor agora são texto no cadastro do usuário: a filial existe na
    // ENTRADAS (não há mais catálogo próprio) e o setor é campo livre.
    branch: row.FILIAL || null,
    sector: row.SETOR || null,
    initials: initials(row.NOME),
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

// Primeiro acesso (tela única): AD confirma identidade, usuário cria senha do
// sistema e JÁ ENTRA como conferente (ou administrador se estiver no bootstrap).
router.post('/register', async (req, res) => {
  const { username, adPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter ao menos 6 caracteres.' });
  }
  // Limita tentativas contra o AD: sem isso o portal viraria um proxy de força
  // bruta capaz de bloquear contas reais do domínio.
  const adKey = throttleKey(req, String(username || '').trim().toLowerCase());
  const adLockedFor = isLocked(adKey);
  if (adLockedFor) {
    return res.status(429).json({ error: `Muitas tentativas. Tente novamente em ${adLockedFor} min.` });
  }
  try {
    const ad = await authenticateAD(username, adPassword);
    clearFailures(adKey);
    const existing = await queryOne(
      'SELECT LOGIN FROM dbo.KING_PORTAL_ENTRADAS_USUARIOS WHERE LOGIN = @login', { login: ad.login }
    );
    if (existing) return res.status(409).json({ error: 'Usuário já cadastrado. Use sua senha do sistema para entrar.' });

    const isBootstrap = BOOTSTRAP_ADMIN.includes(ad.login);
    const role = isBootstrap ? 'administrador' : 'conferente';
    const agora = new Date();
    await transaction(async run => {
      await run(`
        INSERT INTO dbo.KING_PORTAL_ENTRADAS_USUARIOS
          (LOGIN, NOME, SENHA, PAPEL, SITUACAO, ULTIMO_LOGIN, CRIADO_EM, ATUALIZADO_EM)
        VALUES (@login, @nome, @senha, @papel, 'ativo', @agora, @agora, @agora)
      `, { login: ad.login, nome: ad.name, senha: hashPassword(newPassword), papel: role, agora });
      await registrarAuditoria(run, {
        ocorridoEm: agora,
        usuarioLogin: ad.login,
        usuarioNome: ad.name,
        acao: 'Cadastro no primeiro acesso',
        observacao: `Conta criada e ativada como ${role}.`,
      });
    });

    const user = await sessionUserFor(ad.login);
    req.session.user = user; // entra direto
    res.status(201).json({ user });
  } catch (err) {
    registerFailure(adKey);
    res.status(401).json({ error: err.message || 'Falha no cadastro.' });
  }
});

// Login (tela única): usuário + senha DO SISTEMA. Se o usuário ainda não existe,
// responde { firstAccess:true } para o front pedir AD + criação de senha.
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const login = String(username || '').trim().toLowerCase().replace(/@.*/, '');
  const key = throttleKey(req, login);
  const lockedFor = isLocked(key);
  if (lockedFor) {
    return res.status(429).json({ error: `Muitas tentativas. Tente novamente em ${lockedFor} min.` });
  }
  const row = await queryOne(
    'SELECT LOGIN, NOME, SENHA, SITUACAO FROM dbo.KING_PORTAL_ENTRADAS_USUARIOS WHERE LOGIN = @login',
    { login }
  );
  if (!row) return res.json({ firstAccess: true });
  if (!verifyPassword(password, row.SENHA)) {
    registerFailure(key);
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }
  clearFailures(key);
  if (row.SITUACAO === 'inativo') return res.status(403).json({ error: 'Acesso desativado. Fale com o administrador.' });
  if (row.SITUACAO === 'pendente') return res.status(403).json({ error: 'Acesso ainda não liberado. Aguarde um administrador.' });

  const agora = new Date();
  await query('UPDATE dbo.KING_PORTAL_ENTRADAS_USUARIOS SET ULTIMO_LOGIN = @agora WHERE LOGIN = @login', { agora, login });
  const user = await sessionUserFor(login);
  req.session.user = user;
  await registrarAuditoriaAvulsa({
    ocorridoEm: agora,
    usuarioLogin: user.login,
    usuarioNome: user.name,
    setorOrigem: user.sector,
    acao: 'Login realizado',
  });
  res.json({ user });
});

router.post('/logout', async (req, res) => {
  const user = req.session?.user;
  if (user) {
    // Falha ao auditar não pode impedir o logout.
    await registrarAuditoriaAvulsa({
      usuarioLogin: user.login,
      usuarioNome: user.name,
      acao: 'Logout realizado',
    }).catch(err => console.error('auditoria do logout:', err.message));
  }
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Não autenticado.' });
  // Reidrata do banco (papel/status/setor podem ter mudado desde o login).
  const fresh = await sessionUserFor(user.login);
  if (!fresh || fresh.status !== 'ativo') {
    return req.session.destroy(() => res.status(401).json({ error: 'Sessão encerrada.' }));
  }
  req.session.user = fresh;
  res.json({ user: fresh });
});

export { sessionUserFor };
export default router;
