/* ============================================================================
   Fluxo Fiscal — Portal de Envio de Documentos
   Schema no SQL Server (KINGEJOE)

   Rodar uma vez. O script é idempotente: pode ser executado de novo sem erro.

   A tabela dbo.ENTRADAS é do Linx. A única alteração feita nela é a coluna
   PDF_ENTRADA (nullable, sem default) — nenhum INSERT existente é afetado.
   ============================================================================ */

USE [KINGEJOE];
GO

/* ---------------------------------------------------------------------------
   1) Coluna de status do PDF na tabela do Linx.
   NULL = nota lançada mas sem PDF anexado (aguardando anexo).
   --------------------------------------------------------------------------- */
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.ENTRADAS') AND name = 'PDF_ENTRADA'
)
BEGIN
  ALTER TABLE dbo.ENTRADAS ADD PDF_ENTRADA VARCHAR(30) NULL;
END
GO

/* ---------------------------------------------------------------------------
   2) Protocolos — 1 linha por nota que teve PDF anexado.
   Vincula-se à ENTRADAS pela CHAVE_NFE (100% preenchida) e guarda também a
   PK composta do Linx para consulta direta.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.KING_PORTAL_ENTRADAS', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.KING_PORTAL_ENTRADAS (
    ID                 INT IDENTITY(1,1) NOT NULL,
    PROTOCOLO          VARCHAR(20)   NOT NULL,

    -- Elo com dbo.ENTRADAS
    CHAVE_NFE          VARCHAR(44)   NOT NULL,
    NF_ENTRADA         VARCHAR(15)   NOT NULL,   -- guardado sem espaços
    SERIE_NF_ENTRADA   VARCHAR(6)    NOT NULL,
    NOME_CLIFOR        VARCHAR(25)   NOT NULL,

    STATUS             VARCHAR(30)   NOT NULL,
    SETOR_ORIGEM       VARCHAR(50)   NOT NULL,
    SETOR_DESTINO      VARCHAR(50)   NOT NULL,
    RESPONSAVEL_LOGIN  VARCHAR(50)   NOT NULL,
    RESPONSAVEL_NOME   VARCHAR(120)  NOT NULL,

    -- O que o PDF declarava no momento da conferência (prova)
    NUMERO_PDF         VARCHAR(15)   NULL,
    VALOR_PDF          NUMERIC(15,2) NULL,

    OBSERVACOES        VARCHAR(1000) NULL,
    CRIADO_EM          DATETIME2(3)  NOT NULL,
    ATUALIZADO_EM      DATETIME2(3)  NOT NULL,

    CONSTRAINT PK_KING_PORTAL_ENTRADAS PRIMARY KEY CLUSTERED (ID),
    CONSTRAINT UQ_KING_PORTAL_ENTRADAS_PROTOCOLO UNIQUE (PROTOCOLO),
    -- Uma nota só pode ter um protocolo: impede duplicidade de lançamento.
    CONSTRAINT UQ_KING_PORTAL_ENTRADAS_CHAVE UNIQUE (CHAVE_NFE)
  );

  CREATE INDEX IX_KING_PORTAL_ENTRADAS_STATUS
    ON dbo.KING_PORTAL_ENTRADAS (STATUS);
  CREATE INDEX IX_KING_PORTAL_ENTRADAS_NOTA
    ON dbo.KING_PORTAL_ENTRADAS (NF_ENTRADA, SERIE_NF_ENTRADA, NOME_CLIFOR);
END
GO

/* ---------------------------------------------------------------------------
   3) Anexos — versões do PDF. O arquivo anterior nunca é descartado:
   a nota errada é a prova do que foi lançado errado.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.KING_PORTAL_ENTRADAS_ANEXOS', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.KING_PORTAL_ENTRADAS_ANEXOS (
    ID                INT IDENTITY(1,1) NOT NULL,
    PROTOCOLO_ID      INT           NOT NULL,
    VERSAO            INT           NOT NULL,
    ARQUIVO_NOME      NVARCHAR(255) NOT NULL,
    ARQUIVO_CAMINHO   NVARCHAR(500) NOT NULL,
    ARQUIVO_TAMANHO   VARCHAR(20)   NULL,
    MIME              VARCHAR(100)  NULL,
    ENVIADO_POR       VARCHAR(50)   NOT NULL,
    ENVIADO_EM        DATETIME2(3)  NOT NULL,
    OBSERVACAO        VARCHAR(1000) NULL,

    CONSTRAINT PK_KING_PORTAL_ENTRADAS_ANEXOS PRIMARY KEY CLUSTERED (ID),
    CONSTRAINT UQ_KING_PORTAL_ENTRADAS_ANEXOS_VERSAO UNIQUE (PROTOCOLO_ID, VERSAO),
    CONSTRAINT FK_KING_PORTAL_ENTRADAS_ANEXOS_PROTOCOLO
      FOREIGN KEY (PROTOCOLO_ID) REFERENCES dbo.KING_PORTAL_ENTRADAS (ID)
  );
END
GO

/* ---------------------------------------------------------------------------
   4) Auditoria — ledger append-only com hash encadeado.
   Cada linha guarda o hash da anterior (HASH_ANTERIOR -> HASH), então qualquer
   adulteração quebra a cadeia e é detectável por verificação.
   Sem FK para protocolos: também registra login/logout, que não têm nota.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.KING_PORTAL_ENTRADAS_AUDITORIA', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.KING_PORTAL_ENTRADAS_AUDITORIA (
    SEQ            BIGINT IDENTITY(1,1) NOT NULL,
    OCORRIDO_EM    DATETIME2(3)   NOT NULL,
    USUARIO_LOGIN  VARCHAR(50)    NOT NULL,
    USUARIO_NOME   VARCHAR(120)   NOT NULL,
    SETOR_ORIGEM   VARCHAR(50)    NULL,
    SETOR_DESTINO  VARCHAR(50)    NULL,
    ACAO           VARCHAR(200)   NOT NULL,
    PROTOCOLO      VARCHAR(20)    NULL,
    PROTOCOLO_ID   INT            NULL,
    CHAVE_NFE      VARCHAR(44)    NULL,
    OBSERVACAO     VARCHAR(2000)  NULL,
    DETALHE        NVARCHAR(MAX)  NULL,   -- JSON
    HASH_ANTERIOR  CHAR(64)       NOT NULL,
    HASH           CHAR(64)       NOT NULL,

    CONSTRAINT PK_KING_PORTAL_ENTRADAS_AUDITORIA PRIMARY KEY CLUSTERED (SEQ)
  );

  CREATE INDEX IX_KING_PORTAL_ENTRADAS_AUDITORIA_PROTOCOLO
    ON dbo.KING_PORTAL_ENTRADAS_AUDITORIA (PROTOCOLO_ID);
  CREATE INDEX IX_KING_PORTAL_ENTRADAS_AUDITORIA_DATA
    ON dbo.KING_PORTAL_ENTRADAS_AUDITORIA (OCORRIDO_EM);
END
GO

/* Bloqueio de alteração: a auditoria só aceita INSERT.
   INSTEAD OF dispara antes da operação e aborta com erro. */
IF OBJECT_ID('dbo.TR_KING_PORTAL_AUDITORIA_NO_UPDATE', 'TR') IS NOT NULL
  DROP TRIGGER dbo.TR_KING_PORTAL_AUDITORIA_NO_UPDATE;
GO
CREATE TRIGGER dbo.TR_KING_PORTAL_AUDITORIA_NO_UPDATE
ON dbo.KING_PORTAL_ENTRADAS_AUDITORIA
INSTEAD OF UPDATE
AS
BEGIN
  THROW 51000, 'KING_PORTAL_ENTRADAS_AUDITORIA e append-only: UPDATE proibido.', 1;
END
GO

IF OBJECT_ID('dbo.TR_KING_PORTAL_AUDITORIA_NO_DELETE', 'TR') IS NOT NULL
  DROP TRIGGER dbo.TR_KING_PORTAL_AUDITORIA_NO_DELETE;
GO
CREATE TRIGGER dbo.TR_KING_PORTAL_AUDITORIA_NO_DELETE
ON dbo.KING_PORTAL_ENTRADAS_AUDITORIA
INSTEAD OF DELETE
AS
BEGIN
  THROW 51001, 'KING_PORTAL_ENTRADAS_AUDITORIA e append-only: DELETE proibido.', 1;
END
GO

/* ---------------------------------------------------------------------------
   5) Usuários do portal. Identidade vem do AD; a senha é local (scrypt).
   FILIAL e SETOR definem o que a pessoa enxerga e de onde a nota sai.
   --------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.KING_PORTAL_ENTRADAS_USUARIOS', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.KING_PORTAL_ENTRADAS_USUARIOS (
    LOGIN          VARCHAR(50)   NOT NULL,
    NOME           VARCHAR(120)  NOT NULL,
    SENHA          VARCHAR(200)  NOT NULL,   -- "salt:hash" (scrypt)
    PAPEL          VARCHAR(20)   NULL,       -- administrador | fiscal | conferente
    SITUACAO       VARCHAR(20)   NOT NULL,   -- pendente | ativo | inativo
    FILIAL         VARCHAR(25)   NULL,
    SETOR          VARCHAR(50)   NULL,
    CRIADO_EM      DATETIME2(3)  NOT NULL,
    ATUALIZADO_EM  DATETIME2(3)  NOT NULL,
    ULTIMO_LOGIN   DATETIME2(3)  NULL,

    CONSTRAINT PK_KING_PORTAL_ENTRADAS_USUARIOS PRIMARY KEY CLUSTERED (LOGIN)
  );
END
GO

PRINT 'Schema do Fluxo Fiscal criado/verificado com sucesso.';
GO
