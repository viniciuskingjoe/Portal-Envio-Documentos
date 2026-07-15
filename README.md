# Fluxo Fiscal — Portal de Envio de Documentos

Aplicação web para **envio, recebimento, conferência, protocolo e auditoria** de documentos fiscais. O trânsito físico de papel é substituído por um fluxo virtual rastreável: cada documento gera um **protocolo**, é encaminhado ao setor Fiscal e toda ação fica registrada num **log de auditoria append-only** com hash encadeado (à prova de adulteração).

## Recursos

- Cadastro de documento fiscal com anexo (PDF/JPG/PNG/WEBP até 10 MB) ou captura pela câmera no celular.
- Identificação de filial, setor de origem, fornecedor e número da nota fiscal.
- Geração automática de protocolo (`PROT-AAAA-NNNNNN`).
- Encaminhamento virtual ao setor Fiscal.
- Status: **Aguardando análise**, **Conferido**, **Pendente**, **Lançamento incorreto**.
- Registro de observações e correções por movimentação.
- Histórico completo por documento.
- **Log de auditoria imutável** com usuário, data/hora, setor de origem/destino e ação — encadeado por hash SHA-256 (`prev_hash`), com triggers que bloqueiam UPDATE/DELETE e endpoint de verificação de integridade.
- Autenticação via **Active Directory (LDAP)** — o log registra o usuário real do domínio.
- Pesquisa, filtros e exportação do log em CSV.
- Layout responsivo (desktop, tablet, celular).

## Arquitetura

| Camada | Tecnologia |
|--------|-----------|
| Backend | Node.js 22.5+ / 24 + Express (ESM) |
| Banco | SQLite via `node:sqlite` builtin (WAL) — zero deps nativas |
| Auth | Active Directory / LDAP (`ldapjs`) + `express-session` |
| Upload | `multer` → filesystem (`uploads/`) |
| Front | HTML + CSS + JS puro (SPA leve, sem framework) servido pelo Express |

```
server/
  index.js          app Express, sessão, static, guard de login
  db.js             schema + ledger append-only (hash encadeado) + verifyChain
  auth.js           bind LDAP no AD, /login /logout /me, requireAuth
  routes/
    documents.js    listar/criar/detalhe, upload, update status (audita tudo)
    audit.js        leitura do ledger, verify, export CSV
public/             index.html, app.js, styles.css, login.html
uploads/            arquivos anexados (fora do git)
data.db             banco SQLite (fora do git)
```

### Protocolo & rastreabilidade

O `audit_log` é a **fonte única e imutável** de movimentações:
- Cada linha encadeia o hash da anterior (`prev_hash` → `hash`). Alterar qualquer registro quebra a cadeia.
- Triggers `audit_no_update` / `audit_no_delete` abortam qualquer tentativa de edição/remoção.
- `GET /api/audit/verify` recalcula a cadeia inteira e retorna `{ ok, brokenAt }`.
- O histórico de um documento é uma consulta filtrada nesse mesmo ledger — não há fonte paralela que possa divergir.

## Rodar em desenvolvimento

```bash
npm install
cp .env.example .env     # ajuste as variáveis (LDAP, porta, segredo)
npm run dev              # http://localhost:3003  (node --watch)
```

Sem acesso ao AD na máquina de dev, o login falhará — teste as rotas de dados apontando `LDAP_URL` para o DC via VPN, ou faça o teste no ambiente da VM.

## Deploy na VM AKR (padrão dos demais portais)

Porta **3003**, hostname sugerido `portal-envio-documentos.akrbrands.com.br`.

```bash
# 1. código
sudo mkdir -p /opt/portal-envio-documentos && sudo chown king:king /opt/portal-envio-documentos
git clone https://github.com/viniciuskingjoe/Portal-Envio-Documentos.git /opt/portal-envio-documentos
cd /opt/portal-envio-documentos

# 2. deps + .env
npm install --omit=dev
cp .env.example .env && nano .env      # SESSION_SECRET fixo, COOKIE_SECURE=true, caminhos /opt/...

# 3. testar
node server/index.js                   # confirmar "rodando em ... :3003", Ctrl+C

# 4. systemd  (/etc/systemd/system/portal-envio-documentos.service)
#   [Service]
#   WorkingDirectory=/opt/portal-envio-documentos
#   ExecStart=/home/king/.nvm/versions/node/v24.18.0/bin/node server/index.js
#   EnvironmentFile=/opt/portal-envio-documentos/.env
#   User=king
#   Restart=always
#   (Node 24 do nvm — node:sqlite não existe no Node 20 do sistema)
sudo systemctl daemon-reload && sudo systemctl enable --now portal-envio-documentos

# 5. rota no Cloudflare Tunnel (painel → túnel portal-modelagem → Rotas):
#    portal-envio-documentos.akrbrands.com.br  →  HTTP  localhost:3003
```

> `COOKIE_SECURE=true` em produção (servido via HTTPS pelo túnel). `trust proxy` já está ligado no Express.

### Backup do SQLite

`data.db` usa WAL — copie os três arquivos juntos (`data.db`, `data.db-wal`, `data.db-shm`) e, para cópia consistente, **pare o serviço antes** (`sudo systemctl stop portal-envio-documentos`).

## Notas

- Usa `node:sqlite` (builtin, sem dependência nativa) — **exige Node 22.5+**. Na VM AKR, aponte o serviço para o **Node 24 do nvm** (mesmo padrão do portal-BI): `ExecStart=/home/king/.nvm/versions/node/v24.18.0/bin/node server/index.js`. Não use o Node 20 do sistema (não tem `node:sqlite`).
- Store de sessão em memória (single-instance). Reinício do serviço encerra as sessões ativas — aceitável para uso interno.
