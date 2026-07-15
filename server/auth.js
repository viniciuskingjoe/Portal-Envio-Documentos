import express from 'express';
import ldap from 'ldapjs';
import { appendAudit, tx } from './db.js';

const LDAP_URL = process.env.LDAP_URL || 'ldap://192.168.1.4:389';
const LDAP_BASE_DN = process.env.LDAP_BASE_DN || 'DC=king,DC=local';
const LDAP_DOMAIN = process.env.LDAP_DOMAIN || 'king.local';

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase() || '??';
}

/**
 * Autentica no Active Directory por bind LDAP.
 * Sucesso => busca displayName e department (setor). Rejeita em falha.
 */
function authenticate(username, password) {
  return new Promise((resolve, reject) => {
    if (!username || !password) return reject(new Error('Usuário e senha obrigatórios.'));

    const upn = username.includes('@') ? username : `${username}@${LDAP_DOMAIN}`;
    const sam = username.includes('@') ? username.split('@')[0] : username;
    const client = ldap.createClient({ url: LDAP_URL, timeout: 8000, connectTimeout: 8000 });

    client.on('error', err => reject(err));

    client.bind(upn, password, err => {
      if (err) {
        client.destroy();
        return reject(new Error('Credenciais inválidas.'));
      }
      // Bind OK: busca atributos do usuário.
      const opts = {
        scope: 'sub',
        filter: `(sAMAccountName=${sam})`,
        attributes: ['displayName', 'cn', 'department', 'sAMAccountName', 'mail'],
      };
      client.search(LDAP_BASE_DN, opts, (searchErr, res) => {
        if (searchErr) {
          client.unbind();
          return resolve({ login: sam, name: sam, sector: 'Não informado', initials: initials(sam) });
        }
        let entry = null;
        res.on('searchEntry', e => { entry = e.pojo || e.object; });
        res.on('error', () => {
          client.unbind();
          resolve({ login: sam, name: sam, sector: 'Não informado', initials: initials(sam) });
        });
        res.on('end', () => {
          client.unbind();
          const attr = {};
          for (const a of entry?.attributes || []) attr[a.type] = a.values?.[0] ?? a.vals?.[0];
          const name = attr.displayName || attr.cn || sam;
          const sector = attr.department || 'Não informado';
          resolve({ login: sam, name, sector, initials: initials(name) });
        });
      });
    });
  });
}

export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Não autenticado.' });
}

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const user = await authenticate(username, password);
    req.session.user = user;
    tx(() => appendAudit({
      user_login: user.login,
      user_name: user.name,
      sector_origin: user.sector,
      action: 'Login realizado',
    }))();
    res.json({ user });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Falha na autenticação.' });
  }
});

router.post('/logout', (req, res) => {
  const user = req.session?.user;
  if (user) {
    tx(() => appendAudit({
      user_login: user.login,
      user_name: user.name,
      sector_origin: user.sector,
      action: 'Logout realizado',
    }))();
  }
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (req.session?.user) return res.json({ user: req.session.user });
  res.status(401).json({ error: 'Não autenticado.' });
});

export default router;
