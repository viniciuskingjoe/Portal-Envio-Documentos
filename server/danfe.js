// Extração de campos de um DANFE (NF-e) em PDF de texto — sem OCR.
// Retorna { invoice, supplier, amount, chave } para pré-preencher o formulário.
// Só funciona com PDF de texto (gerado pelo sistema); scan/imagem retorna vazio.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Lê todo o texto do PDF e junta em uma linha só (normaliza espaços).
async function pdfToText(buffer) {
  const data = new Uint8Array(buffer);
  const doc = await getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out += ' ' + content.items.map(i => (i.str || '')).join(' ');
  }
  await doc.destroy();
  return out.replace(/\s+/g, ' ').trim();
}

// nNF = dígitos 26-34 da chave de acesso (1-indexed) → índice 25..33.
function invoiceFromChave(chave) {
  if (chave?.length !== 44) return null;
  return String(Number(chave.slice(25, 34))); // remove zeros à esquerda
}

/** "3.084,50" -> 3084.5 (formato brasileiro: ponto milhar, vírgula decimal). */
function valorParaNumero(texto) {
  const n = Number(String(texto).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export async function parseDanfe(buffer) {
  const text = await pdfToText(buffer);
  // `valor` é o total numérico, usado na conferência contra o VALOR_TOTAL da
  // ENTRADAS; `amount` é a versão formatada para exibição.
  const result = { invoice: null, supplier: null, amount: null, valor: null, chave: null };
  if (!text) return result;

  // Chave de acesso: 44 dígitos, em grupos de 4 separados por espaço.
  const chaveMatch = text.match(/\b(\d{4}(?:\s?\d{4}){10})\b/);
  if (chaveMatch) {
    const digits = chaveMatch[1].replace(/\D/g, '');
    if (digits.length === 44) {
      result.chave = digits;
      result.invoice = invoiceFromChave(digits);
    }
  }

  // Número da NF (fallback / confirmação): "Nº. 000.043.705".
  if (!result.invoice) {
    const nMatch = text.match(/N[ºo°]\.?\s*([\d.]+)/i);
    if (nMatch) result.invoice = String(Number(nMatch[1].replace(/\D/g, '')));
  }

  // Fornecedor (emitente): "RECEBEMOS DE <nome> OS PRODUTOS".
  const supMatch = text.match(/RECEBEMOS DE\s+(.+?)\s+OS PRODUTOS/i);
  if (supMatch) result.supplier = supMatch[1].trim();

  // Valor total da nota: "VALOR TOTAL: R$ 3.084,50".
  const valMatch = text.match(/VALOR TOTAL:\s*R\$\s*([\d.]+,\d{2})/i);
  if (valMatch) {
    result.amount = `R$ ${valMatch[1]}`;
    result.valor = valorParaNumero(valMatch[1]);
  }

  return result;
}
