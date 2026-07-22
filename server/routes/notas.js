// Notas fiscais: a lista vem do Linx (VW_KING_PORTAL_NOTAS) e o portal cobra o
// PDF de cada uma. Quem anexa não digita nada — o número e o valor são lidos do
// DANFE e conferidos contra o que está lançado na ENTRADAS.
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, queryOne, transaction } from '../sqlserver.js';
import { registrarAuditoria } from '../auditoria.js';
import { parseDanfe } from '../danfe.js';
import { requireAuth, requireRole } from '../auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const CUTOFF = process.env.ENTRADAS_CUTOFF || '2026-07-16';
const STATUSES = [
  'Aguardando análise', 'Conferido',
  'Fazer Carta de Correção', 'Lançamento incorreto',
  'Nota cancelada', 'Devolvida ao fornecedor',
];
// Voltam ao setor de origem para correção e reenvio.
const DEVOLVIDOS = ['Fazer Carta de Correção', 'Lançamento incorreto'];
// Encerram a nota: o fornecedor terá de emitir outra, então não há reenvio.
const ENCERRADOS = ['Nota cancelada', 'Devolvida ao fornecedor'];
const SEM_ANEXO = 'Aguardando anexo';
// Diferença aceita entre o total do PDF e o lançado. Cobre arredondamento de
// centavo; qualquer coisa acima disso é divergência real.
const TOLERANCIA = 0.01;
// Um PDF por nota: cada NF-e tem número próprio e lançamento próprio na
// ENTRADAS, então não faz sentido somar documentos diferentes num mesmo
// lançamento. O plural na plumbing fica só porque o histórico de anexos
// guarda uma linha por arquivo enviado.
const MAX_PDFS = 1;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.pdf`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});

function tamanhoLegivel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** Compara números de nota ignorando zeros à esquerda e espaços. */
function mesmoNumero(a, b) {
  const limpa = v => String(v ?? '').trim().replace(/^0+/, '');
  return limpa(a) === limpa(b) && limpa(a) !== '';
}

async function gerarProtocolo(run) {
  const ano = new Date().getFullYear();
  const linhas = await run(`
    SELECT TOP 1 PROTOCOLO FROM dbo.KING_PORTAL_ENTRADAS WITH (UPDLOCK, HOLDLOCK)
    WHERE PROTOCOLO LIKE @prefixo ORDER BY PROTOCOLO DESC
  `, { prefixo: `PROT-${ano}-%` });
  const ultimo = linhas[0] ? Number(String(linhas[0].PROTOCOLO).match(/(\d+)$/)?.[1] || 1000) : 1000;
  return `PROT-${ano}-${String(ultimo + 1).padStart(6, '0')}`;
}

async function buscarNota(chave) {
  return queryOne(`
    SELECT n.*, p.ID AS PROTOCOLO_ID, p.PROTOCOLO, p.STATUS, p.SETOR_ORIGEM, p.SETOR_DESTINO,
           p.RESPONSAVEL_NOME, p.RESPONSAVEL_LOGIN, p.NUMERO_PDF, p.VALOR_PDF,
           p.OBSERVACOES, p.CRIADO_EM, p.ATUALIZADO_EM
    FROM dbo.VW_KING_PORTAL_NOTAS n
    LEFT JOIN dbo.KING_PORTAL_ENTRADAS p ON p.CHAVE_NFE = n.CHAVE_NFE
    WHERE n.CHAVE_NFE = @chave AND n.DATA_LANCAMENTO >= @corte
  `, { chave, corte: CUTOFF });
}

function mapNota(r) {
  return {
    chaveNfe: r.CHAVE_NFE,
    invoice: r.NF_ENTRADA,
    serie: r.SERIE_NF_ENTRADA,
    supplier: r.NOME_CLIFOR,
    branch: r.FILIAL,
    branchCount: r.QTD_FILIAIS,
    amount: Number(r.VALOR_TOTAL),
    launchCount: r.QTD_LANCAMENTOS,
    naturezas: r.NATUREZAS,
    receivedAt: dataSomente(r.RECEBIMENTO),
    launchedAt: dataSomente(r.DATA_LANCAMENTO),
    issuedAt: dataSomente(r.EMISSAO),
    protocol: r.PROTOCOLO || null,
    status: r.STATUS || SEM_ANEXO,
    hasFile: !!r.PROTOCOLO,
    origin: r.SETOR_ORIGEM || null,
    destination: r.SETOR_DESTINO || null,
    responsible: r.RESPONSAVEL_NOME || null,
    notes: r.OBSERVACOES || null,
    // ATUALIZADO_EM é instante real (tem hora); DATA_LANCAMENTO é só o dia.
    updatedAt: r.ATUALIZADO_EM || dataSomente(r.DATA_LANCAMENTO),
  };
}

/**
 * DATA_DIGITACAO e RECEBIMENTO são datas puras (meia-noite). O driver devolve
 * como instante UTC, e formatar isso em -03:00 exibe 21:00 do dia ANTERIOR.
 * Para esses campos vale só o dia, então saem como 'YYYY-MM-DD' e o front
 * mostra sem conversão de fuso.
 */
const dataSomente = v => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

const brl = v => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

/**
 * Confere o PDF contra o que está lançado.
 *
 *   número → igual ao NF_ENTRADA do lançamento
 *   valor  → igual ao VALOR_TOTAL (tolerância de centavo)
 *
 * O emitente de propósito não entra: no PDF vem a razão social e no Linx o
 * NOME_CLIFOR, que são cadastros diferentes (HESSO x LAVANDERIA VAY-VAY).
 */
async function conferirPdfs(caminhos, nota) {
  const arquivos = [];
  for (const c of caminhos) {
    const d = await parseDanfe(fs.readFileSync(c.path));
    arquivos.push({
      nome: c.originalname,
      numero: d.invoice,
      valor: d.valor,
      chave: d.chave,
      lido: !!(d.invoice || d.valor),
    });
  }

  const divergencias = [];
  const ilegiveis = arquivos.filter(a => !a.lido);
  if (ilegiveis.length) {
    divergencias.push(`Não foi possível ler: ${ilegiveis.map(a => a.nome).join(', ')} (pode ser scan/imagem).`);
  }

  const numeroLancado = String(nota.NF_ENTRADA).trim();
  if (!arquivos.some(a => mesmoNumero(a.numero, numeroLancado))) {
    const lidos = arquivos.map(a => a.numero ?? '—').join(', ');
    divergencias.push(`Número da nota: PDF ${lidos} · lançado ${numeroLancado}`);
  }

  const somaPdf = arquivos.reduce((s, a) => s + (a.valor || 0), 0);
  const valorLancado = Number(nota.VALOR_TOTAL);
  if (Math.abs(somaPdf - valorLancado) > TOLERANCIA) {
    divergencias.push(`Valor: PDF ${brl(somaPdf)} · lançado ${brl(valorLancado)}`);
  }

  return {
    ok: divergencias.length === 0,
    arquivos,
    somaPdf,
    valorLancado,
    divergencias,
  };
}

/** Espelha o status na ENTRADAS. Todas as linhas da chave recebem o valor. */
async function espelharStatus(run, chave, status) {
  await run('UPDATE dbo.ENTRADAS SET PDF_ENTRADA = @status WHERE CHAVE_NFE = @chave', { status, chave });
}

const router = express.Router();
router.use(requireAuth);

// GET /api/documents — notas lançadas a partir do corte, com o status do PDF.
router.get('/', async (req, res) => {
  const { search, status, branch } = req.query || {};
  const where = ['n.DATA_LANCAMENTO >= @corte'];
  const params = { corte: CUTOFF };

  if (branch) { where.push('n.FILIAL = @branch'); params.branch = String(branch); }
  if (status) {
    if (status === SEM_ANEXO) where.push('p.STATUS IS NULL');
    else { where.push('p.STATUS = @status'); params.status = String(status); }
  }
  if (search) {
    where.push(`(n.NF_ENTRADA LIKE @q OR n.NOME_CLIFOR LIKE @q OR n.FILIAL LIKE @q
                 OR n.CHAVE_NFE LIKE @q OR p.PROTOCOLO LIKE @q)`);
    params.q = `%${String(search)}%`;
  }

  const rows = await query(`
    SELECT n.*, p.PROTOCOLO, p.STATUS, p.SETOR_ORIGEM, p.SETOR_DESTINO,
           p.RESPONSAVEL_NOME, p.OBSERVACOES, p.ATUALIZADO_EM,
           -- Última observação do fluxo: é o "motivo" exibido nas filas.
           ultima.OBSERVACAO AS ULTIMA_OBS,
           CASE WHEN reenvio.CHAVE_NFE IS NULL THEN 0 ELSE 1 END AS REENVIADA
    FROM dbo.VW_KING_PORTAL_NOTAS n
    LEFT JOIN dbo.KING_PORTAL_ENTRADAS p ON p.CHAVE_NFE = n.CHAVE_NFE
    OUTER APPLY (
      SELECT TOP 1 a.OBSERVACAO FROM dbo.KING_PORTAL_ENTRADAS_AUDITORIA a
      WHERE a.CHAVE_NFE = n.CHAVE_NFE ORDER BY a.SEQ DESC
    ) ultima
    OUTER APPLY (
      SELECT TOP 1 a.CHAVE_NFE FROM dbo.KING_PORTAL_ENTRADAS_AUDITORIA a
      WHERE a.CHAVE_NFE = n.CHAVE_NFE AND a.ACAO LIKE '%reenviado%'
    ) reenvio
    WHERE ${where.join(' AND ')}
    ORDER BY n.DATA_LANCAMENTO DESC
  `, params);

  res.json({
    documents: rows.map(r => ({ ...mapNota(r), lastNote: r.ULTIMA_OBS || null, resent: !!r.REENVIADA })),
    total: rows.length,
  });
});

// GET /api/documents/filiais — para o filtro da tela.
router.get('/filiais', async (req, res) => {
  const rows = await query(`
    SELECT DISTINCT FILIAL FROM dbo.VW_KING_PORTAL_NOTAS
    WHERE DATA_LANCAMENTO >= @corte ORDER BY FILIAL
  `, { corte: CUTOFF });
  res.json({ items: rows.map(r => r.FILIAL) });
});

// GET /api/documents/:chave — detalhe com anexos e histórico.
router.get('/:chave', async (req, res) => {
  const nota = await buscarNota(req.params.chave);
  if (!nota) return res.status(404).json({ error: 'Nota não encontrada.' });

  const doc = mapNota(nota);
  doc.files = nota.PROTOCOLO_ID ? (await query(`
    SELECT VERSAO, ENVIO, ARQUIVO_NOME, ARQUIVO_TAMANHO, ENVIADO_POR, ENVIADO_EM,
           OBSERVACAO, NUMERO_PDF, VALOR_PDF
    FROM dbo.KING_PORTAL_ENTRADAS_ANEXOS WHERE PROTOCOLO_ID = @id ORDER BY VERSAO DESC
  `, { id: nota.PROTOCOLO_ID })).map(f => ({
    version: f.VERSAO, envio: f.ENVIO, file_name: f.ARQUIVO_NOME, file_size: f.ARQUIVO_TAMANHO,
    uploaded_by: f.ENVIADO_POR, uploaded_at: f.ENVIADO_EM, note: f.OBSERVACAO,
    numero: f.NUMERO_PDF, valor: f.VALOR_PDF == null ? null : Number(f.VALOR_PDF),
  })) : [];

  doc.history = (await query(`
    SELECT OCORRIDO_EM, USUARIO_NOME, SETOR_ORIGEM, SETOR_DESTINO, ACAO, OBSERVACAO
    FROM dbo.KING_PORTAL_ENTRADAS_AUDITORIA WHERE CHAVE_NFE = @chave ORDER BY SEQ ASC
  `, { chave: req.params.chave })).map(h => ({
    at: h.OCORRIDO_EM, user: h.USUARIO_NOME, sector: h.SETOR_ORIGEM,
    origin: h.SETOR_ORIGEM, destination: h.SETOR_DESTINO, action: h.ACAO, note: h.OBSERVACAO,
  }));

  res.json({ document: doc });
});

// GET /api/documents/:chave/file[/:versao] — abre o PDF (última versão por padrão).
router.get('/:chave/file/:versao?', async (req, res) => {
  const anexo = await queryOne(`
    SELECT TOP 1 a.ARQUIVO_CAMINHO, a.ARQUIVO_NOME
    FROM dbo.KING_PORTAL_ENTRADAS_ANEXOS a
    JOIN dbo.KING_PORTAL_ENTRADAS p ON p.ID = a.PROTOCOLO_ID
    WHERE p.CHAVE_NFE = @chave ${req.params.versao ? 'AND a.VERSAO = @versao' : ''}
    ORDER BY a.VERSAO DESC
  `, req.params.versao ? { chave: req.params.chave, versao: Number(req.params.versao) } : { chave: req.params.chave });

  if (!anexo?.ARQUIVO_CAMINHO || !fs.existsSync(anexo.ARQUIVO_CAMINHO)) {
    return res.status(404).json({ error: 'Arquivo não encontrado.' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(anexo.ARQUIVO_NOME)}"`);
  fs.createReadStream(anexo.ARQUIVO_CAMINHO).pipe(res);
});

// POST /:chave/conferir — lê o PDF e devolve o resultado da conferência sem
// gravar nada. Serve para avisar o usuário assim que ele escolhe o arquivo,
// em vez de só na hora de enviar.
router.post('/:chave/conferir', requireRole('conferente', 'administrador'), upload.array('file', MAX_PDFS), async (req, res) => {
  const arquivos = req.files || [];
  if (!arquivos.length) return res.status(400).json({ error: 'Envie ao menos um PDF.' });
  const apagar = () => arquivos.forEach(f => fs.unlink(f.path, () => {}));
  try {
    const nota = await buscarNota(req.params.chave);
    if (!nota) { apagar(); return res.status(404).json({ error: 'Nota não encontrada.' }); }
    const r = await conferirPdfs(arquivos, nota);
    apagar();
    res.json({
      ok: r.ok, divergencias: r.divergencias, arquivos: r.arquivos,
      somaPdf: r.somaPdf, valorLancado: r.valorLancado,
    });
  } catch (err) {
    apagar();
    res.status(422).json({ error: 'Não foi possível ler o PDF.', detail: err.message });
  }
});

// POST /api/documents/:chave/anexar — anexa o PDF e protocola a nota.
router.post('/:chave/anexar', requireRole('conferente', 'administrador'), upload.array('file', MAX_PDFS), async (req, res) => {
  const user = req.session.user;
  const chave = req.params.chave;
  const arquivos = req.files || [];
  const limpar = () => arquivos.forEach(f => fs.unlink(f.path, () => {}));

  if (!arquivos.length) return res.status(400).json({ error: 'Anexe o PDF da nota.' });
  if (!user.sector) { limpar(); return res.status(400).json({ error: 'Seu usuário não tem setor definido. Peça ao administrador.' }); }

  const nota = await buscarNota(chave);
  if (!nota) { limpar(); return res.status(404).json({ error: 'Nota não encontrada.' }); }
  if (nota.PROTOCOLO) { limpar(); return res.status(409).json({ error: `Esta nota já foi protocolada (${nota.PROTOCOLO}).` }); }

  const conferencia = await conferirPdfs(arquivos, nota);
  if (!conferencia.ok) {
    limpar();
    return res.status(422).json({ error: 'O PDF não confere com a nota lançada.', divergencias: conferencia.divergencias });
  }

  const agora = new Date();
  const observacao = req.body?.note?.trim() || null;
  // O número que representa a nota é o do PDF que casa com o lançamento.
  const principal = conferencia.arquivos.find(a => mesmoNumero(a.numero, String(nota.NF_ENTRADA).trim()));
  try {
    const protocolo = await transaction(async run => {
      const numero = await gerarProtocolo(run);
      const inserido = await run(`
        INSERT INTO dbo.KING_PORTAL_ENTRADAS
          (PROTOCOLO, CHAVE_NFE, NF_ENTRADA, SERIE_NF_ENTRADA, NOME_CLIFOR, STATUS,
           SETOR_ORIGEM, SETOR_DESTINO, RESPONSAVEL_LOGIN, RESPONSAVEL_NOME,
           NUMERO_PDF, VALOR_PDF, OBSERVACOES, CRIADO_EM, ATUALIZADO_EM)
        OUTPUT INSERTED.ID
        VALUES (@protocolo, @chave, @nf, @serie, @clifor, 'Aguardando análise',
                @origem, 'Fiscal', @login, @nome, @numeroPdf, @valorPdf, @obs, @agora, @agora)
      `, {
        protocolo: numero, chave,
        nf: String(nota.NF_ENTRADA).trim(),
        serie: String(nota.SERIE_NF_ENTRADA).trim(),
        clifor: nota.NOME_CLIFOR,
        origem: user.sector, login: user.login, nome: user.name,
        numeroPdf: principal?.numero ?? null, valorPdf: conferencia.somaPdf,
        obs: observacao, agora,
      });
      const protocoloId = inserido[0].ID;

      // Cada PDF vira uma linha; ENVIO 1 marca que vieram juntos no original.
      for (let i = 0; i < arquivos.length; i++) {
        const f = arquivos[i];
        const lido = conferencia.arquivos[i];
        await run(`
          INSERT INTO dbo.KING_PORTAL_ENTRADAS_ANEXOS
            (PROTOCOLO_ID, VERSAO, ENVIO, ARQUIVO_NOME, ARQUIVO_CAMINHO, ARQUIVO_TAMANHO, MIME,
             ENVIADO_POR, ENVIADO_EM, OBSERVACAO, NUMERO_PDF, VALOR_PDF)
          VALUES (@id, @versao, 1, @nome, @caminho, @tamanho, 'application/pdf',
                  @login, @agora, 'Anexo original', @numero, @valor)
        `, {
          id: protocoloId, versao: i + 1, nome: f.originalname, caminho: f.path,
          tamanho: tamanhoLegivel(f.size), login: user.login, agora,
          numero: lido.numero ?? null, valor: lido.valor ?? null,
        });
      }

      await espelharStatus(run, chave, 'Aguardando análise');
      await registrarAuditoria(run, {
        ocorridoEm: agora, usuarioLogin: user.login, usuarioNome: user.name,
        setorOrigem: user.sector, setorDestino: 'Fiscal',
        acao: 'PDF anexado e nota encaminhada',
        protocolo: numero, protocoloId, chaveNfe: chave,
        observacao: observacao || `Arquivo ${arquivos[0].originalname} conferido: número e valor batem com o lançamento.`,
        detalhe: {
          nf: String(nota.NF_ENTRADA).trim(),
          valorLancado: Number(nota.VALOR_TOTAL),
          somaPdf: conferencia.somaPdf,
          arquivos: conferencia.arquivos.map(a => ({ nome: a.nome, numero: a.numero, valor: a.valor })),
        },
      });
      return numero;
    });

    // Evita repetir a consulta pesada da view: o estado resultante já é
    // conhecido (a nota vira "Aguardando análise" com o protocolo recém-criado).
    res.status(201).json({
      document: { ...mapNota(nota), protocol: protocolo, status: 'Aguardando análise', hasFile: true },
      protocol: protocolo,
    });
  } catch (err) {
    limpar();
    res.status(500).json({ error: 'Falha ao protocolar a nota.', detail: err.message });
  }
});

// POST /api/documents/:chave/status — conferência do Fiscal.
router.post('/:chave/status', requireRole('fiscal', 'administrador'), async (req, res) => {
  const user = req.session.user;
  const { status, note } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Status inválido.' });
  if (!note?.trim()) return res.status(400).json({ error: 'Observação da movimentação é obrigatória.' });

  const nota = await buscarNota(req.params.chave);
  if (!nota?.PROTOCOLO) return res.status(404).json({ error: 'Nota ainda não protocolada.' });

  const agora = new Date();
  // Devolvida para correção volta ao setor de origem; encerrada não vai a
  // lugar nenhum (o fornecedor emite outra nota); o resto fica no Fiscal.
  const destino = DEVOLVIDOS.includes(status) ? nota.SETOR_ORIGEM
    : ENCERRADOS.includes(status) ? 'Encerrado'
    : 'Fiscal';

  await transaction(async run => {
    await run(`
      UPDATE dbo.KING_PORTAL_ENTRADAS
      SET STATUS = @status, SETOR_DESTINO = @destino, ATUALIZADO_EM = @agora
      WHERE CHAVE_NFE = @chave
    `, { status, destino, agora, chave: req.params.chave });
    await espelharStatus(run, req.params.chave, status);
    await registrarAuditoria(run, {
      ocorridoEm: agora, usuarioLogin: user.login, usuarioNome: user.name,
      setorOrigem: user.sector || 'Fiscal', setorDestino: destino,
      acao: `Status alterado de ${nota.STATUS} para ${status}`,
      protocolo: nota.PROTOCOLO, protocoloId: nota.PROTOCOLO_ID, chaveNfe: req.params.chave,
      observacao: note.trim(),
      detalhe: { de: nota.STATUS, para: status },
    });
  });

  res.json({ document: { ...mapNota(nota), status, destination: destino } });
});

// POST /api/documents/:chave/reenviar — conferente corrige e devolve ao Fiscal.
router.post('/:chave/reenviar', requireRole('conferente', 'administrador'), upload.array('file', MAX_PDFS), async (req, res) => {
  const user = req.session.user;
  const chave = req.params.chave;
  const arquivos = req.files || [];
  const limpar = () => arquivos.forEach(f => fs.unlink(f.path, () => {}));

  const nota = await buscarNota(chave);
  if (!nota?.PROTOCOLO) { limpar(); return res.status(404).json({ error: 'Nota ainda não protocolada.' }); }
  if (ENCERRADOS.includes(nota.STATUS)) {
    limpar();
    return res.status(400).json({
      error: `Nota encerrada como "${nota.STATUS}". O fornecedor precisa emitir uma nova nota, que entrará no portal por conta própria.`,
    });
  }
  if (!DEVOLVIDOS.includes(nota.STATUS)) {
    limpar();
    return res.status(400).json({ error: 'Só é possível reenviar notas devolvidas pelo Fiscal.' });
  }
  if (!arquivos.length) return res.status(400).json({ error: 'Anexe o documento da correção para reenviar.' });

  // A conferência depende do que se espera receber em cada caso:
  //
  //   Fazer Carta de Correção → CC-e, que é outro documento e não carrega o
  //     número nem o valor da NF-e. Conferir reprovaria todo envio legítimo.
  //   Lançamento incorreto    → o lançamento foi refeito e volta o DANFE da
  //     nota, que precisa bater com o que está na ENTRADAS.
  //
  // Nos dois casos os campos são lidos, para registrar o que foi anexado.
  const conferencia = await conferirPdfs(arquivos, nota);
  if (nota.STATUS === 'Lançamento incorreto' && !conferencia.ok) {
    limpar();
    return res.status(422).json({
      error: 'O PDF não confere com a nota lançada.',
      divergencias: conferencia.divergencias,
    });
  }

  const observacao = req.body?.note?.trim() || 'Documento corrigido e reenviado para conferência.';
  const agora = new Date();

  await transaction(async run => {
    // O anexo anterior NÃO é removido: cada versão é a prova do que foi
    // enviado em cada etapa.
    const proxima = await run(
      `SELECT COALESCE(MAX(VERSAO), 0) AS V, COALESCE(MAX(ENVIO), 0) + 1 AS E
       FROM dbo.KING_PORTAL_ENTRADAS_ANEXOS WHERE PROTOCOLO_ID = @id`,
      { id: nota.PROTOCOLO_ID }
    );
    const envio = proxima[0].E;
    for (let i = 0; i < arquivos.length; i++) {
      const f = arquivos[i];
      const lido = conferencia.arquivos[i];
      await run(`
        INSERT INTO dbo.KING_PORTAL_ENTRADAS_ANEXOS
          (PROTOCOLO_ID, VERSAO, ENVIO, ARQUIVO_NOME, ARQUIVO_CAMINHO, ARQUIVO_TAMANHO, MIME,
           ENVIADO_POR, ENVIADO_EM, OBSERVACAO, NUMERO_PDF, VALOR_PDF)
        VALUES (@id, @versao, @envio, @nome, @caminho, @tamanho, 'application/pdf',
                @login, @agora, @obs, @numero, @valor)
      `, {
        id: nota.PROTOCOLO_ID, versao: proxima[0].V + i + 1, envio,
        nome: f.originalname, caminho: f.path, tamanho: tamanhoLegivel(f.size),
        login: user.login, agora, obs: observacao,
        numero: lido.numero ?? null, valor: lido.valor ?? null,
      });
    }
    await run(`
      UPDATE dbo.KING_PORTAL_ENTRADAS
      SET STATUS = 'Aguardando análise', SETOR_DESTINO = 'Fiscal', ATUALIZADO_EM = @agora
      WHERE CHAVE_NFE = @chave
    `, { agora, chave });
    await espelharStatus(run, chave, 'Aguardando análise');
    await registrarAuditoria(run, {
      ocorridoEm: agora, usuarioLogin: user.login, usuarioNome: user.name,
      setorOrigem: nota.SETOR_ORIGEM, setorDestino: 'Fiscal',
      acao: 'Documento reenviado para conferência',
      protocolo: nota.PROTOCOLO, protocoloId: nota.PROTOCOLO_ID, chaveNfe: chave,
      observacao,
      detalhe: { de: nota.STATUS, para: 'Aguardando análise', envio, arquivos: conferencia.arquivos.length },
    });
  });

  res.json({ document: { ...mapNota(nota), status: 'Aguardando análise', destination: 'Fiscal' } });
});

export default router;
