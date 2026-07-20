// Senha local do sistema (scrypt, sem dependência nativa).
// A identidade vem do AD, mas a senha do domínio é compartilhada/padrão —
// por isso cada pessoa cria uma senha própria aqui no primeiro acesso.
import crypto from 'node:crypto';

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, derived] = String(stored).trim().split(':');
  const a = Buffer.from(derived, 'hex');
  const b = crypto.scryptSync(String(plain), salt, 64);
  // Comparação em tempo constante: evita vazar informação pelo tempo de resposta.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
