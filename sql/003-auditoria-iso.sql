/* ============================================================================
   Torna a cadeia de hash imune à semântica de data do driver.

   O hash era calculado sobre ocorridoEm.toISOString() na gravação e recalculado
   sobre o DATETIME2 lido de volta. Qualquer diferença nesse caminho de ida e
   volta — precisão (DATETIME x DATETIME2) ou fuso (a VM roda em -03:00) —
   quebra a cadeia sem que ninguém tenha adulterado nada. Aconteceu duas vezes.

   A partir daqui, o instante entra no hash como a string exata que também fica
   gravada em OCORRIDO_EM_ISO. Não há conversão no meio: o que foi hasheado é,
   literalmente, o que está na coluna. OCORRIDO_EM continua existindo para
   ordenar, filtrar e exibir.
   ============================================================================ */

USE [KINGEJOE];
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.KING_PORTAL_ENTRADAS_AUDITORIA')
    AND name = 'OCORRIDO_EM_ISO'
)
BEGIN
  ALTER TABLE dbo.KING_PORTAL_ENTRADAS_AUDITORIA
    ADD OCORRIDO_EM_ISO VARCHAR(30) NULL;
END
GO

/* A cadeia antiga foi gravada com o formato anterior e não pode ser validada
   pelo novo. Como ainda não estamos em produção, zera. TRUNCATE é DDL e não
   dispara o trigger de DELETE — por isso funciona numa tabela append-only. */
TRUNCATE TABLE dbo.KING_PORTAL_ENTRADAS_AUDITORIA;
GO

PRINT 'Auditoria pronta: coluna OCORRIDO_EM_ISO criada e cadeia zerada.';
GO
