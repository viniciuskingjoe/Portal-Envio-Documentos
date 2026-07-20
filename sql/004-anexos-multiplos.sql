/* ============================================================================
   Permite mais de um PDF por nota.

   Caso real: industrialização com nota de retorno. O lançamento no Linx tem o
   valor total, mas os documentos físicos são dois (a nota principal e a de
   retorno). Conferir um PDF isolado faria o número bater e o valor não.

   VERSAO continua única e sequencial dentro do protocolo — é o histórico
   completo, e nada é descartado. ENVIO agrupa os PDFs que foram enviados
   juntos: o envio 1 é o original, o 2 é a correção, e assim por diante.
   ============================================================================ */

USE [KINGEJOE];
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.KING_PORTAL_ENTRADAS_ANEXOS') AND name = 'ENVIO'
)
BEGIN
  ALTER TABLE dbo.KING_PORTAL_ENTRADAS_ANEXOS ADD ENVIO INT NULL;
  EXEC('UPDATE dbo.KING_PORTAL_ENTRADAS_ANEXOS SET ENVIO = VERSAO WHERE ENVIO IS NULL');
END
GO

/* Número e valor lidos de cada PDF: é o que foi conferido no momento do envio.
   Guardar por anexo permite reconstruir a conferência depois. */
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.KING_PORTAL_ENTRADAS_ANEXOS') AND name = 'NUMERO_PDF'
)
BEGIN
  ALTER TABLE dbo.KING_PORTAL_ENTRADAS_ANEXOS ADD NUMERO_PDF VARCHAR(15) NULL;
  ALTER TABLE dbo.KING_PORTAL_ENTRADAS_ANEXOS ADD VALOR_PDF NUMERIC(15,2) NULL;
END
GO

PRINT 'Anexos prontos para múltiplos PDFs por nota.';
GO
