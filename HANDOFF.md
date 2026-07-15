# Handoff — contexto de infra dos Portais AKR

> Doc pra continuar o trabalho numa nova sessão do Claude Code. Aberto nesta pasta,
> peça pra ler este arquivo. Resume a infra montada e o padrão de deploy usado nos
> outros portais (saldo, modelagem, BI, hub). Escrito em 2026-07-15.

## VM central (tudo roda aqui)
- **Host:** `srvappweb` — **192.168.2.150** — Ubuntu 22.04, usuário SSH **`king`**
- **Node do sistema:** v20.20.2 (`/usr/bin/node`) — usado por saldo e modelagem
- **Node 24** (via nvm, só pro BI): `/home/king/.nvm/versions/node/v24.18.0/bin/node`
- **Apache2** na porta 80/443 (serve o PHP público AKR em `/var/www/app` + o hub)
- Disco apertado (~8-9GB livres em jul/2026) — de olho ao instalar mais coisa.

## Apps já rodando (systemd + portas)
| App | Pasta | Porta | Node | Serviço systemd | Stack |
|-----|-------|-------|------|-----------------|-------|
| portal-modelagem | /opt/portal-modelagem | 3000 | 20 | (existente) | Vite/React |
| portal-saldo | /opt/portal-saldo | 3001 | 20 | `portal-saldo` | TanStack Start (SSR) |
| portal-bi | /opt/portal-bi | 3002 | 24 | `portal-bi` | Express + SQLite + AD |
| portal-envio-documentos | /opt/portal-envio-documentos | 3003 | 24 | `portal-envio-documentos` | Express + node:sqlite + AD + multer |
| hub (estático) | /var/www/hub | (Apache:80) | — | (Apache vhost `portais.conf`) | HTML estático |

**Próxima porta livre pra um novo app node: `3004`.**

## Cloudflare Tunnel (é assim que os portais ficam públicos)
- Tudo passa por **Cloudflare Tunnel** (`cloudflared` na 2.150, tunnel **`portal-modelagem`**, token-based).
- Rotas ficam no **painel** (Zero Trust → Networks → Tunnels → `portal-modelagem` → **Rotas de aplicativos publicados**), NÃO em arquivo local.
- Hostnames públicos já configurados (todos → `localhost:PORTA`):
  - `portal-modelagem.akrbrands.com.br` → 3000
  - `portal-saldo-estoque.akrbrands.com.br` → 3001
  - `portal-bi.akrbrands.com.br` → 3002
  - `portais.akrbrands.com.br` → 80 (hub; Apache roteia por ServerName)
- **Regra catch-all:** 404 (fallback cai no PHP público AKR).

### Expor um portal novo = adicionar rota no túnel
Painel → túnel `portal-modelagem` → Rotas de aplicativos publicados → **Adicionar**:
- Subdomain: `<nome>` · Domain: `akrbrands.com.br` · Path: **vazio**
- Type **HTTP** · URL **`localhost:<porta>`** → Save
- O DNS (CNAME tipo "Túnel") é criado automático. **Sem Apache/cert** pra apps node.

## Serviços de dados
- **SQL Server:** `192.168.1.3` / banco **KINGEJOE** (portal-saldo e modelagem usam; vars `AZURE_SQL_*` no `.env`).
- **Active Directory (LDAP):** `ldap://192.168.1.4:389`, base `DC=king,DC=local` (BI usa pra login).
- **DNS interno da empresa:** o DC **192.168.1.4** — importante pra pegadinha abaixo.

## Pegadinhas que já custaram tempo (não repetir)
1. **DNS "não abre" logo após criar hostname no túnel** → é **cache negativo (NXDOMAIN) no DC 192.168.1.4**. O registro na Cloudflare já está certo (confirma com `nslookup <host> 1.1.1.1`). Resolve: no DC, `Clear-DnsServerCache -Force` (ou DNS Manager → Clear Cache), ou esperar ~15-60 min. Testar no 4G do celular fura o cache.
2. **Portal-Saldo build:** o Nitro tem preset default **Cloudflare** (não roda `mssql`). Buildar SEMPRE com `npm run build:node` (força `NITRO_PRESET=node-server`), nunca `npm run build`.
3. **Portal-BI exige Node 24** (usa `node:sqlite` builtin). Node 20 dá `ERR_UNKNOWN_BUILTIN_MODULE`. Por isso o serviço aponta pro node do nvm. NÃO troca o node do sistema (quebra saldo/modelagem).
4. **Conflito de porta:** cada app precisa de porta única. 3000/3001/3002/80 ocupados.
5. **SQLite (BI):** copiar `.db` + `-wal` + `-shm` juntos; pra cópia consistente, parar o serviço antes.

## Padrão de deploy de um app node novo (ex: este portal)
```bash
# 1. clonar (se em git) em /opt/<nome>
sudo mkdir -p /opt/<nome> && sudo chown king:king /opt/<nome>
git clone <repo> /opt/<nome> && cd /opt/<nome>
# 2. .env (credenciais conforme o app: SQL / AD / etc)
# 3. instalar + buildar
npm install     # e o build que o projeto exigir
# 4. testar
PORT=3003 node <entry>     # confirmar que sobe
# 5. systemd (/etc/systemd/system/<nome>.service): ExecStart=node <entry>,
#    WorkingDirectory=/opt/<nome>, Environment=PORT=3003, User=king, Restart=always
sudo systemctl daemon-reload && sudo systemctl enable --now <nome>
# 6. rota no túnel: <nome>.akrbrands.com.br → localhost:3003
```
App **estático** (só HTML/CSS/JS, sem backend): serve por Apache num `/var/www/<nome>` + vhost `ServerName <nome>.akrbrands.com.br` + rota no túnel → `localhost:80` (igual ao hub).

## Este projeto — Portal-Envio-Documentos (NO AR desde 2026-07-15)
- **Deployado** em `/opt/portal-envio-documentos`, serviço systemd `portal-envio-documentos`, porta **3003**, Node 24 (nvm).
- Stack: Express (ESM) + `node:sqlite` builtin (exige Node 24, não Node 20) + `express-session` + `ldapjs` (AD) + `multer` (uploads em `/opt/portal-envio-documentos/uploads`).
- Banco: `/opt/portal-envio-documentos/data.db` (WAL). Auditoria = ledger append-only com hash encadeado + triggers anti-UPDATE/DELETE.
- Login por AD (`192.168.1.4`). Repo: github.com/viniciuskingjoe/Portal-Envio-Documentos.
- Deploy reproduzível: `deploy/setup.sh` + `deploy/portal-envio-documentos.service` no repo.
- **Pendências:** (1) rota no Cloudflare Tunnel → `portal-envio-documentos.akrbrands.com.br` → localhost:3003; (2) 4º card no hub (feito no fonte `Portal-Hub`, falta copiar pra `/var/www/hub/`); (3) upgrade multer 1.x → 2.x (CVE).
- Pegadinha nova: `node:sqlite` rejeita chaves de params fora do SQL (better-sqlite3 tolerava). Trocado better-sqlite3→node:sqlite pra evitar compilar módulo nativo (sem build tools no Windows dev + prebuild ausente no Node 24).

## Hub
- Fonte do hub: `C:\Users\vinicius\Portal-Hub\index.html` (estático, marca AKR, 3 cards).
- Na VM: `/var/www/hub/index.html`, vhost `portais.conf`. Adicionar um 4º card (este portal) quando ele subir.
