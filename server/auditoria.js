// Ledger append-only no SQL Server (KING_PORTAL_ENTRADAS_AUDITORIA).
//
// Cada linha guarda o hash da anterior (HASH_ANTERIOR -> HASH). Alterar ou
// remover qualquer registro quebra a cadeia e é detectável por verificarCadeia().
// O banco reforça isso com triggers INSTEAD OF UPDATE/DELETE.
import crypto from 'node:crypto';
import { query, transaction } from './sqlserver.js';

const GENESIS = '0'.repeat(64);

/**
 * Hash de uma linha. A ordem dos campos faz parte do contrato: não mexer.
 *
 * Duas decisões que existem para a cadeia não quebrar sozinha:
 *
 * - O SEQ não entra: é IDENTITY e pula números quando uma transação sofre
 *   rollback, então gravação e verificação discordariam. A ordem já vem do
 *   encadeamento HASH_ANTERIOR -> HASH.
 *
 * - O instante entra como a string ISO gravada em OCORRIDO_EM_ISO, nunca a
 *   partir do DATETIME2 lido de volta. Assim precisão e fuso do driver deixam
 *   de influenciar: o que foi hasheado é exatamente o que está na coluna.
 */
function hashLinha(linha) {
  const payload = [
    linha.ocorrido_em,
    linha.usuario_login,
    linha.usuario_nome,
    linha.setor_origem || '',
    linha.setor_destino || '',
    linha.acao,
    linha.protocolo || '',
    linha.protocolo_id || '',
    linha.chave_nfe || '',
    linha.observacao || '',
    linha.detalhe || '',
    linha.hash_anterior,
  ].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Grava um evento. Recebe `run` (o executor da transação do chamador) para que
 * o registro de auditoria e a ação que ele descreve sejam atômicos: ou os dois
 * acontecem, ou nenhum.
 *
 * A leitura do último hash usa UPDLOCK/HOLDLOCK. Sem isso, dois usuários
 * gravando ao mesmo tempo leriam o mesmo hash anterior e a cadeia quebraria —
 * problema que não existia no SQLite, que só aceita um escritor por vez.
 */
export async function registrarAuditoria(run, evento) {
  const anterior = await run(`
    SELECT TOP 1 SEQ, HASH
    FROM dbo.KING_PORTAL_ENTRADAS_AUDITORIA WITH (UPDLOCK, HOLDLOCK)
    ORDER BY SEQ DESC
  `);

  const ocorridoEm = evento.ocorridoEm ? new Date(evento.ocorridoEm) : new Date();
  const ocorridoEmIso = ocorridoEm.toISOString();
  const linha = {
    ocorrido_em: ocorridoEmIso,
    usuario_login: evento.usuarioLogin,
    usuario_nome: evento.usuarioNome,
    setor_origem: evento.setorOrigem || null,
    setor_destino: evento.setorDestino || null,
    acao: evento.acao,
    protocolo: evento.protocolo || null,
    protocolo_id: evento.protocoloId || null,
    chave_nfe: evento.chaveNfe || null,
    observacao: evento.observacao || null,
    detalhe: evento.detalhe ? JSON.stringify(evento.detalhe) : null,
    hash_anterior: anterior[0]?.HASH?.trim() || GENESIS,
  };
  linha.hash = hashLinha(linha);

  await run(`
    INSERT INTO dbo.KING_PORTAL_ENTRADAS_AUDITORIA
      (OCORRIDO_EM, OCORRIDO_EM_ISO, USUARIO_LOGIN, USUARIO_NOME, SETOR_ORIGEM, SETOR_DESTINO,
       ACAO, PROTOCOLO, PROTOCOLO_ID, CHAVE_NFE, OBSERVACAO, DETALHE,
       HASH_ANTERIOR, HASH)
    VALUES
      (@ocorrido_em, @ocorrido_em_iso, @usuario_login, @usuario_nome, @setor_origem, @setor_destino,
       @acao, @protocolo, @protocolo_id, @chave_nfe, @observacao, @detalhe,
       @hash_anterior, @hash)
  `, {
    ocorrido_em: ocorridoEm,
    ocorrido_em_iso: ocorridoEmIso,
    usuario_login: linha.usuario_login,
    usuario_nome: linha.usuario_nome,
    setor_origem: linha.setor_origem,
    setor_destino: linha.setor_destino,
    acao: linha.acao,
    protocolo: linha.protocolo,
    protocolo_id: linha.protocolo_id,
    chave_nfe: linha.chave_nfe,
    observacao: linha.observacao,
    detalhe: linha.detalhe,
    hash_anterior: linha.hash_anterior,
    hash: linha.hash,
  });

  return linha.hash;
}

/** Registra um evento avulso, em transação própria (login, logout, etc.). */
export async function registrarAuditoriaAvulsa(evento) {
  return transaction(run => registrarAuditoria(run, evento));
}

/** Recalcula a cadeia inteira. Retorna { ok, total } ou { ok:false, quebrouEm }. */
export async function verificarCadeia() {
  const linhas = await query(`
    SELECT SEQ, OCORRIDO_EM_ISO, USUARIO_LOGIN, USUARIO_NOME, SETOR_ORIGEM, SETOR_DESTINO,
           ACAO, PROTOCOLO, PROTOCOLO_ID, CHAVE_NFE, OBSERVACAO, DETALHE,
           HASH_ANTERIOR, HASH
    FROM dbo.KING_PORTAL_ENTRADAS_AUDITORIA
    ORDER BY SEQ ASC
  `);

  let hashAnterior = GENESIS;
  for (let i = 0; i < linhas.length; i++) {
    const r = linhas[i];
    const esperado = hashLinha({
      ocorrido_em: r.OCORRIDO_EM_ISO,
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
      hash_anterior: hashAnterior,
    });
    if (r.HASH_ANTERIOR?.trim() !== hashAnterior || r.HASH?.trim() !== esperado) {
      return { ok: false, quebrouEm: Number(r.SEQ), total: linhas.length };
    }
    hashAnterior = r.HASH.trim();
  }
  return { ok: true, total: linhas.length };
}
