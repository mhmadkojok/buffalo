/* Buffalo — business logic (pure functions, no DOM). Runs in the browser and in Node (for tests).
 *
 * Model
 *  - Raw-material stock   = purchases − material consumed by production
 *  - Finished-goods stock = produced − sold
 *  - A product's recipe lists, per 1 unit, how much of each material it needs plus a scrap %.
 *  - Material cost is the weighted average of all purchases.
 *  - Each production record keeps a snapshot of what it consumed; each sale keeps a snapshot of unit cost.
 *  - Profit (simplified):  revenue − cost of goods sold = gross profit;  gross profit − expenses = net profit.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const r3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
  let seq = 0;
  const uid = (p) => p + Date.now().toString(36) + (seq++).toString(36) + Math.floor(Math.random() * 1296).toString(36);
  const byId = (arr, id) => arr.find((x) => x.id === id);

  const EXPENSE_CATEGORIES = ['Salaries', 'Electricity', 'Rent', 'Maintenance', 'Transport', 'Packaging & misc', 'Other'];

  /* ---------- dates ---------- */
  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function monthRange(ym) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: ym + '-01', to: ym + '-' + String(last).padStart(2, '0') };
  }

  /* ---------- stock ---------- */
  function statusOf(stock, level) {
    if (stock <= EPS) return 'out';
    if (stock <= level + EPS) return 'low';
    return 'ok';
  }
  function materialStock(s, id) {
    const bought = s.purchases.filter((p) => p.materialId === id).reduce((a, p) => a + p.qty, 0);
    const used = s.productions.reduce(
      (a, pr) => a + pr.consumed.filter((c) => c.materialId === id).reduce((b, c) => b + c.qty, 0), 0);
    return r3(bought - used);
  }
  function productStock(s, id) {
    const made = s.productions.filter((p) => p.productId === id).reduce((a, p) => a + p.qty, 0);
    const sold = s.sales.filter((x) => x.productId === id).reduce((a, x) => a + x.qty, 0);
    return r3(made - sold);
  }
  const materialStatus = (s, m) => statusOf(materialStock(s, m.id), m.reorder);
  const productStatus = (s, p) => statusOf(productStock(s, p.id), p.minStock);

  /* ---------- costs & recipes ---------- */
  function avgMaterialCost(s, id) {
    let q = 0, c = 0;
    s.purchases.forEach((p) => { if (p.materialId === id) { q += p.qty; c += p.qty * p.unitCost; } });
    return q > 0 ? c / q : 0;
  }
  const perUnit = (line) => line.qty * (1 + (line.scrapPct || 0) / 100);
  function bomNeeds(product, qty) {
    return product.recipe.map((l) => ({ materialId: l.materialId, qty: r3(qty * perUnit(l)) }));
  }
  function productUnitCost(s, product) {
    return product.recipe.reduce((a, l) => a + perUnit(l) * avgMaterialCost(s, l.materialId), 0);
  }
  function producible(s, product) {
    if (!product.recipe.length) return { max: 0, limiting: null };
    let max = Infinity, limiting = null;
    product.recipe.forEach((l) => {
      const n = Math.floor(materialStock(s, l.materialId) / perUnit(l) + EPS);
      if (n < max) { max = n; limiting = l.materialId; }
    });
    return { max: Math.max(0, max), limiting };
  }
  const maxProducible = (s, product) => producible(s, product).max;

  /* ---------- production ---------- */
  function checkProduction(s, productId, qty) {
    const product = byId(s.products, productId);
    if (!product) return { ok: false, error: 'Choose a product.', lines: [] };
    if (!product.recipe.length) return { ok: false, error: 'This product has no recipe yet (see Setup).', lines: [] };
    if (!(qty > 0)) return { ok: false, error: 'Enter a quantity greater than zero.', lines: [] };
    const lines = bomNeeds(product, qty).map((n) => {
      const have = materialStock(s, n.materialId);
      return { materialId: n.materialId, need: n.qty, have, missing: r3(Math.max(0, n.qty - have)) };
    });
    const short = lines.filter((l) => l.missing > 0);
    return { ok: short.length === 0, lines, error: short.length ? 'Not enough raw material.' : null };
  }
  function makeProduction(s, { date, productId, qty, note }) {
    const chk = checkProduction(s, productId, qty);
    if (!chk.ok) throw new Error(chk.error);
    const consumed = chk.lines.map((l) => ({ materialId: l.materialId, qty: l.need, unitCost: avgMaterialCost(s, l.materialId) }));
    const cost = consumed.reduce((a, c) => a + c.qty * c.unitCost, 0);
    const rec = { id: uid('pr'), date, productId, qty, consumed, cost: r2(cost), note: note || '' };
    s.productions.push(rec);
    return rec;
  }

  /* ---------- sales ---------- */
  function checkSale(s, productId, qty) {
    const product = byId(s.products, productId);
    if (!product) return { ok: false, error: 'Choose a product.', have: 0 };
    const have = productStock(s, productId);
    if (!(qty > 0)) return { ok: false, error: 'Enter a quantity greater than zero.', have };
    if (qty > have + EPS) return { ok: false, error: 'Only ' + have + ' ' + product.unit + ' in stock.', have };
    return { ok: true, error: null, have };
  }
  function makeSale(s, { date, productId, qty, unitPrice, customer }) {
    const chk = checkSale(s, productId, qty);
    if (!chk.ok) throw new Error(chk.error);
    if (!(unitPrice >= 0)) throw new Error('Enter a valid selling price.');
    const product = byId(s.products, productId);
    const rec = { id: uid('sa'), date, productId, qty, unitPrice, unitCost: r2(productUnitCost(s, product) * 100) / 100, customer: customer || '' };
    s.sales.push(rec);
    return rec;
  }

  /* ---------- purchases & expenses ---------- */
  function addPurchase(s, { date, materialId, qty, unitCost, supplier }) {
    if (!byId(s.materials, materialId)) throw new Error('Choose a material.');
    if (!(qty > 0)) throw new Error('Enter a quantity greater than zero.');
    if (!(unitCost >= 0)) throw new Error('Enter a valid unit cost.');
    const rec = { id: uid('pu'), date, materialId, qty, unitCost, supplier: supplier || '' };
    s.purchases.push(rec);
    return rec;
  }
  function addExpense(s, { date, category, amount, note }) {
    if (!(amount > 0)) throw new Error('Enter an amount greater than zero.');
    const rec = { id: uid('ex'), date, category, amount, note: note || '' };
    s.expenses.push(rec);
    return rec;
  }

  /* Remove a transaction only if no stock would go negative afterwards. */
  function removeEntry(s, collection, id) {
    const copy = JSON.parse(JSON.stringify(s));
    copy[collection] = copy[collection].filter((x) => x.id !== id);
    const badM = copy.materials.find((m) => materialStock(copy, m.id) < -EPS);
    if (badM) return { ok: false, error: 'Cannot delete: it would make "' + badM.name + '" stock negative.' };
    const badP = copy.products.find((p) => productStock(copy, p.id) < -EPS);
    if (badP) return { ok: false, error: 'Cannot delete: it would make "' + badP.name + '" stock negative.' };
    s[collection] = s[collection].filter((x) => x.id !== id);
    return { ok: true };
  }

  /* ---------- alerts ---------- */
  function alerts(s) {
    const out = [];
    s.materials.forEach((m) => {
      const stock = materialStock(s, m.id), status = statusOf(stock, m.reorder);
      if (status !== 'ok') out.push({ kind: 'material', id: m.id, name: m.name, unit: m.unit, stock, level: m.reorder, status, suggest: r3(Math.max(0, m.reorder * 2 - stock)) });
    });
    s.products.forEach((p) => {
      const stock = productStock(s, p.id), status = statusOf(stock, p.minStock);
      if (status !== 'ok') out.push({ kind: 'product', id: p.id, name: p.name, unit: p.unit, stock, level: p.minStock, status, suggest: r3(Math.max(0, p.minStock * 2 - stock)) });
    });
    return out.sort((a, b) => (a.status === 'out' ? 0 : 1) - (b.status === 'out' ? 0 : 1));
  }

  /* ---------- reports ---------- */
  function report(s, from, to) {
    const inR = (d) => d >= from && d <= to;
    const sales = s.sales.filter((x) => inR(x.date));
    const prods = s.productions.filter((x) => inR(x.date));
    const purchases = s.purchases.filter((x) => inR(x.date));
    const expenses = s.expenses.filter((x) => inR(x.date));

    const revenue = sales.reduce((a, x) => a + x.qty * x.unitPrice, 0);
    const cogs = sales.reduce((a, x) => a + x.qty * x.unitCost, 0);
    const expenseTotal = expenses.reduce((a, x) => a + x.amount, 0);
    const purchasesCash = purchases.reduce((a, x) => a + x.qty * x.unitCost, 0);

    const expenseByCategory = {};
    expenses.forEach((x) => { expenseByCategory[x.category] = (expenseByCategory[x.category] || 0) + x.amount; });

    const producedBy = {}, soldBy = {};
    prods.forEach((x) => {
      const o = producedBy[x.productId] || (producedBy[x.productId] = { qty: 0, cost: 0 });
      o.qty += x.qty; o.cost += x.cost;
    });
    sales.forEach((x) => {
      const o = soldBy[x.productId] || (soldBy[x.productId] = { qty: 0, revenue: 0, cost: 0 });
      o.qty += x.qty; o.revenue += x.qty * x.unitPrice; o.cost += x.qty * x.unitCost;
    });

    return {
      from, to,
      revenue: r2(revenue), cogs: r2(cogs), grossProfit: r2(revenue - cogs),
      expenses: r2(expenseTotal), netProfit: r2(revenue - cogs - expenseTotal),
      purchasesCash: r2(purchasesCash),
      expenseByCategory, producedBy, soldBy,
      counts: { sales: sales.length, productions: prods.length, purchases: purchases.length, expenses: expenses.length }
    };
  }
  const dayReport = (s, date) => report(s, date, date);
  const monthReport = (s, ym) => { const r = monthRange(ym); return report(s, r.from, r.to); };

  /* ---------- data ---------- */
  const emptyData = () => ({ materials: [], products: [], purchases: [], productions: [], sales: [], expenses: [] });

  function demoData(today) {
    const s = emptyData();
    const mk = (id, name, unit, reorder) => { s.materials.push({ id, name, unit, reorder }); };
    mk('m_pe', 'PE granules', 'kg', 500);
    mk('m_pp', 'PP granules', 'kg', 400);
    mk('m_mb', 'Colour masterbatch', 'kg', 30);
    mk('m_ct', 'Cartons', 'pcs', 200);

    s.products.push(
      { id: 'p_bucket', name: 'Plastic bucket 10L', unit: 'pcs', minStock: 100, price: 3.5,
        recipe: [{ materialId: 'm_pe', qty: 0.45, scrapPct: 3 }, { materialId: 'm_mb', qty: 0.01, scrapPct: 0 }, { materialId: 'm_ct', qty: 0.05, scrapPct: 0 }] },
      { id: 'p_chair', name: 'Plastic chair', unit: 'pcs', minStock: 50, price: 9,
        recipe: [{ materialId: 'm_pp', qty: 2.2, scrapPct: 4 }, { materialId: 'm_mb', qty: 0.05, scrapPct: 0 }] },
      { id: 'p_bags', name: 'Shopping bags 1kg pack', unit: 'pack', minStock: 200, price: 2.5,
        recipe: [{ materialId: 'm_pe', qty: 1, scrapPct: 5 }, { materialId: 'm_mb', qty: 0.01, scrapPct: 0 }, { materialId: 'm_ct', qty: 0.02, scrapPct: 0 }] }
    );

    const d = (n) => addDays(today, n);
    const buy = (date, materialId, qty, unitCost, supplier) => addPurchase(s, { date, materialId, qty, unitCost, supplier });
    buy(d(-20), 'm_pe', 2000, 1.2, 'Gulf Polymers');
    buy(d(-20), 'm_pp', 1500, 1.35, 'Gulf Polymers');
    buy(d(-20), 'm_mb', 100, 6, 'ColorTech');
    buy(d(-20), 'm_ct', 1000, 0.4, 'BoxPack Co.');

    const make = (date, productId, qty) => makeProduction(s, { date, productId, qty });
    make(d(-17), 'p_bucket', 1000);
    make(d(-15), 'p_bags', 600);
    make(d(-12), 'p_chair', 200);
    make(d(-9), 'p_bucket', 800);
    make(d(-6), 'p_chair', 200);
    make(d(-3), 'p_bucket', 300);

    const sell = (date, productId, qty, customer) =>
      makeSale(s, { date, productId, qty, unitPrice: byId(s.products, productId).price, customer });
    sell(d(-14), 'p_bucket', 500, 'Al-Amal Stores');
    sell(d(-10), 'p_chair', 150, 'City Furniture');
    sell(d(-8), 'p_bucket', 600, 'Hypermart');
    sell(d(-5), 'p_bags', 300, 'Hypermart');
    sell(d(-4), 'p_chair', 200, 'City Furniture');
    sell(d(-2), 'p_bucket', 400, 'Al-Amal Stores');

    const first = today.slice(0, 8) + '01';
    addExpense(s, { date: first, category: 'Salaries', amount: 4500, note: 'Monthly payroll' });
    addExpense(s, { date: first, category: 'Rent', amount: 1200, note: 'Factory rent' });
    addExpense(s, { date: d(-3), category: 'Electricity', amount: 820, note: 'Machines & lighting' });
    addExpense(s, { date: d(-1), category: 'Transport', amount: 140, note: 'Delivery fuel' });
    return s;
  }

  return {
    EXPENSE_CATEGORIES, uid, r2, r3, byId, addDays, monthRange,
    statusOf, materialStock, productStock, materialStatus, productStatus,
    avgMaterialCost, bomNeeds, productUnitCost, producible, maxProducible,
    checkProduction, makeProduction, checkSale, makeSale, addPurchase, addExpense, removeEntry,
    alerts, report, dayReport, monthReport, emptyData, demoData
  };
});
