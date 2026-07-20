/* ============================================================================
   VW_KING_PORTAL_NOTAS — a fonte que a tela Documentos consome.
   Uma linha = uma NF-e = um PDF = um protocolo.

   Três características da dbo.ENTRADAS que esta view resolve:

   1) NF_ENTRADA é char(15) e às vezes vem com zeros à esquerda ('000272543'),
      às vezes não ('272543'). Aqui sai sempre normalizado.

   2) A MESMA NF-e é lançada em VÁRIAS linhas, quebrada por NATUREZA — o par
      240.01 (retorno de industrialização) + 201.0x (serviço) é uma nota só.
      O DANFE traz o TOTAL e o banco tem as PARTES, então a view SOMA.
      Exemplo real: chave ...773398 = 2.504,18 (240.01) + 2.570,40 (201.08).

   3) Além disso existem duplicatas verdadeiras, iguais em tudo menos o padding
      do número. Essas PRECISAM sair antes da soma, senão o valor dobraria.
      Exemplo real: chave ...120884, R$ 2.518,22 repetido em duas linhas.

   Sobre o corte de zeros: NÃO usar TRIM('0' FROM x) — no SQL Server 2019 o
   TRIM sem LEADING corta dos DOIS lados e transformaria '1200' em '12'.
   ============================================================================ */

USE [KINGEJOE];
GO

CREATE OR ALTER VIEW dbo.VW_KING_PORTAL_NOTAS AS
WITH norm AS (
  SELECT
    e.CHAVE_NFE,
    -- Número sem zeros à esquerda. O 'X' evita erro quando é só zeros.
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
    e.EMISSAO,
    e.DEVOLUCAO,
    e.TRANSF_FILIAL,
    e.PDF_ENTRADA,
    LEN(LTRIM(RTRIM(e.NF_ENTRADA)))    AS TAM_ORIGINAL
  FROM dbo.ENTRADAS e
  WHERE e.NOTA_CANCELADA = 0
    AND e.CHAVE_NFE IS NOT NULL
    AND e.CHAVE_NFE <> ''
),
-- Descarta a duplicata de padding: linhas idênticas em tudo que importa.
-- Lançamentos com natureza ou valor diferentes NÃO são duplicata — são as
-- partes da nota, e seguem para a soma.
sem_duplicata AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY CHAVE_NFE, NF_ENTRADA, SERIE_NF_ENTRADA, FILIAL, VALOR_TOTAL, NATUREZA
      ORDER BY TAM_ORIGINAL ASC
    ) AS RN
  FROM norm
)
SELECT
  CHAVE_NFE,
  MIN(NF_ENTRADA)            AS NF_ENTRADA,
  MIN(SERIE_NF_ENTRADA)      AS SERIE_NF_ENTRADA,
  MIN(NOME_CLIFOR)           AS NOME_CLIFOR,
  MIN(FILIAL)                AS FILIAL,
  COUNT(DISTINCT FILIAL)     AS QTD_FILIAIS,      -- >1: nota rateada entre filiais
  SUM(VALOR_TOTAL)           AS VALOR_TOTAL,      -- total da NF-e (bate com o DANFE)
  COUNT(*)                   AS QTD_LANCAMENTOS,  -- >1: nota lançada em partes
  STRING_AGG(NATUREZA, ', ') AS NATUREZAS,
  MIN(RECEBIMENTO)           AS RECEBIMENTO,
  MIN(EMISSAO)               AS EMISSAO,
  MAX(CAST(DEVOLUCAO AS TINYINT))     AS DEVOLUCAO,
  MAX(CAST(TRANSF_FILIAL AS TINYINT)) AS TRANSF_FILIAL,
  MAX(PDF_ENTRADA)           AS PDF_ENTRADA
FROM sem_duplicata
WHERE RN = 1
GROUP BY CHAVE_NFE;
GO

PRINT 'View VW_KING_PORTAL_NOTAS criada/atualizada.';
GO
