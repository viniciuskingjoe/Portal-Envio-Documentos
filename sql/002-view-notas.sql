/* ============================================================================
   VW_KING_PORTAL_NOTAS — a fonte que a tela Documentos consome.

   Resolve dois problemas encontrados na dbo.ENTRADAS:

   1) NF_ENTRADA é char(15) e às vezes vem com zeros à esquerda
      ('000272543') e às vezes não ('272543'). Aqui sai sempre normalizado.

   2) A mesma NF-e pode aparecer em mais de uma linha, variando só o padding
      (visto em 2026-07-20: chave ...120884 com '272543' e '000272543',
      demais campos idênticos). A view mantém uma linha por CHAVE_NFE.

   Observação sobre o corte de zeros: NÃO usar TRIM('0' FROM x) — no
   SQL Server 2019 o TRIM sem LEADING/TRAILING corta dos DOIS lados, o que
   transformaria a nota '1200' em '12'. O PATINDEX abaixo corta só à esquerda.
   ============================================================================ */

USE [KINGEJOE];
GO

CREATE OR ALTER VIEW dbo.VW_KING_PORTAL_NOTAS AS
WITH base AS (
  SELECT
    e.CHAVE_NFE,
    LTRIM(RTRIM(e.NF_ENTRADA))       AS NF_BRUTO,
    LTRIM(RTRIM(e.SERIE_NF_ENTRADA)) AS SERIE_NF_ENTRADA,
    e.NOME_CLIFOR,
    e.FILIAL,
    e.VALOR_TOTAL,
    e.RECEBIMENTO,
    e.EMISSAO,
    e.NATUREZA,
    e.TIPO_ENTRADAS,
    e.DEVOLUCAO,
    e.TRANSF_FILIAL,
    e.PDF_ENTRADA,
    -- Entre linhas da mesma NF-e fica a de número mais curto (sem os zeros).
    ROW_NUMBER() OVER (
      PARTITION BY e.CHAVE_NFE
      ORDER BY LEN(LTRIM(RTRIM(e.NF_ENTRADA))) ASC, e.NF_ENTRADA ASC
    ) AS RN
  FROM dbo.ENTRADAS e
  WHERE e.NOTA_CANCELADA = 0
    AND e.CHAVE_NFE IS NOT NULL
    AND e.CHAVE_NFE <> ''
)
SELECT
  CHAVE_NFE,
  -- Sem zeros à esquerda. O 'X' evita erro quando o número é só zeros.
  ISNULL(NULLIF(SUBSTRING(NF_BRUTO, PATINDEX('%[^0]%', NF_BRUTO + 'X'), 15), ''), '0')
    AS NF_ENTRADA,
  NF_BRUTO AS NF_ENTRADA_ORIGINAL,   -- preservado para voltar na ENTRADAS
  SERIE_NF_ENTRADA,
  NOME_CLIFOR,
  FILIAL,
  VALOR_TOTAL,
  RECEBIMENTO,
  EMISSAO,
  NATUREZA,
  TIPO_ENTRADAS,
  DEVOLUCAO,
  TRANSF_FILIAL,
  PDF_ENTRADA
FROM base
WHERE RN = 1;
GO

PRINT 'View VW_KING_PORTAL_NOTAS criada/atualizada.';
GO

/* ----------------------------------------------------------------------------
   Sentinela: a deduplicação assume que linhas com a mesma CHAVE_NFE são a
   MESMA nota. Isso vale para o caso encontrado (tudo idêntico menos o padding).
   Se algum dia duas linhas da mesma chave tiverem FILIAL ou VALOR diferentes,
   a view estaria escondendo informação real. Esta consulta acusa esse caso —
   vale rodar de vez em quando. Retornar vazio é o esperado.
   ---------------------------------------------------------------------------- */
SELECT CHAVE_NFE,
       COUNT(DISTINCT FILIAL)      AS FILIAIS_DISTINTAS,
       COUNT(DISTINCT VALOR_TOTAL) AS VALORES_DISTINTOS
FROM dbo.ENTRADAS
WHERE NOTA_CANCELADA = 0 AND CHAVE_NFE IS NOT NULL AND CHAVE_NFE <> ''
GROUP BY CHAVE_NFE
HAVING COUNT(DISTINCT FILIAL) > 1 OR COUNT(DISTINCT VALOR_TOTAL) > 1;
GO
