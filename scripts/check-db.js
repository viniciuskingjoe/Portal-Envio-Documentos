// Verificação da fase 1: conexão, schema criado e trava da auditoria.
// Uso:  npm run check-db      (equivale a node --env-file=.env scripts/check-db.js)
import { query, queryOne, closePool } from '../server/sqlserver.js';
import { registrarAuditoriaAvulsa, verificarCadeia } from '../server/auditoria.js';

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

  console.log('\n== View de notas (normalizada e sem duplicidade) ==');
  const temView = await queryOne(`SELECT OBJECT_ID('dbo.VW_KING_PORTAL_NOTAS', 'V') AS id`);
  if (!temView?.id) {
    erro('view VW_KING_PORTAL_NOTAS não existe — rode sql/002-view-notas.sql');
  } else {
    const brutas = await queryOne(`
      SELECT COUNT(*) AS n FROM dbo.ENTRADAS
      WHERE RECEBIMENTO >= @corte AND NOTA_CANCELADA = 0
    `, { corte: CUTOFF });
    const daView = await queryOne(`
      SELECT COUNT(*) AS n FROM dbo.VW_KING_PORTAL_NOTAS WHERE RECEBIMENTO >= @corte
    `, { corte: CUTOFF });
    ok(`${brutas.n} linha(s) na ENTRADAS -> ${daView.n} nota(s) na view (${brutas.n - daView.n} duplicada(s) removida(s))`);

    const comZero = await queryOne(`
      SELECT COUNT(*) AS n FROM dbo.VW_KING_PORTAL_NOTAS
      WHERE RECEBIMENTO >= @corte AND NF_ENTRADA LIKE '0%'
    `, { corte: CUTOFF });
    comZero.n === 0
      ? ok('nenhum número com zero à esquerda')
      : erro(`${comZero.n} nota(s) ainda com zero à esquerda`);

    const dupView = await queryOne(`
      SELECT COUNT(*) AS n FROM (
        SELECT CHAVE_NFE FROM dbo.VW_KING_PORTAL_NOTAS
        GROUP BY CHAVE_NFE HAVING COUNT(*) > 1
      ) x
    `);
    dupView.n === 0 ? ok('uma linha por CHAVE_NFE') : erro(`${dupView.n} chave(s) ainda duplicada(s)`);

    // Verificação independente do valor somado: recalcula fora da view,
    // descartando duplicatas de padding, e compara. Se a view contasse uma
    // duplicata duas vezes, o valor divergiria aqui.
    const somaErrada = await query(`
      SELECT TOP 5 v.CHAVE_NFE, v.VALOR_TOTAL AS VALOR_VIEW, d.VALOR_CONFERIDO
      FROM dbo.VW_KING_PORTAL_NOTAS v
      JOIN (
        SELECT CHAVE_NFE, SUM(VALOR_TOTAL) AS VALOR_CONFERIDO
        FROM (
          SELECT DISTINCT
            CHAVE_NFE,
            ISNULL(NULLIF(SUBSTRING(LTRIM(RTRIM(NF_ENTRADA)),
              PATINDEX('%[^0]%', LTRIM(RTRIM(NF_ENTRADA)) + 'X'), 15), ''), '0') AS NF,
            LTRIM(RTRIM(SERIE_NF_ENTRADA)) AS SERIE,
            FILIAL, LTRIM(RTRIM(NATUREZA)) AS NATUREZA, VALOR_TOTAL
          FROM dbo.ENTRADAS
          WHERE NOTA_CANCELADA = 0 AND CHAVE_NFE IS NOT NULL AND CHAVE_NFE <> ''
        ) x GROUP BY CHAVE_NFE
      ) d ON d.CHAVE_NFE = v.CHAVE_NFE
      WHERE ABS(v.VALOR_TOTAL - d.VALOR_CONFERIDO) > 0.01
    `);
    somaErrada.length === 0
      ? ok('valor somado confere (duplicata de padding não entra duas vezes)')
      : erro(`${somaErrada.length} nota(s) com valor somado errado — ex.: ${somaErrada[0].CHAVE_NFE} view=${somaErrada[0].VALOR_VIEW} esperado=${somaErrada[0].VALOR_CONFERIDO}`);

    const partes = await queryOne(`
      SELECT
        SUM(CASE WHEN QTD_LANCAMENTOS > 1 THEN 1 ELSE 0 END) AS EM_PARTES,
        SUM(CASE WHEN QTD_FILIAIS > 1 THEN 1 ELSE 0 END)     AS EM_VARIAS_FILIAIS,
        COUNT(*) AS TOTAL
      FROM dbo.VW_KING_PORTAL_NOTAS WHERE RECEBIMENTO >= @corte
    `, { corte: CUTOFF });
    console.log(`        no período: ${partes.TOTAL} nota(s) · ${partes.EM_PARTES} lançada(s) em partes · ${partes.EM_VARIAS_FILIAIS} rateada(s) entre filiais`);

    const amostraView = await query(`
      SELECT TOP 3 NF_ENTRADA, SERIE_NF_ENTRADA, NOME_CLIFOR, FILIAL,
                   VALOR_TOTAL, QTD_LANCAMENTOS, NATUREZAS
      FROM dbo.VW_KING_PORTAL_NOTAS
      WHERE RECEBIMENTO >= @corte ORDER BY RECEBIMENTO DESC
    `, { corte: CUTOFF });
    for (const r of amostraView) {
      console.log(`        NF ${r.NF_ENTRADA}/${r.SERIE_NF_ENTRADA} · ${r.NOME_CLIFOR} · R$ ${r.VALOR_TOTAL} · ${r.QTD_LANCAMENTOS} lanç. (${r.NATUREZAS})`);
    }
  }

  console.log('\n== Auditoria append-only ==');
  // Grava pela função real: a linha entra encadeada e a cadeia segue válida.
  // (Antes este check inseria hash falso, o que quebrava a cadeia para sempre —
  // e como a tabela é append-only, não havia como remover a linha ruim.)
  await registrarAuditoriaAvulsa({
    usuarioLogin: 'check',
    usuarioNome: 'Verificação',
    acao: 'Teste de trava append-only',
  });
  const alvo = await queryOne(`
    SELECT TOP 1 SEQ FROM dbo.KING_PORTAL_ENTRADAS_AUDITORIA
    WHERE USUARIO_LOGIN = 'check' ORDER BY SEQ DESC
  `);
  ok(`linha de teste inserida (SEQ ${alvo.SEQ})`);

  const cadeia = await verificarCadeia();
  cadeia.ok
    ? ok(`cadeia de hash íntegra (${cadeia.total} registro(s))`)
    : erro(`cadeia quebrada no SEQ ${cadeia.quebrouEm} de ${cadeia.total} — se houver linhas de teste antigas com hash falso, limpe a tabela antes de produção (TRUNCATE TABLE dbo.KING_PORTAL_ENTRADAS_AUDITORIA)`);

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
