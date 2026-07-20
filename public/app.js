let CURRENT_USER = { name: '—', sector: '', initials: '—', login: '' };

const statusMeta = {
  'Aguardando análise': { className: 'status-waiting', color: '#416b9b', icon: 'clock' },
  'Conferido': { className: 'status-done', color: '#227c5b', icon: 'check' },
  'Fazer Carta de Correção': { className: 'status-pending', color: '#b66a17', icon: 'alert' },
  'Lançamento incorreto': { className: 'status-error', color: '#b94a4a', icon: 'error' },
};

const icons = {
  document: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 9v5M12 18h.01"/></svg>',
  error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M14 7l5 5-5 5"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4"/></svg>',
  route: '<svg viewBox="0 0 24 24"><path d="M5 6h11M13 3l3 3-3 3M19 18H8M11 15l-3 3 3 3"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M8 8l4-4 4 4M5 20h14"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z"/></svg>',
  logout: '<svg viewBox="0 0 24 24"><path d="M14 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2M9 12h12M18 9l3 3-3 3"/></svg>',
};

let state = { documents: [], audit: [] };
let selectedDocumentId = null;
let statusDocumentId = null;
let selectedFile = null;
let resendDocumentId = null;
let resendFile = null;
let currentView = 'dashboard';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* ---------- API ---------- */
async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Sessão expirada.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro na requisição.');
  return data;
}

const roleLabel = { administrador: 'Administrador', fiscal: 'Fiscal', conferente: 'Conferente' };
const can = {
  create: () => ['conferente', 'administrador'].includes(CURRENT_USER.role),
  confer: () => ['fiscal', 'administrador'].includes(CURRENT_USER.role),
  admin: () => CURRENT_USER.role === 'administrador',
  manageCatalog: () => ['fiscal', 'administrador'].includes(CURRENT_USER.role),
  // Conferente só vê Documentos. Fiscal/admin veem dashboard, auditoria e admin.
  fullAccess: () => ['fiscal', 'administrador'].includes(CURRENT_USER.role),
};
const allowedViews = () => {
  if (can.fullAccess()) return ['dashboard', 'conferencia', 'documents', 'corrections', 'audit', 'admin'];
  return ['documents', 'corrections']; // conferente
};

async function loadUser() {
  const { user } = await api('/api/auth/me');
  CURRENT_USER = user;
  const avatar = $('.user-card .avatar');
  const meta = $('.user-card .user-meta');
  if (avatar) avatar.textContent = user.initials;
  const sub = [roleLabel[user.role] || '—', user.sector].filter(Boolean).join(' · ');
  if (meta) meta.innerHTML = `<strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(sub)}</span>`;
  // Botão de sair (garantido aqui, independente do resto do init).
  const userMenu = $('.user-card .icon-button');
  if (userMenu) { userMenu.setAttribute('aria-label', 'Sair'); userMenu.title = 'Sair'; userMenu.innerHTML = icons.logout; userMenu.onclick = logout; }
  applyRoleUI();
}

function applyRoleUI() {
  const full = can.fullAccess();
  // Nav por papel: conferente só vê Documentos.
  const setNav = (view, show) => { const el = document.querySelector(`.nav-item[data-view="${view}"]`); if (el) el.hidden = !show; };
  setNav('dashboard', full);
  setNav('conferencia', full);
  setNav('documents', true);
  setNav('corrections', can.create()); // conferente + admin
  setNav('audit', full);
  $$('.nav-admin').forEach(el => { el.hidden = !can.manageCatalog(); });
  $$('#new-document-button, #new-document-button-2').forEach(el => el.classList.toggle('role-hidden', !can.create()));
  // Aba/painel de Usuários: administrador e fiscal (fiscal só ajusta filial/setor).
  const usersTab = document.querySelector('.admin-tab[data-admin-tab="users"]');
  if (usersTab) usersTab.classList.toggle('role-hidden', !can.manageCatalog());
  // Landing por papel: fiscal cai na Conferência; conferente na de Documentos.
  if (!allowedViews().includes(currentView)) {
    switchView(CURRENT_USER.role === 'fiscal' ? 'conferencia' : 'documents');
  }
}

function selectAdminTab(target) {
  $$('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.adminTab === target));
  $$('.admin-pane').forEach(p => p.classList.toggle('hidden', p.id !== `admin-${target}`));
}

async function refresh() {
  const docs = await api('/api/documents');
  state.documents = docs.documents;
  // Auditoria só para quem tem acesso (fiscal/admin); conferente não busca.
  if (can.fullAccess()) {
    try { state.audit = (await api('/api/audit')).events; } catch { state.audit = []; }
  } else {
    state.audit = [];
  }
  renderAll();
}

let metaState = { branches: [], sectors: [] };
async function loadMeta() {
  const [b, s] = await Promise.all([api('/api/meta/branches'), api('/api/meta/sectors')]);
  metaState = { branches: b.items, sectors: s.items };
}
function fillSelect(select, items) {
  if (!select) return;
  select.innerHTML = '<option value="">Selecione</option>' +
    items.map(i => `<option value="${escapeHtml(i.name)}">${escapeHtml(i.name)}</option>`).join('');
}

/* ---------- Helpers ---------- */
function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
}

function formatDateTime(value, includeYear = false) {
  const date = new Date(value);
  const options = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' };
  if (includeYear) options.year = 'numeric';
  return new Intl.DateTimeFormat('pt-BR', options).format(date).replace(',', ' ·');
}

function formatDateLabel(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return 'Hoje';
  if (sameDay(date, yesterday)) return 'Ontem';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }).format(date);
}

function statusChip(status) {
  const meta = statusMeta[status] || statusMeta['Aguardando análise'];
  return `<span class="status-chip ${meta.className}">${escapeHtml(status)}</span>`;
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}

// Ledger completo (inclui login/logout). Ordenado desc pelo servidor.
function allAuditEvents() {
  return state.audit;
}

/* ---------- Render ---------- */
function renderMetrics() {
  const counts = Object.keys(statusMeta).reduce((acc, status) => ({ ...acc, [status]: state.documents.filter(doc => doc.status === status).length }), {});
  const today = new Date().toISOString().slice(0, 10);
  const reviewedToday = state.documents.filter(doc => doc.status === 'Conferido' && doc.updatedAt.slice(0, 10) === today).length;
  const metricData = [
    { label: 'Aguardando análise', value: counts['Aguardando análise'], detail: 'Na fila do setor Fiscal', color: '#416b9b', tint: '#eaf1fa', icon: icons.clock, trend: 'Fila' },
    { label: 'Conferidos', value: counts['Conferido'], detail: `${reviewedToday} finalizados hoje`, color: '#227c5b', tint: '#e5f5ed', icon: icons.check, trend: 'OK' },
    { label: 'Carta de Correção', value: counts['Fazer Carta de Correção'], detail: 'Aguardando carta de correção', color: '#b66a17', tint: '#fff2dc', icon: icons.alert, trend: 'Atenção' },
    { label: 'Lançamento incorreto', value: counts['Lançamento incorreto'], detail: 'Exigem ajuste no lançamento', color: '#b94a4a', tint: '#fde9e9', icon: icons.error, trend: 'Prioridade' },
  ];
  $('#metrics-grid').innerHTML = metricData.map(item => `
    <article class="metric-card" style="--metric-color:${item.color};--metric-tint:${item.tint}">
      <div class="metric-top"><span class="metric-icon">${item.icon}</span><span class="metric-trend">${item.trend}</span></div>
      <strong>${item.value}</strong><span>${item.label}</span><small>${item.detail}</small>
    </article>`).join('');
}

function renderRecent() {
  const docs = [...state.documents].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 5);
  $('#recent-list').innerHTML = docs.length ? docs.map(doc => `
    <article class="recent-item" data-open-document="${doc.id}" tabindex="0">
      <div class="document-icon">${icons.document}</div>
      <div class="recent-main"><strong>${escapeHtml(doc.supplier)}</strong><span>${escapeHtml(doc.protocol)} · NF ${escapeHtml(doc.invoice)}</span></div>
      <div class="recent-side">${statusChip(doc.status)}<time>${formatDateTime(doc.updatedAt)}</time></div>
    </article>`).join('') : '<div class="empty-inline">Nenhum documento cadastrado ainda.</div>';
}

function renderStatusChart() {
  const statuses = Object.keys(statusMeta);
  const total = state.documents.length || 1;
  const counts = statuses.map(status => state.documents.filter(doc => doc.status === status).length);
  const p1 = (counts[0] / total) * 100;
  const p2 = p1 + (counts[1] / total) * 100;
  const p3 = p2 + (counts[2] / total) * 100;
  const donut = $('#status-donut');
  donut.style.setProperty('--p1', `${p1}%`);
  donut.style.setProperty('--p2', `${p2}%`);
  donut.style.setProperty('--p3', `${p3}%`);
  $('#donut-total').textContent = state.documents.length;
  $('#status-legend').innerHTML = statuses.map((status, index) => `
    <div class="legend-item"><span class="legend-dot" style="--dot:${statusMeta[status].color}"></span><span>${status}</span><strong>${counts[index]}</strong></div>`).join('');
}

function renderAttention() {
  const docs = state.documents.filter(doc => ['Fazer Carta de Correção', 'Lançamento incorreto'].includes(doc.status)).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  $('#attention-list').innerHTML = docs.length ? docs.map(doc => {
    const meta = statusMeta[doc.status];
    return `<article class="attention-item" data-open-document="${doc.id}" style="--alert-color:${meta.color};--alert-bg:${doc.status === 'Fazer Carta de Correção' ? '#fff2dc' : '#fde9e9'}">
      <div class="attention-symbol">${doc.status === 'Fazer Carta de Correção' ? icons.alert : icons.error}</div>
      <div><strong>${escapeHtml(doc.protocol)} · ${escapeHtml(doc.supplier)}</strong><span>${escapeHtml(doc.lastNote || doc.notes)}</span></div>
      <button class="text-button">Tratar ${icons.arrow}</button>
    </article>`;
  }).join('') : '<div class="empty-inline">Nenhum documento requer atenção neste momento.</div>';
}

function renderBranchOptions() {
  const select = $('#branch-filter');
  const current = select.value;
  const branches = [...new Set(state.documents.map(doc => doc.branch))].sort();
  select.innerHTML = '<option value="">Todas as filiais</option>' + branches.map(branch => `<option>${escapeHtml(branch)}</option>`).join('');
  select.value = current;
}

function filteredDocuments() {
  const query = $('#document-search').value.trim().toLowerCase();
  const status = $('#status-filter').value;
  const branch = $('#branch-filter').value;
  return [...state.documents].filter(doc => {
    const haystack = [doc.protocol, doc.invoice, doc.branch, doc.origin, doc.supplier, doc.responsible].join(' ').toLowerCase();
    return (!query || haystack.includes(query)) && (!status || doc.status === status) && (!branch || doc.branch === branch);
  }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function renderDocumentsTable() {
  const docs = filteredDocuments();
  const tbody = $('#documents-table-body');
  tbody.innerHTML = docs.map(doc => `
    <tr>
      <td><div class="protocol-cell"><div class="document-icon">${icons.document}</div><div><strong>${escapeHtml(doc.protocol)}</strong><span>NF ${escapeHtml(doc.invoice)} · ${escapeHtml(doc.supplier)}</span></div></div></td>
      <td>${escapeHtml(doc.branch)}</td>
      <td><div class="flow-cell"><span>${escapeHtml(doc.origin)}</span>${icons.arrow}<span>${escapeHtml(doc.destination)}</span></div></td>
      <td><div class="responsible-cell"><div class="avatar mini">${escapeHtml(doc.initials || initials(doc.responsible))}</div><span>${escapeHtml(doc.responsible)}</span></div></td>
      <td>${statusChip(doc.status)}</td>
      <td><div class="update-cell"><strong>${formatDateTime(doc.updatedAt)}</strong><span>por ${escapeHtml(doc.lastUser || doc.responsible)}</span></div></td>
      <td><div class="row-actions"><button class="icon-button" data-open-document="${doc.id}" aria-label="Abrir documento">${icons.eye}</button></div></td>
    </tr>`).join('');
  $('#documents-empty').classList.toggle('hidden', docs.length > 0);
  $('#results-count').textContent = `${docs.length} ${docs.length === 1 ? 'documento' : 'documentos'}`;
  $('#nav-doc-count').textContent = state.documents.length;
  bindDynamicEvents();
}

function auditEventIcon(action) {
  if (action.includes('protocolado')) return icons.upload;
  if (action.includes('Conferido')) return icons.check;
  if (action.includes('Carta de Correção') || action.includes('Pendente')) return icons.alert;
  if (action.includes('incorreto')) return icons.error;
  if (action.includes('Login') || action.includes('Logout')) return icons.user;
  return icons.route;
}

function renderAudit() {
  const query = $('#audit-search')?.value.trim().toLowerCase() || '';
  // Só movimentações de documento (protocolo). Login/logout ficam no ledger
  // imutável por segurança, mas não aparecem aqui.
  const movements = allAuditEvents().filter(event => event.documentId);
  const events = movements.filter(event => !query || [event.protocol, event.invoice, event.user, event.action, event.note, event.sector, event.origin, event.destination].filter(Boolean).join(' ').toLowerCase().includes(query));
  const grouped = events.reduce((acc, event) => {
    const key = event.at.slice(0, 10);
    (acc[key] ||= []).push(event);
    return acc;
  }, {});
  $('#audit-timeline').innerHTML = events.length ? Object.entries(grouped).map(([date, dayEvents]) => `
    <section class="audit-day">
      <h3 class="audit-day-heading">${formatDateLabel(`${date}T12:00:00-03:00`)}</h3>
      ${dayEvents.map(event => `
        <article class="audit-event" ${event.documentId ? `data-open-document="${event.documentId}"` : ''}>
          <div class="audit-event-icon">${auditEventIcon(event.action)}</div>
          <div class="audit-event-content"><strong>${escapeHtml(event.action)}${event.protocol ? ` · ${escapeHtml(event.protocol)}` : ''}</strong><p>${escapeHtml(event.user)} (${escapeHtml(event.sector || '—')})${event.note ? ` — ${escapeHtml(event.note)}` : ''}</p>${event.destination ? `<span class="audit-route">${escapeHtml(event.origin || '—')} ${icons.arrow} ${escapeHtml(event.destination)}</span>` : ''}</div>
          <div class="audit-event-meta"><time>${new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(event.at))}</time>${event.invoice ? `<span>NF ${escapeHtml(event.invoice)}</span>` : ''}</div>
        </article>`).join('')}
    </section>`).join('') : '<div class="audit-empty">Nenhuma movimentação registrada.</div>';
  $('#audit-total').textContent = movements.length;
  $('#audit-users').textContent = new Set(movements.map(event => event.documentId)).size;
  const today = new Date().toISOString().slice(0, 10);
  $('#audit-today').textContent = movements.filter(event => event.at.slice(0, 10) === today).length;
  bindDynamicEvents();
}

function renderConferencia() {
  const list = $('#conferencia-list');
  if (!list) return;
  const queue = state.documents
    .filter(doc => doc.status === 'Aguardando análise')
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt)); // mais antigas primeiro (FIFO)
  list.innerHTML = queue.length ? queue.map(doc => {
    const reenviada = doc.resent;
    return `<article class="confer-item">
      <div class="confer-main" data-open-document="${doc.id}" tabindex="0">
        <div class="document-icon">${icons.document}</div>
        <div class="confer-info">
          <strong>${escapeHtml(doc.supplier)}${reenviada ? ' <span class="tag-reenviada">reenviada</span>' : ''}</strong>
          <span>${escapeHtml(doc.protocol)} · NF ${escapeHtml(doc.invoice)} · ${escapeHtml(doc.branch)} · ${escapeHtml(doc.origin)}</span>
        </div>
        <time>${formatDateTime(doc.updatedAt)}</time>
      </div>
      <div class="confer-actions">
        ${doc.hasFile ? `<a class="secondary-button compact" href="/api/documents/${doc.id}/file" target="_blank" rel="noopener">${icons.eye}Ver nota</a>` : ''}
        <button class="primary-button" data-update-document="${doc.id}">${icons.check}Conferir</button>
      </div>
    </article>`;
  }).join('') : '<div class="empty-inline">Nada para conferir no momento.</div>';
  const label = $('#confer-count-label'); if (label) label.textContent = `${queue.length} na fila`;
  const nav = $('#nav-confer-count'); if (nav) nav.textContent = queue.length;
  bindDynamicEvents();
}

function renderCorrections() {
  const list = $('#corrections-list');
  if (!list) return;
  const needsFix = ['Fazer Carta de Correção', 'Lançamento incorreto'];
  const queue = state.documents
    .filter(doc => needsFix.includes(doc.status))
    // Conferente só vê as do próprio setor; admin vê todas.
    .filter(doc => can.admin() || doc.origin === CURRENT_USER.sector)
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt)); // FIFO
  list.innerHTML = queue.length ? queue.map(doc => {
    const reason = doc.lastNote || 'Sem detalhes.';
    return `<article class="confer-item">
      <div class="confer-main" data-open-document="${doc.id}" tabindex="0">
        <div class="document-icon">${icons.document}</div>
        <div class="confer-info">
          <strong class="confer-title"><span class="confer-supplier">${escapeHtml(doc.supplier)}</span>${statusChip(doc.status)}</strong>
          <span>${escapeHtml(doc.protocol)} · NF ${escapeHtml(doc.invoice)} · ${escapeHtml(doc.branch)} · ${escapeHtml(doc.origin)}</span>
          <span class="confer-reason">Motivo: ${escapeHtml(reason)}</span>
        </div>
        <time>${formatDateTime(doc.updatedAt)}</time>
      </div>
      <div class="confer-actions">
        ${doc.hasFile ? `<a class="secondary-button compact" href="/api/documents/${doc.id}/file" target="_blank" rel="noopener">${icons.eye}Ver nota</a>` : ''}
        <button class="primary-button" data-resend-document="${doc.id}">${icons.upload}Corrigir e reenviar</button>
      </div>
    </article>`;
  }).join('') : '<div class="empty-inline">Nenhuma correção pendente.</div>';
  const label = $('#corrections-count-label'); if (label) label.textContent = `${queue.length} na fila`;
  const nav = $('#nav-corrections-count'); if (nav) nav.textContent = queue.length;
  bindDynamicEvents();
}

function openResendModal(id) {
  const doc = state.documents.find(item => item.id === id);
  if (!doc) return;
  resendDocumentId = id;
  resendFile = null;
  $('#resend-form').reset();
  $('#resend-selected-file').classList.add('hidden');
  $('#resend-selected-file').textContent = '';
  $('#resend-modal-protocol').textContent = `${doc.protocol} · NF ${doc.invoice}`;
  $('#resend-modal').showModal();
}

async function handleResendSubmit(event) {
  event.preventDefault();
  if (!resendFile) return showToast('Anexo obrigatório', 'Anexe a nota corrigida para reenviar.');
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  const form = new FormData(event.currentTarget);
  form.set('file', resendFile);
  try {
    const { document: doc } = await api(`/api/documents/${resendDocumentId}/resend`, { method: 'POST', body: form });
    await refresh();
    closeModal($('#resend-modal'));
    showToast('Reenviado', `${doc.protocol} voltou para a fila de conferência.`);
    openDocument(resendDocumentId);
  } catch (err) {
    showToast('Falha ao reenviar', err.message);
  } finally {
    submitButton.disabled = false;
  }
}

function renderAll() {
  renderMetrics();
  renderRecent();
  renderStatusChart();
  renderAttention();
  renderConferencia();
  renderCorrections();
  renderBranchOptions();
  renderDocumentsTable();
  renderAudit();
  $('#last-update').textContent = `Atualizado às ${new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`;
  bindDynamicEvents();
}

function bindDynamicEvents() {
  $$('[data-open-document]').forEach(element => {
    element.onclick = (event) => { event.stopPropagation(); openDocument(element.dataset.openDocument); };
    element.onkeydown = event => { if (event.key === 'Enter') openDocument(element.dataset.openDocument); };
  });
  $$('[data-update-document]').forEach(element => element.onclick = event => { event.stopPropagation(); openStatusModal(element.dataset.updateDocument); });
  $$('[data-resend-document]').forEach(element => element.onclick = event => { event.stopPropagation(); openResendModal(element.dataset.resendDocument); });
}

function switchView(view) {
  if (!allowedViews().includes(view)) return;
  currentView = view;
  $$('.view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  $('#sidebar').classList.remove('open');
  if (window.innerWidth <= 820) $('#overlay').classList.remove('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'admin') loadAdmin();
}

async function openDocument(id) {
  // A lista é enxuta; histórico e versões de anexo vêm do detalhe.
  let doc = state.documents.find(item => item.id === id);
  if (!doc) return;
  selectedDocumentId = id;
  $('#drawer-protocol').textContent = doc.protocol;
  try {
    const detail = await api(`/api/documents/${id}`);
    doc = detail.document;
  } catch (err) {
    showToast('Falha ao carregar o documento', err.message);
    return;
  }
  if (selectedDocumentId !== id) return; // usuário abriu outro nesse meio-tempo
  const fileCard = doc.hasFile
    ? `<a class="file-card" href="/api/documents/${doc.id}/file" target="_blank" rel="noopener"><div class="document-icon">${icons.document}</div><div><strong>${escapeHtml(doc.fileName || 'documento')}</strong><span>${escapeHtml(doc.fileSize || 'Arquivo anexado')}</span></div><span class="icon-button" aria-label="Visualizar arquivo">${icons.eye}</span></a>`
    : `<div class="file-card"><div class="document-icon">${icons.document}</div><div><strong>Sem anexo</strong><span>Nenhum arquivo foi anexado.</span></div></div>`;
  // Versões anteriores continuam acessíveis (a nota errada é prova do fluxo).
  const olderFiles = (doc.files || []).slice(1);
  const versionsBlock = olderFiles.length ? `
    <div class="file-versions">
      <h4>Versões anteriores</h4>
      ${olderFiles.map(f => `
        <a class="file-version" href="/api/documents/${doc.id}/file/${f.version}" target="_blank" rel="noopener">
          <span class="file-version-tag">v${f.version}</span>
          <span class="file-version-info"><strong>${escapeHtml(f.file_name)}</strong><span>${escapeHtml(f.file_size || '')} · ${escapeHtml(f.uploaded_by)} · ${formatDateTime(f.uploaded_at, true)}</span></span>
          <span class="icon-button" aria-label="Abrir versão">${icons.eye}</span>
        </a>`).join('')}
    </div>` : '';
  $('#drawer-body').innerHTML = `
    <div class="drawer-summary">
      <div class="summary-field summary-status"><span>Status atual</span><strong>${statusChip(doc.status)}</strong></div>
      <div class="summary-field"><span>Nota fiscal</span><strong>${escapeHtml(doc.invoice)}</strong></div>
      <div class="summary-field"><span>Filial</span><strong>${escapeHtml(doc.branch)}</strong></div>
      <div class="summary-field"><span>Fornecedor</span><strong>${escapeHtml(doc.supplier)}</strong></div>
      <div class="summary-field"><span>Fluxo</span><strong>${escapeHtml(doc.origin)} → ${escapeHtml(doc.destination)}</strong></div>
      <div class="summary-field"><span>Valor</span><strong>${escapeHtml(doc.amount || 'Não informado')}</strong></div>
    </div>
    <section class="drawer-section"><h3>Documento anexado</h3>${fileCard}${versionsBlock}</section>
    <section class="drawer-section"><h3>Observações iniciais</h3><div class="drawer-note">${escapeHtml(doc.notes || 'Nenhuma observação registrada.')}</div></section>
    <section class="drawer-section"><h3>Histórico de movimentações</h3><div class="timeline">${[...doc.history].reverse().map(event => `
      <article class="timeline-item"><div class="timeline-dot">${auditEventIcon(event.action)}</div><div class="timeline-content"><strong>${escapeHtml(event.action)}</strong><p>${escapeHtml(event.user)} · ${escapeHtml(event.sector || '—')}<br>${escapeHtml(event.note || '')}</p><time>${formatDateTime(event.at, true)} · ${escapeHtml(event.origin || '—')} → ${escapeHtml(event.destination || '—')}</time></div></article>`).join('')}</div></section>
    ${(['Fazer Carta de Correção', 'Lançamento incorreto'].includes(doc.status) && can.create()) ? `<div class="drawer-actions"><button class="primary-button" id="drawer-resend">${icons.upload}Corrigir e reenviar</button></div>` : ''}`;
  $('#document-drawer').classList.add('open');
  $('#document-drawer').setAttribute('aria-hidden', 'false');
  $('#overlay').classList.add('active');
  const drawerResend = $('#drawer-resend');
  if (drawerResend) drawerResend.onclick = () => openResendModal(id);
}

function closeDrawer() {
  $('#document-drawer').classList.remove('open');
  $('#document-drawer').setAttribute('aria-hidden', 'true');
  if (!$('#sidebar').classList.contains('open')) $('#overlay').classList.remove('active');
}

function openDocumentModal() {
  if (!can.create()) return showToast('Sem permissão', 'Seu perfil não cadastra documentos.');
  selectedFile = null;
  $('#document-form').reset();
  $('#selected-file').classList.add('hidden');
  $('#selected-file').textContent = '';
  // Filial e setor de origem vêm do usuário logado.
  $('#form-branch-display').value = CURRENT_USER.branch || '—';
  $('#form-origin-display').value = CURRENT_USER.sector || '—';
  const submitBtn = $('#document-form button[type="submit"]');
  if (!CURRENT_USER.branch || !CURRENT_USER.sector) {
    submitBtn.disabled = true;
    showToast('Cadastro incompleto', 'Seu usuário não tem filial/setor definidos. Peça ao administrador.');
  } else {
    submitBtn.disabled = false;
  }
  $('#document-modal').showModal();
}

function openStatusModal(id) {
  const doc = state.documents.find(item => item.id === id);
  if (!doc) return;
  statusDocumentId = id;
  $('#status-form').reset();
  $('#status-form').elements.status.value = doc.status;
  $('#status-modal-protocol').textContent = `${doc.protocol} · NF ${doc.invoice}`;
  $('#status-modal').showModal();
}

function closeModal(dialog) {
  if (dialog.open) dialog.close();
}

async function handleDocumentSubmit(event) {
  event.preventDefault();
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  const form = new FormData(event.currentTarget);
  if (selectedFile) form.set('file', selectedFile);
  else form.delete('file');
  try {
    const { document: doc, protocol } = await api('/api/documents', { method: 'POST', body: form });
    await refresh();
    closeModal($('#document-modal'));
    showToast('Protocolo gerado', `${protocol} foi encaminhado ao setor Fiscal.`);
    switchView('documents');
    openDocument(doc.id);
  } catch (err) {
    showToast('Falha ao enviar', err.message);
  } finally {
    submitButton.disabled = false;
  }
}

async function handleStatusSubmit(event) {
  event.preventDefault();
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  const form = new FormData(event.currentTarget);
  const id = statusDocumentId;
  try {
    const { document: doc } = await api(`/api/documents/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: form.get('status'), note: form.get('note').trim() }),
    });
    await refresh();
    closeModal($('#status-modal'));
    showToast('Movimentação registrada', `${doc.protocol} agora está como “${doc.status}”.`);
    openDocument(doc.id);
  } catch (err) {
    showToast('Falha ao registrar', err.message);
  } finally {
    submitButton.disabled = false;
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function handleFile(file) {
  if (!file) return;
  const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) return showToast('Arquivo não aceito', 'Envie um PDF, JPG, PNG ou WEBP.');
  if (file.size > 10 * 1024 * 1024) return showToast('Arquivo muito grande', 'O limite por documento é de 10 MB.');
  selectedFile = file;
  $('#selected-file').classList.remove('hidden');
  $('#selected-file').textContent = `${file.name} · ${formatFileSize(file.size)}`;
  if (file.type === 'application/pdf') autofillFromDanfe(file);
}

function handleResendFile(file) {
  if (!file) return;
  const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) return showToast('Arquivo não aceito', 'Envie um PDF, JPG, PNG ou WEBP.');
  if (file.size > 10 * 1024 * 1024) return showToast('Arquivo muito grande', 'O limite por documento é de 10 MB.');
  resendFile = file;
  $('#resend-selected-file').classList.remove('hidden');
  $('#resend-selected-file').textContent = `${file.name} · ${formatFileSize(file.size)}`;
}

// Lê o DANFE no servidor e preenche número/fornecedor/valor (só campos vazios,
// não sobrescreve o que o usuário já digitou). Filial/setor continuam manuais.
async function autofillFromDanfe(file) {
  const form = $('#document-form');
  const note = $('#selected-file');
  const base = note.textContent;
  note.textContent = `${base} · lendo DANFE…`;
  try {
    const body = new FormData();
    body.set('file', file);
    const res = await fetch('/api/documents/parse', { method: 'POST', body });
    if (!res.ok) throw new Error();
    const { fields, found } = await res.json();
    note.textContent = base;
    if (!found) return showToast('DANFE não reconhecido', 'Pode ser um scan/imagem. Preencha os campos manualmente.');
    const set = (name, value) => {
      const el = form.elements[name];
      if (el && value && !el.value.trim()) el.value = value;
    };
    set('invoice', fields.invoice);
    set('supplier', fields.supplier);
    set('amount', fields.amount);
    // Chave de acesso identifica a NF-e (usada para bloquear protocolo duplicado).
    if (fields.chave) $('#form-access-key').value = fields.chave;
    showToast('DANFE lido', 'Número, fornecedor e valor preenchidos. Confira e escolha a filial/setor.');
  } catch {
    note.textContent = base;
    showToast('Não deu para ler o DANFE', 'Preencha os campos manualmente.');
  }
}

function showToast(title, message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<div class="toast-icon">${icons.check}</div><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div><button class="icon-button" aria-label="Fechar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
  toast.querySelector('button').onclick = () => toast.remove();
  $('#toast-region').appendChild(toast);
  setTimeout(() => toast.remove(), 5200);
}

function exportAuditCsv() {
  window.location.href = '/api/audit/export';
  showToast('Exportação iniciada', 'O log de auditoria está sendo baixado em CSV.');
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  window.location.href = '/login';
}

/* ---------- Administração ---------- */
let adminState = { users: [], branches: [], sectors: [] };

async function loadAdmin() {
  if (!can.manageCatalog()) return;
  try {
    const [b, s] = await Promise.all([api('/api/admin/branches'), api('/api/admin/sectors')]);
    adminState.branches = b.items;
    adminState.sectors = s.items;
    // Admin e fiscal veem a lista (fiscal só ajusta filial/setor).
    const u = await api('/api/admin/users');
    adminState.users = u.users;
    renderAdminUsers();
    renderAdminCatalog('branches');
    renderAdminCatalog('sectors');
  } catch (err) {
    showToast('Falha ao carregar administração', err.message);
  }
}

function optionList(items, selectedId, emptyLabel) {
  return `<option value="">${emptyLabel}</option>` + items.map(i =>
    `<option value="${i.id}" ${String(i.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(i.name)}${i.active === 0 ? ' (inativa)' : ''}</option>`).join('');
}

function renderAdminUsers() {
  const roles = ['conferente', 'fiscal', 'administrador'];
  const canManageRole = can.admin(); // fiscal só ajusta filial/setor
  $('#admin-users-body').innerHTML = adminState.users.map(u => {
    const active = u.status === 'ativo';
    const isCurrentUser = u.login === CURRENT_USER.login;
    const roleLocked = !canManageRole || isCurrentUser;
    const statusLocked = !canManageRole || isCurrentUser;
    const statusText = u.status ? `${u.status[0].toUpperCase()}${u.status.slice(1)}` : 'Sem status';
    const actionLabel = active ? 'Desativar' : (u.status === 'inativo' ? 'Reativar' : 'Ativar');
    const branchOpts = `<option value="">—</option>` +
      adminState.branches.map(b => `<option value="${b.id}" ${u.branch_id === b.id ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('');
    const sectorOpts = `<option value="">—</option>` +
      adminState.sectors.map(s => `<option value="${s.id}" ${u.sector_id === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    return `
    <tr class="catalog-row user-row" data-login="${escapeHtml(u.login)}">
      <td>
        <div class="catalog-name user-name">
          <span class="catalog-mark user-mark" aria-hidden="true">${icons.user}</span>
          <div>
            <strong>${escapeHtml(u.name)}</strong>
            <span>${escapeHtml(u.login)}</span>
          </div>
        </div>
      </td>
      <td>
        <label class="role-select">
          <span class="sr-only">Papel de ${escapeHtml(u.name)}</span>
          <select data-user-role ${roleLocked ? `disabled title="${isCurrentUser ? 'Você não pode alterar o próprio papel.' : 'Apenas administrador altera papéis.'}"` : ''}>
            ${roles.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${roleLabel[r]}</option>`).join('')}
          </select>
        </label>
      </td>
      <td>
        <label class="role-select">
          <span class="sr-only">Filial de ${escapeHtml(u.name)}</span>
          <select data-user-branch>${branchOpts}</select>
        </label>
      </td>
      <td>
        <label class="role-select">
          <span class="sr-only">Setor de ${escapeHtml(u.name)}</span>
          <select data-user-sector>${sectorOpts}</select>
        </label>
      </td>
      <td><span class="badge ${u.status || 'pendente'}">${escapeHtml(statusText)}</span></td>
      <td class="catalog-actions">
        <button class="secondary-button compact catalog-toggle ${active ? 'danger-button' : ''}" data-toggle-user-status ${statusLocked ? `disabled title="${isCurrentUser ? 'Você não pode desativar a própria conta.' : 'Apenas administrador altera status.'}"` : ''}>
          ${active ? icons.error : icons.check}${actionLabel}
        </button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty-inline">Nenhum usuário cadastrado.</td></tr>';
}

async function updateUserRole(login, role) {
  const user = adminState.users.find(u => u.login === login);
  if (!user || user.role === role) return;
  try {
    await api(`/api/admin/users/${encodeURIComponent(login)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }),
    });
    showToast('Papel atualizado', `${user.name} agora é ${roleLabel[role] || role}.`);
    await loadAdmin();
  } catch (err) {
    showToast('Falha ao atualizar papel', err.message);
    await loadAdmin();
  }
}

async function updateUserField(login, field, rawValue) {
  const user = adminState.users.find(u => u.login === login);
  if (!user) return;
  const key = field === 'branchId' ? 'branch_id' : 'sector_id';
  const value = rawValue ? Number(rawValue) : null;
  if (user[key] === value) return;
  const labelName = field === 'branchId' ? 'Filial' : 'Setor';
  try {
    await api(`/api/admin/users/${encodeURIComponent(login)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: value }),
    });
    showToast(`${labelName} atualizada`, `${user.name} vinculado(a).`);
    await loadAdmin();
  } catch (err) {
    showToast(`Falha ao atualizar ${labelName.toLowerCase()}`, err.message);
    await loadAdmin();
  }
}

async function toggleUserStatus(login) {
  const user = adminState.users.find(u => u.login === login);
  if (!user) return;
  const nextStatus = user.status === 'ativo' ? 'inativo' : 'ativo';
  try {
    await api(`/api/admin/users/${encodeURIComponent(login)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: nextStatus }),
    });
    showToast('Usuário atualizado', `${user.name} ${nextStatus === 'ativo' ? 'reativado' : 'desativado'}.`);
    await loadAdmin();
  } catch (err) {
    showToast('Falha ao atualizar usuário', err.message);
  }
}

function renderAdminCatalog(kind) {
  const items = adminState[kind];
  const label = kind === 'branches' ? 'Filial' : 'Setor';
  $(`#admin-${kind}-body`).innerHTML = items.map(i => {
    const hint = kind === 'branches'
      ? (i.active ? 'Disponível para novos documentos' : 'Oculta em novos documentos')
      : (i.active ? 'Origem de documentos' : 'Oculto nos novos documentos');
    return `
    <tr class="catalog-row" data-id="${i.id}">
      <td>
        <div class="catalog-name">
          <span class="catalog-mark" aria-hidden="true">${icons.document}</span>
          <div>
            <strong>${escapeHtml(i.name)}</strong>
            <span>${label} ${i.active ? 'ativa' : 'inativa'} · ${hint}</span>
          </div>
        </div>
      </td>
      <td><span class="badge ${i.active ? 'ativo' : 'inativo'}">${i.active ? 'Ativa' : 'Inativa'}</span></td>
      <td class="catalog-actions">
        <button class="secondary-button compact catalog-toggle ${i.active ? 'danger-button' : ''}" data-toggle-cat="${kind}">
          ${i.active ? icons.error : icons.check}${i.active ? 'Desativar' : 'Reativar'}
        </button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="3" class="empty-inline">${kind === 'branches' ? 'Nenhuma filial cadastrada.' : 'Nenhum setor cadastrado.'}</td></tr>`;
}

async function addCatalog(kind) {
  const input = $(kind === 'branches' ? '#new-branch-name' : '#new-sector-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    await api(`/api/admin/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    input.value = '';
    showToast('Cadastrado', `${name} adicionado.`);
    await Promise.all([loadAdmin(), loadMeta()]);
  } catch (err) {
    showToast('Falha ao cadastrar', err.message);
  }
}

async function patchCatalog(kind, id, body) {
  try {
    await api(`/api/admin/${kind}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await Promise.all([loadAdmin(), loadMeta()]);
  } catch (err) {
    showToast('Falha ao atualizar', err.message);
  }
}

function initAdminEvents() {
  $$('.admin-tab').forEach(tab => tab.addEventListener('click', () => selectAdminTab(tab.dataset.adminTab)));
  $('#add-branch').addEventListener('click', () => addCatalog('branches'));
  $('#add-sector').addEventListener('click', () => addCatalog('sectors'));
  $('#view-admin').addEventListener('click', (event) => {
    const toggleUserBtn = event.target.closest('[data-toggle-user-status]');
    if (toggleUserBtn) { const row = toggleUserBtn.closest('tr'); return toggleUserStatus(row.dataset.login); }
    const toggleCat = event.target.closest('[data-toggle-cat]');
    if (toggleCat) { const row = toggleCat.closest('tr'); const kind = toggleCat.dataset.toggleCat; const item = adminState[kind].find(i => String(i.id) === row.dataset.id); return patchCatalog(kind, row.dataset.id, { active: item.active ? 0 : 1 }); }
  });
  $('#view-admin').addEventListener('change', (event) => {
    const roleSelect = event.target.closest('[data-user-role]');
    if (roleSelect) { const row = roleSelect.closest('tr'); return updateUserRole(row.dataset.login, roleSelect.value); }
    const branchSelect = event.target.closest('[data-user-branch]');
    if (branchSelect) { const row = branchSelect.closest('tr'); return updateUserField(row.dataset.login, 'branchId', branchSelect.value); }
    const sectorSelect = event.target.closest('[data-user-sector]');
    if (sectorSelect) { const row = sectorSelect.closest('tr'); return updateUserField(row.dataset.login, 'sectorId', sectorSelect.value); }
  });
}

function initEvents() {
  $$('.nav-item').forEach(item => item.addEventListener('click', () => switchView(item.dataset.view)));
  $$('[data-go-view]').forEach(item => item.addEventListener('click', () => switchView(item.dataset.goView)));
  $('#new-document-button-2').addEventListener('click', openDocumentModal);
  $$('.close-modal').forEach(button => button.addEventListener('click', () => closeModal($('#document-modal'))));
  $$('.close-status-modal').forEach(button => button.addEventListener('click', () => closeModal($('#status-modal'))));
  $$('.close-resend-modal').forEach(button => button.addEventListener('click', () => closeModal($('#resend-modal'))));
  $('.close-drawer').addEventListener('click', closeDrawer);
  $('#overlay').addEventListener('click', () => { closeDrawer(); $('#sidebar').classList.remove('open'); $('#overlay').classList.remove('active'); });
  $('#menu-button').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#overlay').classList.add('active'); });
  $('#document-form').addEventListener('submit', handleDocumentSubmit);
  $('#status-form').addEventListener('submit', handleStatusSubmit);
  $('#resend-form').addEventListener('submit', handleResendSubmit);
  $('#document-search').addEventListener('input', renderDocumentsTable);
  $('#status-filter').addEventListener('change', renderDocumentsTable);
  $('#branch-filter').addEventListener('change', renderDocumentsTable);
  $('#clear-filters').addEventListener('click', () => { $('#document-search').value = ''; $('#status-filter').value = ''; $('#branch-filter').value = ''; renderDocumentsTable(); });
  $('#audit-search').addEventListener('input', renderAudit);
  $('#export-audit').addEventListener('click', exportAuditCsv);
  $('#refresh-button').addEventListener('click', async () => { await refresh(); showToast('Dados atualizados', 'Os indicadores foram recalculados.'); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeDrawer();
  });

  const input = $('#file-input');
  $('#select-file-button').addEventListener('click', event => { event.preventDefault(); input.click(); });
  input.addEventListener('change', event => handleFile(event.target.files[0]));
  const upload = $('#upload-area');
  ['dragenter', 'dragover'].forEach(type => upload.addEventListener(type, event => { event.preventDefault(); upload.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(type => upload.addEventListener(type, event => { event.preventDefault(); upload.classList.remove('dragging'); }));
  upload.addEventListener('drop', event => handleFile(event.dataTransfer.files[0]));

  const resendInput = $('#resend-file-input');
  $('#resend-select-file').addEventListener('click', event => { event.preventDefault(); resendInput.click(); });
  resendInput.addEventListener('change', event => handleResendFile(event.target.files[0]));

  initAdminEvents();
}

async function boot() {
  // 1) Liga a interface JÁ (síncrono) — cliques funcionam mesmo se a rede demorar.
  try { initEvents(); } catch (err) { console.error('initEvents', err); }
  // 2) Papel primeiro (define o que carregar e quais telas mostrar).
  try { await loadUser(); } catch (err) { console.error('loadUser', err); }
  // 3) Dados dependem do papel (conferente não busca auditoria).
  refresh().catch(err => console.error('refresh', err));
  loadMeta().catch(err => console.error('loadMeta', err));
}

boot();
