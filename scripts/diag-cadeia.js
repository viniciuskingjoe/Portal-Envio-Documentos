// Diagnóstico da cadeia de auditoria.
// Para a primeira linha que não confere, testa variações do payload até achar
// qual produz o hash gravado — isso identifica exatamente o campo que diverge
// entre o que foi hasheado na gravação e o que voltou do banco.
//
// Uso:  node --env-file=.env scripts/diag-cadeia.js
import crypto from 'node:crypto';
import { query, closePool } from '../server/sqlserver.js';

const GENESIS = '0'.repeat(64);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function payload(p) {
  return [
    p.ocorrido_em, p.usuario_login, p.usuario_nome,
    p.setor_origem || '', p.setor_destino || '',
    p.acao, p.protocolo || '', p.protocolo_id || '', p.chave_nfe || '',
    p.observacao || '', p.detalhe || '', p.hash_anterior,
  ].join('|');
}

const iso = v => (v instanceof Date ? v.toISOString() : String(v));

// Cada variante é uma hipótese sobre o que pode ter sido hasheado na gravação.
const variantes = {
  'atual (ISO gravado)': (r, prev) => payload({ ...base(r), ocorrido_em: r.OCORRIDO_EM_ISO, hash_anterior: prev }),
  'ISO derivado do DATETIME2': (r, prev) => payload({ ...base(r), ocorrido_em: iso(r.OCORRIDO_EM), hash_anterior: prev }),
  'nome sem espaços nas pontas': (r, prev) => payload({ ...base(r), usuario_nome: String(r.USUARIO_NOME).trim(), ocorrido_em: r.OCORRIDO_EM_ISO, hash_anterior: prev }),
  'hash anterior sem trim': (r, prev) => payload({ ...base(r), ocorrido_em: r.OCORRIDO_EM_ISO, hash_anterior: r.HASH_ANTERIOR }),
};

function base(r) {
  return {
    usuario_login: r.USUARIO_LOGIN,
    usuario_nome: r.USUARIO_NOME,
    setor_origem: r.SETOR_ORIGEM,
    setor_destino: r.SETOR_DESTINO,
    acao: r.ACAO,
    protocolo: r.PROTOCOLO,
    protocolo_id: r.PROTOCOLO_ID,
    chave_nfe: r.CHAVE_NFE,
    observacao: r.OBSERVACAO,
    detalhe: r.DETALHE,
  };
}

const linhas = await query(`
  SELECT SEQ, OCORRIDO_EM, OCORRIDO_EM_ISO, USUARIO_LOGIN, USUARIO_NOME, SETOR_ORIGEM, SETOR_DESTINO,
         ACAO, PROTOCOLO, PROTOCOLO_ID, CHAVE_NFE, OBSERVACAO, DETALHE,
         HASH_ANTERIOR, HASH
  FROM dbo.KING_PORTAL_ENTRADAS_AUDITORIA ORDER BY SEQ ASC
`);

let prev = GENESIS;
let achou = false;

for (const r of linhas) {
  const guardado = r.HASH.trim();
  const esperado = sha(variantes['atual (ISO gravado)'](r, prev));
  const elo = r.HASH_ANTERIOR.trim() === prev;

  if (elo && esperado === guardado) { prev = guardado; continue; }

  achou = true;
  console.log(`\n=== Primeira divergência: SEQ ${r.SEQ} ===`);
  console.log(`ação: ${r.ACAO}`);
  console.log(`elo com a anterior: ${elo ? 'ok' : 'QUEBRADO'}`);
  if (!elo) {
    console.log(`  HASH_ANTERIOR gravado: ${r.HASH_ANTERIOR.trim()}`);
    console.log(`  hash real da anterior: ${prev}`);
  }
  console.log(`\nhash gravado:   ${guardado}`);
  console.log(`hash recalculado: ${esperado}`);
  console.log('\nTestando hipóteses:');
  for (const [nome, fn] of Object.entries(variantes)) {
    const h = sha(fn(r, r.HASH_ANTERIOR.trim()));
    console.log(`  ${h === guardado ? '>>> BATE' : '        '}  ${nome}`);
  }
  console.log('\nValores da linha:');
  console.log(`  OCORRIDO_EM_ISO (hasheado): ${r.OCORRIDO_EM_ISO}`);
  console.log(`  OCORRIDO_EM (datetime2):    ${iso(r.OCORRIDO_EM)}`);
  console.log(`  USUARIO_NOME: ${JSON.stringify(r.USUARIO_NOME)}`);
  console.log(`  ACAO: ${JSON.stringify(r.ACAO)}`);
  console.log(`  OBSERVACAO: ${JSON.stringify(r.OBSERVACAO)}`);
  console.log(`  DETALHE: ${JSON.stringify(r.DETALHE)}`);
  break;
}

if (!achou) console.log(`\nCadeia íntegra: ${linhas.length} registro(s).`);
await closePool();
