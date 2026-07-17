import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id           TEXT PRIMARY KEY,
    protocol     TEXT NOT NULL UNIQUE,
    invoice      TEXT NOT NULL,
    branch       TEXT NOT NULL,
    origin       TEXT NOT NULL,
    destination  TEXT NOT NULL DEFAULT 'Fiscal',
    supplier     TEXT NOT NULL,
    amount       TEXT,
    status       TEXT NOT NULL DEFAULT 'Aguardando análise',
    responsible       TEXT NOT NULL,
    responsible_login TEXT NOT NULL,
    file_name    TEXT,
    file_path    TEXT,
    file_size    TEXT,
    mime         TEXT,
    notes        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  -- Ledger append-only. NUNCA sofre UPDATE/DELETE. Cada linha encadeia hash
  -- da anterior (prev_hash), tornando adulteração detectável.
  CREATE TABLE IF NOT EXISTS audit_log (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL,
    user_login   TEXT NOT NULL,
    user_name    TEXT NOT NULL,
    sector_origin      TEXT,
    sector_destination TEXT,
    action       TEXT NOT NULL,
    protocol     TEXT,
    document_id  TEXT,
    note         TEXT,
    detail       TEXT,
    prev_hash    TEXT NOT NULL,
    hash         TEXT NOT NULL
  );

  -- Usuários do sistema. Identidade vem do AD (login = sAMAccountName), mas a
  -- senha é local (scrypt) porque a senha do AD é padrão/compartilhada.
  -- Novo usuário nasce status 'pendente' sem papel: não acessa nada até o admin liberar.
  CREATE TABLE IF NOT EXISTS users (
    login        TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    password     TEXT NOT NULL,           -- "salt:hash" (scrypt)
    role         TEXT,                     -- administrador | fiscal | conferente | NULL(pendente)
    status       TEXT NOT NULL DEFAULT 'pendente',  -- pendente | ativo | inativo
    branch_id    INTEGER,
    sector_id    INTEGER,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    last_login   TEXT,
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (sector_id) REFERENCES sectors(id)
  );

  CREATE TABLE IF NOT EXISTS branches (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sectors (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_audit_document ON audit_log(document_id);
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
  CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);

  -- Triggers de defesa: bloqueiam qualquer UPDATE/DELETE no ledger.
  CREATE TRIGGER IF NOT EXISTS audit_no_update
    BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log e append-only: UPDATE proibido'); END;
  CREATE TRIGGER IF NOT EXISTS audit_no_delete
    BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log e append-only: DELETE proibido'); END;
`);

// Migração: status "Pendente" foi renomeado para "Fazer Carta de Correção".
db.exec(`UPDATE documents SET status = 'Fazer Carta de Correção' WHERE status = 'Pendente'`);

const GENESIS = '0'.repeat(64);

function rowHash(row) {
  const payload = [
    row.seq, row.at, row.user_login, row.user_name,
    row.sector_origin || '', row.sector_destination || '',
    row.action, row.protocol || '', row.document_id || '',
    row.note || '', row.detail || '', row.prev_hash,
  ].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

const lastAuditStmt = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
const insertAuditStmt = db.prepare(`
  INSERT INTO audit_log
    (at, user_login, user_name, sector_origin, sector_destination, action, protocol, document_id, note, detail, prev_hash, hash)
  VALUES
    (@at, @user_login, @user_name, @sector_origin, @sector_destination, @action, @protocol, @document_id, @note, @detail, @prev_hash, @hash)
`);

/**
 * Grava um evento no ledger append-only com hash encadeado.
 * Deve ser chamado dentro da mesma transação da ação que descreve.
 */
export function appendAudit(entry) {
  const prev = lastAuditStmt.get();
  const at = entry.at || new Date().toISOString();
  const seqGuess = (Number(prev?.seq) || 0) + 1;
  const base = {
    seq: seqGuess,
    at,
    user_login: entry.user_login,
    user_name: entry.user_name,
    sector_origin: entry.sector_origin || null,
    sector_destination: entry.sector_destination || null,
    action: entry.action,
    protocol: entry.protocol || null,
    document_id: entry.document_id || null,
    note: entry.note || null,
    detail: entry.detail ? JSON.stringify(entry.detail) : null,
    prev_hash: prev?.hash || GENESIS,
  };
  base.hash = rowHash(base);
  // node:sqlite rejeita chaves fora do SQL: seq é só para o hash, não vai no INSERT.
  const { seq, ...params } = base;
  const info = insertAuditStmt.run(params);
  return { seq: Number(info.lastInsertRowid), hash: base.hash };
}

/** Verifica integridade da cadeia inteira. Retorna {ok, brokenAt}. */
export function verifyChain() {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all();
  let prevHash = GENESIS;
  for (const row of rows) {
    const expected = rowHash({ ...row, prev_hash: prevHash });
    if (row.prev_hash !== prevHash || row.hash !== expected) {
      return { ok: false, brokenAt: Number(row.seq) };
    }
    prevHash = row.hash;
  }
  return { ok: true, count: rows.length };
}

/**
 * Envolve fn numa transação. Retorna uma função; ao chamá-la, executa
 * fn entre BEGIN/COMMIT (ROLLBACK em erro). Compatível com o uso tx(fn)().
 */
/* ---------- Senha local (scrypt, sem deps nativas) ---------- */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, derived] = stored.split(':');
  const a = Buffer.from(derived, 'hex');
  const b = crypto.scryptSync(String(plain), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function tx(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

export default db;
