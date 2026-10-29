/* Buffalo — UI. Vanilla JS. All calculations live in logic.js. */
(function () {
  'use strict';
  const L = window.Logic;
  const CUR = '$';

  /* ---------- helpers ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const money = (n) => (n < 0 ? '-' : '') + CUR + fmt(Math.abs(n));
  const qty = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const niceDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const q = (sel, root) => (root || document).querySelector(sel);
  const byId = (arr, id) => arr.find((x) => x.id === id);
  const STATUS_TEXT = { ok: 'OK', low: 'Low', out: 'Out of stock' };
  const badge = (s) => '<span class="st st-' + s + '">' + STATUS_TEXT[s] + '</span>';
  const signClass = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

  /* ---------- state (lives on the server) ---------- */
  let state = L.emptyData();
  let user = null;
  let view = 'dashboard';
  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Please sign in.'); }
    if (!r.ok) throw new Error(j.error || 'Request failed.');
    return j;
  }
  async function refresh() { const j = await api('GET', '/api/state'); state = j.state; user = j.user; }
  async function act(fn, okMsg) {
    try { await fn(); await refresh(); render(); if (okMsg) toast(okMsg); }
    catch (err) { toast(err.message, true); }
  }
  let rep = { mode: 'day', date: today(), month: today().slice(0, 7) };

  let toastTimer;
  function toast(msg, isErr) {
    const t = q('#toast');
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, 3200);
  }
  const matName = (id) => (byId(state.materials, id) || { name: '(deleted)' }).name;
  const matUnit = (id) => (byId(state.materials, id) || { unit: '' }).unit;
  const prodName = (id) => (byId(state.products, id) || { name: '(deleted)' }).name;
  const prodUnit = (id) => (byId(state.products, id) || { unit: '' }).unit;
  const matOptions = (sel) => state.materials.map((m) => '<option value="' + m.id + '"' + (m.id === sel ? ' selected' : '') + '>' + esc(m.name) + ' (' + esc(m.unit) + ')</option>').join('');
  const prodOptions = (sel) => state.products.map((p) => '<option value="' + p.id + '"' + (p.id === sel ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
  const emptyRow = (cols, text) => '<tr><td colspan="' + cols + '" class="empty">' + text + '</td></tr>';
  const delBtn = (col, id) => (!user || user.role !== 'admin') ? '' : '<button class="btn btn-sm btn-outline-danger no-print" data-del="' + col + '" data-id="' + id + '">Delete</button>';
  const recent = (arr) => arr.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 40);

  /* ---------- views ---------- */
  const views = {};

  /* Dashboard */
  views.dashboard = {
    title: 'Dashboard',
    render() {
      const t = today(), ym = t.slice(0, 7);
      const d = L.dayReport(state, t), m = L.monthReport(state, ym);
      const al = L.alerts(state);
      const alRows = al.map((a) => '<tr><td>' + esc(a.name) + '</td><td>' + (a.kind === 'material' ? 'Raw material' : 'Finished product') + '</td>' +
        '<td class="num">' + qty(a.stock) + ' ' + esc(a.unit) + '</td><td class="num">' + qty(a.level) + '</td><td>' + badge(a.status) + '</td>' +
        '<td class="num">' + (a.kind === 'material' ? 'Buy ~' : 'Make ~') + qty(a.suggest) + '</td></tr>').join('');
      const canMake = state.products.map((p) => {
        const r = L.producible(state, p);
        return '<tr><td>' + esc(p.name) + '</td><td class="num">' + qty(r.max) + ' ' + esc(p.unit) + '</td><td>' + (r.limiting ? esc(matName(r.limiting)) : '—') + '</td></tr>';
      }).join('');
      return '' +
        '<div class="grid g4" style="margin-bottom:1.1rem">' +
          kpi('Sales today', money(d.revenue), d.counts.sales + ' order(s)') +
          kpi('Sales this month', money(m.revenue), m.counts.sales + ' order(s)') +
          kpi('Gross profit (month)', money(m.grossProfit), 'Revenue − material cost') +
          kpi('Net profit (month)', '<span class="' + signClass(m.netProfit) + '">' + money(m.netProfit) + '</span>', 'After ' + money(m.expenses) + ' expenses') +
        '</div>' +
        '<div class="box"><h2>Stock alerts <small>' + (al.length ? al.length + ' item(s) need attention' : '') + '</small></h2>' +
          (al.length
            ? '<div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>Type</th><th class="num">In stock</th><th class="num">Alert level</th><th>Status</th><th class="num">Suggested</th></tr></thead><tbody>' + alRows + '</tbody></table></div>'
            : '<div class="empty">All stock levels are healthy. Nothing is short.</div>') +
        '</div>' +
        '<div class="grid g2">' +
          '<div class="box"><h2>Can we produce? <small>with current raw material</small></h2><div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th class="num">Max now</th><th>Limited by</th></tr></thead><tbody>' + (canMake || emptyRow(3, 'No products yet.')) + '</tbody></table></div></div>' +
          '<div class="box"><h2>Quick actions</h2><div class="d-grid gap-2">' +
            '<button class="btn btn-primary" data-go="production">+ Record production</button>' +
            '<button class="btn btn-outline-primary" data-go="sales">+ Record a sale</button>' +
            '<button class="btn btn-outline-primary" data-go="purchases">+ Record a purchase</button>' +
            '<button class="btn btn-outline-secondary" data-go="reports">View today\'s report</button>' +
          '</div></div>' +
        '</div>';
    }
  };
  function kpi(label, val, sub) {
    return '<div class="kpi"><div class="lbl">' + label + '</div><div class="val">' + val + '</div><div class="sub">' + sub + '</div></div>';
  }

  /* Stock */
  views.stock = {
    title: 'Stock',
    render() {
      const mRows = state.materials.map((m) => {
        const st = L.materialStock(state, m.id);
        return '<tr><td>' + esc(m.name) + '</td><td class="num">' + qty(st) + ' ' + esc(m.unit) + '</td><td class="num">' + qty(m.reorder) + '</td>' +
          '<td class="num">' + money(L.avgMaterialCost(state, m.id)) + '</td><td>' + badge(L.materialStatus(state, m)) + '</td></tr>';
      }).join('');
      const pRows = state.products.map((p) => {
        const st = L.productStock(state, p.id);
        return '<tr><td>' + esc(p.name) + '</td><td class="num">' + qty(st) + ' ' + esc(p.unit) + '</td><td class="num">' + qty(p.minStock) + '</td>' +
          '<td class="num">' + money(L.productUnitCost(state, p)) + '</td><td class="num">' + money(p.price) + '</td><td>' + badge(L.productStatus(state, p)) + '</td></tr>';
      }).join('');
      return '' +
        '<div class="box"><h2>Raw materials <small>purchased − used in production</small></h2><div class="table-wrap"><table class="table"><thead><tr><th>Material</th><th class="num">In stock</th><th class="num">Reorder level</th><th class="num">Avg cost</th><th>Status</th></tr></thead><tbody>' + (mRows || emptyRow(5, 'No materials yet.')) + '</tbody></table></div></div>' +
        '<div class="box"><h2>Finished products <small>produced − sold</small></h2><div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th class="num">In stock</th><th class="num">Min level</th><th class="num">Unit cost</th><th class="num">Price</th><th>Status</th></tr></thead><tbody>' + (pRows || emptyRow(6, 'No products yet.')) + '</tbody></table></div></div>';
    }
  };

  /* Purchases */
  views.purchases = {
    title: 'Purchases (raw material in)',
    render() {
      const rows = recent(state.purchases).map((p) =>
        '<tr><td>' + niceDate(p.date) + '</td><td>' + esc(matName(p.materialId)) + '</td><td class="num">' + qty(p.qty) + ' ' + esc(matUnit(p.materialId)) + '</td>' +
        '<td class="num">' + money(p.unitCost) + '</td><td class="num">' + money(p.qty * p.unitCost) + '</td><td>' + esc(p.supplier) + '</td><td>' + delBtn('purchases', p.id) + '</td></tr>').join('');
      return '<div class="split">' +
        '<form class="box" id="f">' +
          '<h2>New purchase</h2>' +
          '<div class="fld"><label>Date</label><input type="date" class="form-control" id="fDate" value="' + today() + '" required></div>' +
          '<div class="fld"><label>Material</label><select class="form-select" id="fMat" required>' + matOptions() + '</select></div>' +
          '<div class="fld"><label>Quantity</label><input type="number" step="any" min="0" class="form-control" id="fQty" required></div>' +
          '<div class="fld"><label>Unit cost (' + CUR + ')</label><input type="number" step="any" min="0" class="form-control" id="fCost" required></div>' +
          '<div class="fld"><label>Supplier (optional)</label><input class="form-control" id="fSup"></div>' +
          '<button class="btn btn-primary w-100">Save purchase</button>' +
        '</form>' +
        '<div class="box"><h2>Recent purchases</h2><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Material</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Total</th><th>Supplier</th><th></th></tr></thead><tbody>' + (rows || emptyRow(7, 'No purchases yet.')) + '</tbody></table></div></div>' +
      '</div>';
    },
    bind() {
      const fillCost = () => { const c = L.avgMaterialCost(state, q('#fMat').value); if (c) q('#fCost').value = L.r2(c); };
      q('#fMat').addEventListener('change', fillCost); fillCost();
      q('#f').addEventListener('submit', (e) => {
        e.preventDefault();
        act(() => api('POST', '/api/purchases', { date: q('#fDate').value, materialId: q('#fMat').value, qty: parseFloat(q('#fQty').value), unitCost: parseFloat(q('#fCost').value), supplier: q('#fSup').value.trim() }), 'Purchase saved. Stock updated.');
      });
    }
  };

  /* Production */
  views.production = {
    title: 'Production (manufacturing entry)',
    render() {
      const rows = recent(state.productions).map((p) =>
        '<tr><td>' + niceDate(p.date) + '</td><td>' + esc(prodName(p.productId)) + '</td><td class="num">' + qty(p.qty) + ' ' + esc(prodUnit(p.productId)) + '</td>' +
        '<td class="num">' + money(p.cost) + '</td><td class="num">' + money(p.qty ? p.cost / p.qty : 0) + '</td><td>' + delBtn('productions', p.id) + '</td></tr>').join('');
      return '<div class="split">' +
        '<form class="box" id="f">' +
          '<h2>New production run</h2>' +
          '<div class="fld"><label>Date</label><input type="date" class="form-control" id="fDate" value="' + today() + '" required></div>' +
          '<div class="fld"><label>Product</label><select class="form-select" id="fProd" required>' + prodOptions() + '</select></div>' +
          '<div class="fld"><label>Quantity to produce</label><input type="number" step="any" min="0" class="form-control" id="fQty" required></div>' +
          '<div class="live" id="live"></div>' +
          '<button class="btn btn-primary w-100" id="fBtn">Record production</button>' +
        '</form>' +
        '<div class="box"><h2>Production history</h2><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Product</th><th class="num">Qty</th><th class="num">Material cost</th><th class="num">Cost / unit</th><th></th></tr></thead><tbody>' + (rows || emptyRow(6, 'No production recorded yet.')) + '</tbody></table></div></div>' +
      '</div>';
    },
    bind() {
      const live = () => {
        const pid = q('#fProd').value, n = parseFloat(q('#fQty').value);
        const p = byId(state.products, pid), box = q('#live'), btn = q('#fBtn');
        if (!p) { box.innerHTML = 'Add a product in Setup first.'; btn.disabled = true; return; }
        const mx = L.producible(state, p);
        let html = 'You can make up to <b>' + qty(mx.max) + ' ' + esc(p.unit) + '</b> now' + (mx.limiting ? ' (limited by ' + esc(matName(mx.limiting)) + ')' : '') + '.';
        if (n > 0) {
          const chk = L.checkProduction(state, pid, n);
          if (chk.lines.length) {
            html += '<table class="table table-sm mt-2"><thead><tr><th>Material</th><th class="num">Needed</th><th class="num">In stock</th><th></th></tr></thead><tbody>' +
              chk.lines.map((l) => '<tr><td>' + esc(matName(l.materialId)) + '</td><td class="num">' + qty(l.need) + '</td><td class="num">' + qty(l.have) + '</td>' +
                '<td>' + (l.missing > 0 ? '<span class="bad">short ' + qty(l.missing) + '</span>' : '<span class="good">✓</span>') + '</td></tr>').join('') + '</tbody></table>';
          }
          btn.disabled = !chk.ok;
          if (!chk.ok && chk.error) html += '<div class="bad mt-1">' + esc(chk.error) + '</div>';
        } else { btn.disabled = true; }
        box.innerHTML = html;
      };
      q('#fProd').addEventListener('change', live);
      q('#fQty').addEventListener('input', live);
      live();
      q('#f').addEventListener('submit', (e) => {
        e.preventDefault();
        act(() => api('POST', '/api/productions', { date: q('#fDate').value, productId: q('#fProd').value, qty: parseFloat(q('#fQty').value) }), 'Production recorded. Materials deducted, products added to stock.');
      });
    }
  };

  /* Sales */
  views.sales = {
    title: 'Sales',
    render() {
      const rows = recent(state.sales).map((s) =>
        '<tr><td>' + niceDate(s.date) + '</td><td>' + esc(prodName(s.productId)) + '</td><td class="num">' + qty(s.qty) + '</td><td class="num">' + money(s.unitPrice) + '</td>' +
        '<td class="num">' + money(s.qty * s.unitPrice) + '</td><td class="num ' + signClass(s.qty * (s.unitPrice - s.unitCost)) + '">' + money(s.qty * (s.unitPrice - s.unitCost)) + '</td><td>' + esc(s.customer) + '</td><td>' + delBtn('sales', s.id) + '</td></tr>').join('');
      return '<div class="split">' +
        '<form class="box" id="f">' +
          '<h2>New sale</h2>' +
          '<div class="fld"><label>Date</label><input type="date" class="form-control" id="fDate" value="' + today() + '" required></div>' +
          '<div class="fld"><label>Product</label><select class="form-select" id="fProd" required>' + prodOptions() + '</select></div>' +
          '<div class="fld"><label>Quantity</label><input type="number" step="any" min="0" class="form-control" id="fQty" required></div>' +
          '<div class="fld"><label>Unit price (' + CUR + ')</label><input type="number" step="any" min="0" class="form-control" id="fPrice" required></div>' +
          '<div class="fld"><label>Customer (optional)</label><input class="form-control" id="fCust"></div>' +
          '<div class="live" id="live"></div>' +
          '<button class="btn btn-primary w-100" id="fBtn">Record sale</button>' +
        '</form>' +
        '<div class="box"><h2>Recent sales</h2><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Product</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th><th class="num">Profit</th><th>Customer</th><th></th></tr></thead><tbody>' + (rows || emptyRow(8, 'No sales yet.')) + '</tbody></table></div></div>' +
      '</div>';
    },
    bind() {
      const setPrice = () => { const p = byId(state.products, q('#fProd').value); if (p) q('#fPrice').value = p.price; };
      const live = () => {
        const pid = q('#fProd').value, n = parseFloat(q('#fQty').value), price = parseFloat(q('#fPrice').value) || 0;
        const p = byId(state.products, pid), box = q('#live'), btn = q('#fBtn');
        if (!p) { box.innerHTML = 'Add a product in Setup first.'; btn.disabled = true; return; }
        const chk = L.checkSale(state, pid, n);
        let html = 'In stock: <b>' + qty(chk.have) + ' ' + esc(p.unit) + '</b>';
        if (n > 0 && chk.ok) {
          const cost = L.productUnitCost(state, p) * n;
          html += '<br>Total: <b>' + money(n * price) + '</b> · Est. profit: <b class="' + signClass(n * price - cost) + '">' + money(n * price - cost) + '</b>';
        } else if (n > 0) { html += '<div class="bad mt-1">' + esc(chk.error) + '</div>'; }
        btn.disabled = !chk.ok;
        box.innerHTML = html;
      };
      q('#fProd').addEventListener('change', () => { setPrice(); live(); });
      q('#fQty').addEventListener('input', live);
      q('#fPrice').addEventListener('input', live);
      setPrice(); live();
      q('#f').addEventListener('submit', (e) => {
        e.preventDefault();
        act(() => api('POST', '/api/sales', { date: q('#fDate').value, productId: q('#fProd').value, qty: parseFloat(q('#fQty').value), unitPrice: parseFloat(q('#fPrice').value), customer: q('#fCust').value.trim() }), 'Sale recorded. Stock updated.');
      });
    }
  };

  /* Expenses */
  views.expenses = {
    title: 'Expenses',
    render() {
      const ym = today().slice(0, 7), m = L.monthReport(state, ym);
      const cats = Object.keys(m.expenseByCategory).map((c) => '<tr><td>' + esc(c) + '</td><td class="num">' + money(m.expenseByCategory[c]) + '</td></tr>').join('');
      const rows = recent(state.expenses).map((x) =>
        '<tr><td>' + niceDate(x.date) + '</td><td>' + esc(x.category) + '</td><td class="num">' + money(x.amount) + '</td><td>' + esc(x.note) + '</td><td>' + delBtn('expenses', x.id) + '</td></tr>').join('');
      return '<div class="split">' +
        '<div><form class="box" id="f">' +
          '<h2>New expense</h2>' +
          '<div class="fld"><label>Date</label><input type="date" class="form-control" id="fDate" value="' + today() + '" required></div>' +
          '<div class="fld"><label>Category</label><select class="form-select" id="fCat">' + L.EXPENSE_CATEGORIES.map((c) => '<option>' + esc(c) + '</option>').join('') + '</select></div>' +
          '<div class="fld"><label>Amount (' + CUR + ')</label><input type="number" step="any" min="0" class="form-control" id="fAmt" required></div>' +
          '<div class="fld"><label>Note (optional)</label><input class="form-control" id="fNote"></div>' +
          '<button class="btn btn-primary w-100">Save expense</button>' +
        '</form>' +
        '<div class="box"><h2>This month <small>by category</small></h2><table class="table"><tbody>' + (cats || emptyRow(2, 'No expenses this month.')) +
          '<tr><td><b>Total</b></td><td class="num"><b>' + money(m.expenses) + '</b></td></tr></tbody></table></div></div>' +
        '<div class="box"><h2>Recent expenses</h2><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Category</th><th class="num">Amount</th><th>Note</th><th></th></tr></thead><tbody>' + (rows || emptyRow(5, 'No expenses yet.')) + '</tbody></table></div></div>' +
      '</div>';
    },
    bind() {
      q('#f').addEventListener('submit', (e) => {
        e.preventDefault();
        act(() => api('POST', '/api/expenses', { date: q('#fDate').value, category: q('#fCat').value, amount: parseFloat(q('#fAmt').value), note: q('#fNote').value.trim() }), 'Expense saved.');
      });
    }
  };

  /* Reports (daily / monthly) */
  views.reports = {
    title: 'Reports',
    render() {
      const isDay = rep.mode === 'day';
      const r = isDay ? L.dayReport(state, rep.date) : L.monthReport(state, rep.month);
      const label = isDay ? 'Daily report — ' + niceDate(rep.date) : 'Monthly report — ' + new Date(rep.month + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const exp = Object.keys(r.expenseByCategory).map((c) => '<tr class="sub"><td>' + esc(c) + '</td><td class="num">' + money(r.expenseByCategory[c]) + '</td></tr>').join('');
      const prodRows = Object.keys(r.producedBy).map((id) => '<tr><td>' + esc(prodName(id)) + '</td><td class="num">' + qty(r.producedBy[id].qty) + ' ' + esc(prodUnit(id)) + '</td><td class="num">' + money(r.producedBy[id].cost) + '</td></tr>').join('');
      const soldRows = Object.keys(r.soldBy).map((id) => { const o = r.soldBy[id]; return '<tr><td>' + esc(prodName(id)) + '</td><td class="num">' + qty(o.qty) + '</td><td class="num">' + money(o.revenue) + '</td><td class="num">' + money(o.revenue - o.cost) + '</td></tr>'; }).join('');
      const mRows = state.materials.map((m) => '<tr><td>' + esc(m.name) + '</td><td class="num">' + qty(L.materialStock(state, m.id)) + ' ' + esc(m.unit) + '</td><td>' + badge(L.materialStatus(state, m)) + '</td></tr>').join('');
      const pRows = state.products.map((p) => '<tr><td>' + esc(p.name) + '</td><td class="num">' + qty(L.productStock(state, p.id)) + ' ' + esc(p.unit) + '</td><td>' + badge(L.productStatus(state, p)) + '</td></tr>').join('');
      const al = L.alerts(state);
      return '' +
        '<div class="d-flex flex-wrap gap-2 align-items-center mb-3 no-print">' +
          '<div class="seg"><button data-mode="day" class="' + (isDay ? 'active' : '') + '">Daily</button><button data-mode="month" class="' + (!isDay ? 'active' : '') + '">Monthly</button></div>' +
          (isDay ? '<input type="date" class="form-control w-auto" id="rDate" value="' + rep.date + '">' : '<input type="month" class="form-control w-auto" id="rMonth" value="' + rep.month + '">') +
          '<button class="btn btn-outline-secondary ms-auto" id="printBtn">Print / Save as PDF</button>' +
        '</div>' +
        '<h2 style="font-size:1.15rem;font-weight:600" class="mb-3">' + label + '</h2>' +
        '<div class="grid g4" style="margin-bottom:1.1rem">' +
          kpi('Revenue', money(r.revenue), r.counts.sales + ' sale(s)') +
          kpi('Gross profit', money(r.grossProfit), 'After material cost') +
          kpi('Expenses', money(r.expenses), r.counts.expenses + ' entr' + (r.counts.expenses === 1 ? 'y' : 'ies')) +
          kpi('Net profit', '<span class="' + signClass(r.netProfit) + '">' + money(r.netProfit) + '</span>', 'Gross profit − expenses') +
        '</div>' +
        '<div class="grid g2">' +
          '<div class="box"><h2>Profit &amp; loss <small>simplified</small></h2><table class="table pl"><tbody>' +
            '<tr><td>Sales revenue</td><td class="num">' + money(r.revenue) + '</td></tr>' +
            '<tr><td>− Cost of goods sold (materials, estimated)</td><td class="num">' + money(r.cogs) + '</td></tr>' +
            '<tr class="total"><td>Gross profit</td><td class="num">' + money(r.grossProfit) + '</td></tr>' +
            '<tr><td>− Expenses</td><td class="num">' + money(r.expenses) + '</td></tr>' + exp +
            '<tr class="total"><td>Net profit</td><td class="num ' + signClass(r.netProfit) + '">' + money(r.netProfit) + '</td></tr>' +
            '<tr class="sub"><td>Memo: raw material bought this period (cash out)</td><td class="num">' + money(r.purchasesCash) + '</td></tr>' +
          '</tbody></table></div>' +
          '<div><div class="box"><h2>Produced</h2><div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Material cost</th></tr></thead><tbody>' + (prodRows || emptyRow(3, 'Nothing produced in this period.')) + '</tbody></table></div></div>' +
          '<div class="box"><h2>Sold</h2><div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Revenue</th><th class="num">Profit</th></tr></thead><tbody>' + (soldRows || emptyRow(4, 'Nothing sold in this period.')) + '</tbody></table></div></div></div>' +
        '</div>' +
        '<div class="box"><h2>Stock position <small>right now</small></h2>' +
          (al.length ? '<p class="mb-3"><b class="neg">Shortages:</b> ' + al.map((a) => esc(a.name) + ' (' + STATUS_TEXT[a.status].toLowerCase() + ')').join(', ') + '.</p>' : '<p class="mb-3 pos"><b>No shortages.</b></p>') +
          '<div class="grid g2"><div class="table-wrap"><table class="table"><thead><tr><th>Raw material</th><th class="num">In stock</th><th>Status</th></tr></thead><tbody>' + mRows + '</tbody></table></div>' +
          '<div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th class="num">In stock</th><th>Status</th></tr></thead><tbody>' + pRows + '</tbody></table></div></div>' +
        '</div>';
    },
    bind() {
      document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { rep.mode = b.dataset.mode; render(); }));
      const d = q('#rDate'); if (d) d.addEventListener('change', () => { if (d.value) { rep.date = d.value; render(); } });
      const m = q('#rMonth'); if (m) m.addEventListener('change', () => { if (m.value) { rep.month = m.value; render(); } });
      q('#printBtn').addEventListener('click', () => window.print());
    }
  };

  /* Setup: materials, products & recipes, data tools */
  views.setup = {
    title: 'Setup',
    render() {
      const mRows = state.materials.map((m) =>
        '<tr><td>' + esc(m.name) + '</td><td>' + esc(m.unit) + '</td><td class="num"><input type="number" step="any" min="0" class="form-control form-control-sm inline-edit" data-edit="materials" data-id="' + m.id + '" data-field="reorder" value="' + m.reorder + '"></td></tr>').join('');
      const pCards = state.products.map((p) => {
        const lines = p.recipe.map((l, i) => '<tr><td>' + esc(matName(l.materialId)) + '</td><td class="num">' + qty(l.qty) + ' ' + esc(matUnit(l.materialId)) + '</td><td class="num">' + qty(l.scrapPct || 0) + '%</td>' +
          '<td class="num"><button class="btn btn-sm btn-outline-danger" data-rmline="' + p.id + '" data-idx="' + i + '">×</button></td></tr>').join('');
        return '<div class="box"><h2>' + esc(p.name) + ' <small>unit: ' + esc(p.unit) + '</small></h2>' +
          '<div class="d-flex flex-wrap gap-3 mb-3"><div><label>Selling price (' + CUR + ')</label><input type="number" step="any" min="0" class="form-control form-control-sm inline-edit" data-edit="products" data-id="' + p.id + '" data-field="price" value="' + p.price + '"></div>' +
          '<div><label>Min stock level</label><input type="number" step="any" min="0" class="form-control form-control-sm inline-edit" data-edit="products" data-id="' + p.id + '" data-field="minStock" value="' + p.minStock + '"></div></div>' +
          '<table class="table table-sm"><thead><tr><th>Recipe: per 1 ' + esc(p.unit) + '</th><th class="num">Qty</th><th class="num">Scrap</th><th></th></tr></thead><tbody>' + (lines || emptyRow(4, 'No recipe lines yet.')) + '</tbody></table>' +
          '<div class="d-flex flex-wrap gap-2 mt-2 no-print" data-recipe="' + p.id + '"><select class="form-select form-select-sm w-auto" data-r="mat">' + matOptions() + '</select>' +
          '<input type="number" step="any" min="0" placeholder="qty" class="form-control form-control-sm" style="width:90px" data-r="qty">' +
          '<input type="number" step="any" min="0" placeholder="scrap %" class="form-control form-control-sm" style="width:90px" data-r="scrap">' +
          '<button class="btn btn-sm btn-outline-primary" data-addline="' + p.id + '">Add line</button></div></div>';
      }).join('');
      return '' +
        '<div class="grid g2">' +
          '<div class="box"><h2>Raw materials <small>edit reorder level</small></h2><table class="table"><thead><tr><th>Name</th><th>Unit</th><th class="num">Reorder level</th></tr></thead><tbody>' + (mRows || emptyRow(3, 'No materials yet.')) + '</tbody></table>' +
            '<form id="fMaterial" class="d-flex flex-wrap gap-2 mt-3 no-print"><input class="form-control form-control-sm w-auto" id="mName" placeholder="Name" required>' +
            '<input class="form-control form-control-sm" style="width:80px" id="mUnit" placeholder="Unit" required>' +
            '<input type="number" step="any" min="0" class="form-control form-control-sm" style="width:110px" id="mLevel" placeholder="Reorder lvl" required>' +
            '<button class="btn btn-sm btn-primary">Add material</button></form></div>' +
          '<div class="box"><h2>New product</h2><form id="fProduct">' +
            '<div class="fld"><label>Name</label><input class="form-control" id="pName" required></div>' +
            '<div class="d-flex gap-2"><div class="fld flex-fill"><label>Unit</label><input class="form-control" id="pUnit" value="pcs" required></div>' +
            '<div class="fld flex-fill"><label>Min stock</label><input type="number" step="any" min="0" class="form-control" id="pMin" value="0" required></div>' +
            '<div class="fld flex-fill"><label>Price (' + CUR + ')</label><input type="number" step="any" min="0" class="form-control" id="pPrice" required></div></div>' +
            '<button class="btn btn-primary">Create product</button> <span class="text-muted" style="font-size:0.8rem">then add its recipe below</span></form></div>' +
        '</div>' +
        pCards +
        '<div class="box no-print"><h2>Your data <small>stored in this browser</small></h2><div class="d-flex flex-wrap gap-2">' +
          '<button class="btn btn-outline-primary" id="exportBtn">Export backup (JSON)</button>' +
          '<label class="btn btn-outline-primary mb-0" style="font-weight:500;font-size:1rem;color:inherit">Import backup<input type="file" id="importFile" accept=".json" hidden></label>' +
          '<button class="btn btn-outline-secondary" id="demoBtn">Reset to demo data</button>' +
          '<button class="btn btn-outline-danger" id="clearBtn">Clear everything</button></div></div>';
    },
    bind() {
      document.querySelectorAll('[data-edit]').forEach((inp) => inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (!(v >= 0)) { toast('Enter a valid number.', true); render(); return; }
        act(() => api('PATCH', '/api/' + inp.dataset.edit + '/' + inp.dataset.id, { [inp.dataset.field]: v }), 'Saved.');
      }));
      q('#fMaterial').addEventListener('submit', (e) => {
        e.preventDefault();
        act(() => api('POST', '/api/materials', { name: q('#mName').value, unit: q('#mUnit').value, reorder: parseFloat(q('#mLevel').value) || 0 }), 'Material added.');
      });
      q('#fProduct').addEventListener('submit', (e) => {
        e.preventDefault();
        act(() => api('POST', '/api/products', { name: q('#pName').value, unit: q('#pUnit').value, minStock: parseFloat(q('#pMin').value) || 0, price: parseFloat(q('#pPrice').value) || 0 }), 'Product created. Now add its recipe lines.');
      });
      document.querySelectorAll('[data-addline]').forEach((btn) => btn.addEventListener('click', () => {
        const row = btn.closest('[data-recipe]'), p = byId(state.products, btn.dataset.addline);
        const matId = q('[data-r=mat]', row).value, n = parseFloat(q('[data-r=qty]', row).value), sc = parseFloat(q('[data-r=scrap]', row).value) || 0;
        if (!matId || !(n > 0)) { toast('Choose a material and a quantity.', true); return; }
        if (p.recipe.some((l) => l.materialId === matId)) { toast('That material is already in the recipe.', true); return; }
        act(() => api('POST', '/api/products/' + p.id + '/recipe', { materialId: matId, qty: n, scrapPct: sc }), 'Recipe line added.');
      }));
      document.querySelectorAll('[data-rmline]').forEach((btn) => btn.addEventListener('click', () => {
        act(() => api('DELETE', '/api/products/' + btn.dataset.rmline + '/recipe/' + btn.dataset.idx), 'Line removed.');
      }));
      q('#exportBtn').addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
        a.download = 'buffalo-backup-' + today() + '.json'; a.click();
      });
      q('#importFile').addEventListener('change', (e) => {
        const f = e.target.files[0]; if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          try {
            const s = JSON.parse(rd.result);
            ['materials', 'products', 'purchases', 'productions', 'sales', 'expenses'].forEach((k) => { if (!Array.isArray(s[k])) throw new Error('bad'); });
            act(() => api('POST', '/api/admin/import', s), 'Backup imported.');
          } catch (err) { toast('That file is not a valid Buffalo backup.', true); }
        };
        rd.readAsText(f);
      });
      q('#demoBtn').addEventListener('click', () => { if (confirm('Replace all data with the demo data?')) act(() => api('POST', '/api/admin/reset-demo'), 'Demo data loaded.'); });
      q('#clearBtn').addEventListener('click', () => { if (confirm('Delete ALL data? This cannot be undone.')) act(() => api('POST', '/api/admin/clear'), 'All data cleared.'); });
    }
  };

  /* Users & roles (admin) */
  views.users = {
    title: 'Users & roles',
    render() {
      return '<div class="split"><form class="box" id="fUser"><h2>New user</h2>' +
        '<div class="fld"><label>Full name</label><input class="form-control" id="uName" required></div>' +
        '<div class="fld"><label>Username</label><input class="form-control" id="uUser" autocomplete="off" required></div>' +
        '<div class="fld"><label>Role</label><select class="form-select" id="uRole"><option value="accountant">Accountant</option><option value="storekeeper">Storekeeper</option><option value="admin">Admin</option></select></div>' +
        '<div class="fld"><label>Password (min 8 characters)</label><input type="password" class="form-control" id="uPass" autocomplete="new-password" required></div>' +
        '<button class="btn btn-primary w-100">Create user</button>' +
        '<p class="text-muted mt-3 mb-0" style="font-size:0.8rem"><b>Admin:</b> everything. <b>Accountant:</b> sales, purchases, expenses, reports. <b>Storekeeper:</b> stock, purchases, production (no prices, sales or profit).</p></form>' +
        '<div class="box"><h2>Accounts</h2><div class="table-wrap" id="userList">Loading…</div></div></div>';
    },
    bind() {
      const load = async () => {
        try {
          const { users } = await api('GET', '/api/users');
          q('#userList').innerHTML = '<table class="table"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Created</th><th></th></tr></thead><tbody>' +
            users.map((u) => '<tr><td>' + esc(u.name) + '</td><td class="mono">' + esc(u.username) + '</td><td class="role">' + esc(u.role) + '</td><td>' + esc(u.created) + '</td><td class="text-end text-nowrap">' +
              '<button class="btn btn-sm btn-outline-secondary" data-upw="' + u.id + '">Reset password</button> ' +
              (u.id === user.id ? '' : '<button class="btn btn-sm btn-outline-danger" data-udel="' + u.id + '">Delete</button>') + '</td></tr>').join('') + '</tbody></table>';
          document.querySelectorAll('[data-upw]').forEach((b) => b.addEventListener('click', async () => {
            const pw = prompt('New password (min 8 characters):'); if (!pw) return;
            try { await api('POST', '/api/users/' + b.dataset.upw + '/password', { password: pw }); toast('Password changed.'); } catch (err) { toast(err.message, true); }
          }));
          document.querySelectorAll('[data-udel]').forEach((b) => b.addEventListener('click', async () => {
            if (!confirm('Delete this user?')) return;
            try { await api('DELETE', '/api/users/' + b.dataset.udel); toast('User deleted.'); load(); } catch (err) { toast(err.message, true); }
          }));
        } catch (err) { q('#userList').textContent = err.message; }
      };
      load();
      q('#fUser').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/api/users', { name: q('#uName').value, username: q('#uUser').value, role: q('#uRole').value, password: q('#uPass').value });
          toast('User created.'); render();
        } catch (err) { toast(err.message, true); }
      });
    }
  };

  /* ---------- shell ---------- */
  const NAV = [
    ['dashboard', 'Dashboard'], ['stock', 'Stock'], ['purchases', 'Purchases'], ['production', 'Production'],
    ['sales', 'Sales'], ['expenses', 'Expenses'], ['reports', 'Reports'], ['setup', 'Setup'], ['users', 'Users']
  ];
  const ROLE_VIEWS = {
    admin: ['dashboard', 'stock', 'purchases', 'production', 'sales', 'expenses', 'reports', 'setup', 'users'],
    accountant: ['dashboard', 'stock', 'purchases', 'sales', 'expenses', 'reports'],
    storekeeper: ['stock', 'purchases', 'production']
  };
  function renderNav() {
    const n = L.alerts(state).length;
    q('#nav').innerHTML = NAV.filter(([id]) => ROLE_VIEWS[user.role].includes(id)).map(([id, label]) =>
      '<button data-go="' + id + '" class="' + (id === view ? 'active' : '') + '">' + label + (id === 'stock' && n ? '<span class="badge-n">' + n + '</span>' : '') + '</button>').join('');
  }
  function render() {
    if (!user) return;
    if (!ROLE_VIEWS[user.role].includes(view)) view = ROLE_VIEWS[user.role][0];
    const v = views[view];
    q('#pageTitle').textContent = v.title;
    q('#view').innerHTML = v.render();
    renderNav();
    q('#who').innerHTML = '<b>' + esc(user.name) + '</b><span>' + esc(user.role) + '</span><div class="links"><button data-act="pw">Change password</button><button data-act="logout">Sign out</button></div>';
    if (v.bind) v.bind();
  }
  function go(id) { view = id; render(); window.scrollTo(0, 0); }

  // one delegated listener for navigation and delete buttons
  document.addEventListener('click', (e) => {
    const goBtn = e.target.closest('[data-go]');
    if (goBtn) { go(goBtn.dataset.go); return; }
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      if (actBtn.dataset.act === 'logout') { api('POST', '/api/logout').catch(() => {}).then(() => { user = null; state = L.emptyData(); showLogin(); }); }
      if (actBtn.dataset.act === 'pw') {
        const cur = prompt('Current password:'); if (!cur) return;
        const nxt = prompt('New password (min 8 characters):'); if (!nxt) return;
        api('POST', '/api/me/password', { current: cur, next: nxt }).then(() => toast('Password changed.')).catch((err) => toast(err.message, true));
      }
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!confirm('Delete this entry?')) return;
      act(() => api('DELETE', '/api/' + del.dataset.del + '/' + del.dataset.id), 'Deleted.');
    }
  });

  /* ---------- login ---------- */
  function showLogin() { q('#login').hidden = false; q('#lErr').textContent = ''; q('#lPass').value = ''; q('#lUser').focus(); }
  q('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/login', { username: q('#lUser').value.trim(), password: q('#lPass').value });
      await refresh();
      q('#login').hidden = true;
      view = ROLE_VIEWS[user.role][0];
      render();
    } catch (err) { q('#lErr').textContent = err.message; }
  });
  q('#todayLabel').textContent = niceDate(today());
  refresh().then(() => { q('#login').hidden = true; view = ROLE_VIEWS[user.role][0]; render(); }).catch(() => showLogin());
})();
