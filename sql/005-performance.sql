/* ============================================================================
   Desempenho: protocolar e movimentar estavam lentos.

   Duas causas:

   1) A view agregava a dbo.ENTRADAS INTEIRA (todo o histórico) a cada consulta,
      e só depois o filtro de data era aplicado. Como o filtro é sobre um
      agregado (COALESCE(MIN(...))), o otimizador não consegue empurrá-lo para
      dentro do GROUP BY. Agora existe um piso de data DENTRO da view, o que
      reduz o conjunto antes de agregar.

   2) CHAVE_NFE não tem índice na ENTRADAS. Toda leitura de uma nota e todo
      UPDATE de PDF_ENTRADA varria a tabela inteira — e o UPDATE ainda segurava
      bloqueios na tabela do ERP enquanto varria.

   O índice não altera o schema da ENTRADAS (não muda coluna nem tipo); apenas
   acrescenta estrutura de busca. O custo é uma escrita a mais por INSERT do
   Linx, o que compensa de longe o ganho aqui.
   ============================================================================ */

USE [KINGEJOE];
GO

/* ---- 1) Índices ---- */

-- Usado pela view, pela busca de uma nota e pelo UPDATE de PDF_ENTRADA.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ENTRADAS_CHAVE_NFE' AND object_id = OBJECT_ID('dbo.ENTRADAS'))
BEGIN
  CREATE NONCLUSTERED INDEX IX_ENTRADAS_CHAVE_NFE
    ON dbo.ENTRADAS (CHAVE_NFE)
    INCLUDE (NOTA_CANCELADA, DATA_DIGITACAO, RECEBIMENTO);
END
GO

-- A listagem busca a última movimentação de cada nota por CHAVE_NFE.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_KING_PORTAL_AUDITORIA_CHAVE' AND object_id = OBJECT_ID('dbo.KING_PORTAL_ENTRADAS_AUDITORIA'))
BEGIN
  CREATE NONCLUSTERED INDEX IX_KING_PORTAL_AUDITORIA_CHAVE
    ON dbo.KING_PORTAL_ENTRADAS_AUDITORIA (CHAVE_NFE, SEQ DESC);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_KING_PORTAL_ANEXOS_PROTOCOLO' AND object_id = OBJECT_ID('dbo.KING_PORTAL_ENTRADAS_ANEXOS'))
BEGIN
  CREATE NONCLUSTERED INDEX IX_KING_PORTAL_ANEXOS_PROTOCOLO
    ON dbo.KING_PORTAL_ENTRADAS_ANEXOS (PROTOCOLO_ID, VERSAO DESC);
END
GO

/* ---- 2) View com piso de data ----

   ATENÇÃO: o piso abaixo precisa ser ANTERIOR ao ENTRADAS_CUTOFF do .env.
   Ele existe só para a view não varrer anos de histórico; o corte que vale
   para o usuário continua sendo o do .env. Se um dia o corte do .env for
   movido para antes deste piso, as notas do intervalo não apareceriam —
   então baixe o piso junto.                                                  */

CREATE OR ALTER VIEW dbo.VW_KING_PORTAL_NOTAS AS
WITH base AS (
  SELECT
    e.CHAVE_NFE,
    ISNULL(NULLIF(SUBSTRING(
      LTRIM(RTRIM(e.NF_ENTRADA)),
      PATINDEX('%[^0]%', LTRIM(RTRIM(e.NF_ENTRADA)) + 'X'),
      15), ''), '0')                   AS NF_ENTRADA,
    LTRIM(RTRIM(e.SERIE_NF_ENTRADA))   AS SERIE_NF_ENTRADA,
    LTRIM(RTRIM(e.NATUREZA))           AS NATUREZA,
    e.NOME_CLIFOR,
    e.FILIAL,
    e.VALOR_TOTAL,
    e.RECEBIMENTO,
    e.DATA_DIGITACAO,
    e.EMISSAO,
    e.DEVOLUCAO,
    e.TRANSF_FILIAL,
    e.PDF_ENTRADA,
    LEN(LTRIM(RTRIM(e.NF_ENTRADA)))    AS TAM_ORIGINAL
  FROM dbo.ENTRADAS e
  WHERE e.NOTA_CANCELADA = 0
    AND e.CHAVE_NFE IS NOT NULL
    AND e.CHAVE_NFE <> ''
    -- Piso de desempenho (ver aviso acima).
    AND COALESCE(e.DATA_DIGITACAO, e.RECEBIMENTO) >= '2026-01-01'
),
sem_duplicata AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY CHAVE_NFE, NF_ENTRADA, SERIE_NF_ENTRADA, FILIAL, VALOR_TOTAL, NATUREZA
      ORDER BY TAM_ORIGINAL ASC
    ) AS RN
  FROM base
)
SELECT
  CHAVE_NFE,
  MIN(NF_ENTRADA)            AS NF_ENTRADA,
  MIN(SERIE_NF_ENTRADA)      AS SERIE_NF_ENTRADA,
  MIN(NOME_CLIFOR)           AS NOME_CLIFOR,
  MIN(FILIAL)                AS FILIAL,
  COUNT(DISTINCT FILIAL)     AS QTD_FILIAIS,
  SUM(VALOR_TOTAL)           AS VALOR_TOTAL,
  COUNT(*)                   AS QTD_LANCAMENTOS,
  STRING_AGG(NATUREZA, ', ') AS NATUREZAS,
  MIN(RECEBIMENTO)           AS RECEBIMENTO,
  MIN(DATA_DIGITACAO)        AS DATA_DIGITACAO,
  COALESCE(MIN(DATA_DIGITACAO), MIN(RECEBIMENTO)) AS DATA_LANCAMENTO,
  MIN(EMISSAO)               AS EMISSAO,
  MAX(CAST(DEVOLUCAO AS TINYINT))     AS DEVOLUCAO,
  MAX(CAST(TRANSF_FILIAL AS TINYINT)) AS TRANSF_FILIAL,
  MAX(PDF_ENTRADA)           AS PDF_ENTRADA
FROM sem_duplicata
WHERE RN = 1
GROUP BY CHAVE_NFE;
GO

PRINT 'Índices criados e view com piso de data aplicada.';
GO
