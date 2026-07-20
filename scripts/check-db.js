// Verificação da fase 1: conexão, schema criado e trava da auditoria.
// Uso:  npm run check-db      (equivale a node --env-file=.env scripts/check-db.js)
import { query, queryOne, closePool } from '../server/sqlserver.js';

const CUTOFF = process.env.ENTRADAS_CUTOFF || '2026-07-20';

let falhas = 0;
const ok = msg => console.log(`  ok    ${msg}`);
const erro = msg => { falhas++; console.log(`  FALHA ${msg}`); };

async function main() {
  console.log('\n== Conexão ==');
  const info = await queryOne('SELECT DB_NAME() AS db, SUSER_SNAME() AS usuario, @@VERSION AS versao');
  ok(`banco ${info.db} como ${info.usuario}`);
  console.log(`        ${info.versao.split('\n')[0].trim()}`);

  console.log('\n== Schema ==');
  const tabelas = [
    'KING_PORTAL_ENTRADAS',
    'KING_PORTAL_ENTRADAS_ANEXOS',
    'KING_PORTAL_ENTRADAS_AUDITORIA',
    'KING_PORTAL_ENTRADAS_USUARIOS',
  ];
  for (const t of tabelas) {
    const row = await queryOne(
      'SELECT OBJECT_ID(@nome, \'U\') AS id', { nome: `dbo.${t}` }
    );
    row?.id ? ok(`tabela ${t}`) : erro(`tabela ${t} não existe — rode sql/001-schema.sql`);
  }

  const col = await queryOne(`
    SELECT 1 AS achou FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.ENTRADAS') AND name = 'PDF_ENTRADA'
  `);
  col ? ok('coluna ENTRADAS.PDF_ENTRADA') : erro('coluna ENTRADAS.PDF_ENTRADA não existe');

  console.log('\n== Leitura da ENTRADAS ==');
  const total = await queryOne(`
    SELECT COUNT(*) AS n
    FROM dbo.ENTRADAS
    WHERE RECEBIMENTO >= @corte AND NOTA_CANCELADA = 0
  `, { corte: CUTOFF });
  ok(`${total.n} nota(s) a partir de ${CUTOFF} (canceladas excluídas)`);

  const semChave = await queryOne(`
    SELECT SUM(CASE WHEN CHAVE_NFE IS NULL OR CHAVE_NFE = '' THEN 1 ELSE 0 END) AS n
    FROM dbo.ENTRADAS
    WHERE RECEBIMENTO >= @corte AND NOTA_CANCELADA = 0
  `, { corte: CUTOFF });
  const n = semChave.n ?? 0;
  n === 0 ? ok('todas as notas do período têm CHAVE_NFE') : erro(`${n} nota(s) sem CHAVE_NFE`);

  const amostra = await query(`
    SELECT TOP 3
      LTRIM(RTRIM(NF_ENTRADA)) AS NF, LTRIM(RTRIM(SERIE_NF_ENTRADA)) AS SERIE,
      NOME_CLIFOR, CHAVE_NFE, VALOR_TOTAL, FILIAL, PDF_ENTRADA
    FROM dbo.ENTRADAS
    WHERE RECEBIMENTO >= @corte AND NOTA_CANCELADA = 0
    ORDER BY RECEBIMENTO DESC
  `, { corte: CUTOFF });
  for (const r of amostra) {
    console.log(`        NF ${r.NF}/${r.SERIE} · ${r.NOME_CLIFOR} · R$ ${r.VALOR_TOTAL} · ${r.FILIAL} · PDF_ENTRADA=${r.PDF_ENTRADA ?? 'NULL'}`);
  }

  console.log('\n== Auditoria append-only ==');
  // Insere uma linha, tenta alterar e apagar: as duas devem falhar.
  await query(`
    INSERT INTO dbo.KING_PORTAL_ENTRADAS_AUDITORIA
      (OCORRIDO_EM, USUARIO_LOGIN, USUARIO_NOME, ACAO, HASH_ANTERIOR, HASH)
    VALUES (SYSUTCDATETIME(), 'check', 'Verificação', 'Teste de trava append-only',
            REPLICATE('0', 64), REPLICATE('f', 64))
  `);
  const alvo = await queryOne(`
    SELECT TOP 1 SEQ FROM dbo.KING_PORTAL_ENTRADAS_AUDITORIA
    WHERE USUARIO_LOGIN = 'check' ORDER BY SEQ DESC
  `);
  ok(`linha de teste inserida (SEQ ${alvo.SEQ})`);

  try {
    await query('UPDATE dbo.KING_PORTAL_ENTRADAS_AUDITORIA SET ACAO = \'adulterado\' WHERE SEQ = @seq', { seq: alvo.SEQ });
    erro('UPDATE na auditoria PASSOU — a trava não está ativa!');
  } catch (err) {
    ok(`UPDATE bloqueado (${err.message.split('\n')[0]})`);
  }

  try {
    await query('DELETE FROM dbo.KING_PORTAL_ENTRADAS_AUDITORIA WHERE SEQ = @seq', { seq: alvo.SEQ });
    erro('DELETE na auditoria PASSOU — a trava não está ativa!');
  } catch (err) {
    ok(`DELETE bloqueado (${err.message.split('\n')[0]})`);
  }

  console.log(falhas ? `\n${falhas} verificação(ões) falharam.\n` : '\nTudo certo. Fase 1 validada.\n');
  process.exitCode = falhas ? 1 : 0;
}

main()
  .catch(err => {
    console.error('\nErro:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
