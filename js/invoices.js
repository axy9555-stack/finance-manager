/* 财务管理系统 · 发票管理（chunk 8）
 * window.FMInvoices = { list, getById, issueSales, receivePurchase, void, linkVoucher, reconciliation,
 *                       renderInvoices }
 * - 发票存 state.invoices：{id, no, type:'销售'|'采购', partyId, date, amount(含税,分), taxRate,
 *   net(分), tax(分), status:'未开'|'已开'|'已作废', voucherId, summary, createdAt}。
 * - 税额 = 含税金额 − round(含税金额 / (1 + 税率))，全程整数分；税率只允许 13% / 9% / 6%。
 * - 开票（issueSales，客户取 state.customers）/ 收票（receivePurchase，供应商取 state.suppliers）
 *   直接生成“已开”发票（data.status === '未开' 可存草稿）；已开发票不许改，只能作废；
 *   作废前提：voucherId 为空（未入账）——已关联凭证的不许作废。
 * - 勾稽（reconciliation）：当期已开（未作废）销售发票合计 vs 6001 收入发生额、采购发票合计 vs
 *   1405 借方发生额，仅展示参考、不强校验——种子发票与凭证不一定一一勾稽。
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }
  function A() { return root.FMAccounts; }

  var RATES = [0.13, 0.09, 0.06];

  function currentPeriod() {
    var p = S().get('periods');
    return (p && p.current) || '';
  }

  function invoices() { return S().get('invoices') || []; }

  function fail(reason) { return { ok: false, reason: reason }; }

  function getById(id) {
    var hit = null;
    invoices().forEach(function (inv) { if (inv.id === id) hit = inv; });
    return hit;
  }

  function list(filter) {
    filter = filter || {};
    var out = invoices().filter(function (inv) {
      if (filter.type && inv.type !== filter.type) return false;
      if (filter.status && inv.status !== filter.status) return false;
      if (filter.partyId && inv.partyId !== filter.partyId) return false;
      return true;
    });
    out.sort(function (x, y) { return x.id < y.id ? -1 : 1; });
    return out;
  }

  // 金额（含税）归一：整数分直接用，字符串/元数字走 toCents
  function normalizeAmount(v) {
    if (typeof v === 'number' && isFinite(v)) return Math.round(v) === v ? v : null;
    return S().toCents(v);
  }

  // 含税 → {net, tax}：net = round(amount / (1+rate))，tax = amount − net（四舍五入到分由 round 保证）
  function splitTax(amount, rate) {
    var net = Math.round(amount / (1 + rate));
    return { net: net, tax: amount - net };
  }

  function nextId(type) {
    var period = currentPeriod();
    var prefix = 'INV-' + period + '-';
    var max = 0;
    invoices().forEach(function (inv) {
      if (inv.id && inv.id.indexOf(prefix) === 0) {
        var n = parseInt(inv.id.slice(prefix.length), 10);
        if (n > max) max = n;
      }
    });
    return prefix + ('000' + (max + 1)).slice(-4);
  }

  /* 校验 + 构造（开票/收票共用）。kind = '销售'（客户）| '采购'（供应商） */
  function build(kind, data) {
    data = data || {};
    var partyId = String(data.customerId || data.supplierId || '').trim();
    if (!partyId) return fail(kind === '销售' ? '客户不能为空' : '供应商不能为空');
    var pool = S().get(kind === '销售' ? 'customers' : 'suppliers') || [];
    var party = null;
    pool.forEach(function (p) { if (p.id === partyId) party = p; });
    if (!party) return fail((kind === '销售' ? '客户' : '供应商') + '“' + partyId + '”不存在，请先在档案中增加');
    var amount = normalizeAmount(data.amount);
    if (amount === null || amount <= 0) return fail('含税金额格式不正确（应为正数，最多两位小数）');
    var rate = Number(data.taxRate);
    if (RATES.indexOf(rate) < 0) return fail('税率只能是 ' + RATES.map(function (r) { return (r * 100).toFixed(0) + '%'; }).join(' / '));
    var date = String(data.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('发票日期格式不正确，应为 2026-11-25');
    if (date.slice(0, 7) !== currentPeriod()) return fail('发票日期 ' + date + ' 不在当前会计期间（' + currentPeriod() + '）内');
    var st = splitTax(amount, rate);
    return {
      ok: true,
      record: {
        id: nextId(kind), no: String(data.no || '').trim(),
        type: kind, partyId: partyId, date: date,
        amount: amount, taxRate: rate, net: st.net, tax: st.tax,
        status: data.status === '未开' ? '未开' : '已开',
        voucherId: '', summary: String(data.summary || '').trim(),
        createdAt: new Date().toISOString()
      }
    };
  }

  // 开票（销售发票）：默认直接“已开”；data.status === '未开' 时存草稿（后续开票动作再改状态）
  function issueSales(data) {
    var b = build('销售', data);
    if (!b.ok) return b;
    var arr = invoices();
    arr.push(b.record);
    S().set('invoices', arr);
    S().log('开票', b.record.id, '客户 ' + b.record.partyId + '，含税 ' + S().fmt(b.record.amount) +
      '，税额 ' + S().fmt(b.record.tax) + '（' + (b.record.status === '已开' ? '已开' : '草稿') + '）');
    return { ok: true, id: b.record.id, invoice: b.record };
  }

  // 收票（采购发票登记）：收到供应商发票即“已开”
  function receivePurchase(data) {
    var b = build('采购', data);
    if (!b.ok) return b;
    var arr = invoices();
    arr.push(b.record);
    S().set('invoices', arr);
    S().log('收票', b.record.id, '供应商 ' + b.record.partyId + '，含税 ' + S().fmt(b.record.amount) +
      '，税额 ' + S().fmt(b.record.tax));
    return { ok: true, id: b.record.id, invoice: b.record };
  }

  // 关联凭证（入账登记）：voucherId 非空后不可再作废
  function linkVoucher(id, voucherId) {
    var inv = getById(id);
    if (!inv) return fail('发票“' + id + '”不存在');
    if (inv.status === '已作废') return fail('已作废发票不能关联凭证');
    if (inv.voucherId) return fail('发票已关联凭证 ' + inv.voucherId + '，不能重复关联');
    voucherId = String(voucherId || '').trim();
    if (!voucherId) return fail('凭证编号不能为空');
    var vmap = {};
    (S().get('vouchers') || []).forEach(function (v) { vmap[v.id] = true; });
    if (!vmap[voucherId]) return fail('凭证“' + voucherId + '”不存在');
    inv.voucherId = voucherId;
    S().set('invoices', invoices());
    S().log('发票关联凭证', id, '关联 ' + voucherId);
    return { ok: true, invoice: inv };
  }

  // 作废：只能作废未入账的（voucherId 为空）；已关联凭证的不许作废
  function voidInvoice(id) {
    var inv = getById(id);
    if (!inv) return fail('发票“' + id + '”不存在');
    if (inv.status === '已作废') return fail('发票已作废，不能重复作废');
    if (inv.voucherId) return fail('发票已关联凭证 ' + inv.voucherId + '（已入账），不能作废，请先红字冲销对应凭证');
    inv.status = '已作废';
    S().set('invoices', invoices());
    S().log('发票作废', id, (inv.type === '销售' ? '销售' : '采购') + '发票 ' + S().fmt(inv.amount));
    return { ok: true, invoice: inv };
  }

  // 勾稽参考（只展示不强校验）：当期按发票日期前缀匹配
  function reconciliation(period) {
    period = period || currentPeriod();
    var salesIssued = 0, purchaseIssued = 0, salesVoid = 0, purchaseVoid = 0;
    invoices().forEach(function (inv) {
      if (String(inv.date).slice(0, 7) !== period) return;
      if (inv.type === '销售') {
        if (inv.status === '已开') salesIssued += inv.amount;
        if (inv.status === '已作废') salesVoid += inv.amount;
      } else {
        if (inv.status === '已开') purchaseIssued += inv.amount;
        if (inv.status === '已作废') purchaseVoid += inv.amount;
      }
    });
    var rev = A().activity('6001', period, { postedOnly: true, periodOnly: true });
    var pur = A().activity('1405', period, { postedOnly: true, periodOnly: true });
    return {
      period: period,
      salesIssued: salesIssued, purchaseIssued: purchaseIssued,
      salesVoid: salesVoid, purchaseVoid: purchaseVoid,
      revenuePosted: rev.credit - rev.debit,   // 6001 本期贷方净额（已过账）
      purchasePosted: pur.debit - pur.credit,  // 1405 本期借方净额（已过账）
      salesDiff: salesIssued - (rev.credit - rev.debit),
      purchaseDiff: purchaseIssued - (pur.debit - pur.credit)
    };
  }

  /* ---------- 渲染 ---------- */

  var F = { type: '', status: '' };

  function partyName(inv) {
    var pool = S().get(inv.type === '销售' ? 'customers' : 'suppliers') || [];
    for (var i = 0; i < pool.length; i++) if (pool[i].id === inv.partyId) return pool[i].name;
    return inv.partyId;
  }

  function renderInvoices(el) {
    var esc = S().esc, fmt = S().fmt;
    var rows = list(F);
    var rec = reconciliation(currentPeriod());

    var html = '<div class="page-head"><h2>发票管理</h2><div class="page-actions">' +
      '<span class="muted">含税金额 · 税率 13%/9%/6% · 已开发票只能作废</span></div></div>';

    html += '<div class="cards">';
    html += '<div class="card"><div class="card-label">当期已开销售发票</div><div class="card-num num">' + fmt(rec.salesIssued) + '</div>' +
      '<div class="card-extra">6001 收入（已过账）' + fmt(rec.revenuePosted) + ' · 差 ' + fmt(rec.salesDiff) + '</div></div>';
    html += '<div class="card"><div class="card-label">当期已开采购发票</div><div class="card-num num">' + fmt(rec.purchaseIssued) + '</div>' +
      '<div class="card-extra">1405 采购（已过账）' + fmt(rec.purchasePosted) + ' · 差 ' + fmt(rec.purchaseDiff) + '</div></div>';
    html += '</div>';
    html += '<div class="muted" style="margin:8px 0">勾稽仅为展示参考，不做强校验：种子发票与凭证并非一一对应（部分未入账、部分未开票），差额属预期。</div>';

    html += '<div class="filter-bar">类型 <select id="fm-inv-type" class="input" style="width:100px">' +
      '<option value="">全部</option><option value="销售"' + (F.type === '销售' ? ' selected' : '') + '>销售</option>' +
      '<option value="采购"' + (F.type === '采购' ? ' selected' : '') + '>采购</option></select>' +
      '　状态 <select id="fm-inv-status" class="input" style="width:100px"><option value="">全部</option>' +
      ['未开', '已开', '已作废'].map(function (s) {
        return '<option value="' + s + '"' + (F.status === s ? ' selected' : '') + '>' + s + '</option>';
      }).join('') + '</select>' +
      '　<button class="btn" data-action="filter">查询</button></div>';

    /* 开票 / 收票表单 */
    html += '<h3 class="sec-title">开票 / 收票</h3><table class="form-table">' +
      '<tr><th>销售发票</th><td>客户 <select id="fm-inv-cust" class="input" style="width:200px">' +
      (S().get('customers') || []).map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('') +
      '</select> 含税金额 <input id="fm-inv-amount" class="input num" style="width:120px" placeholder="11300.00">' +
      ' 税率 <select id="fm-inv-rate" class="input" style="width:80px">' +
      RATES.map(function (r) { return '<option value="' + r + '">' + (r * 100).toFixed(0) + '%</option>'; }).join('') + '</select>' +
      ' 日期 <input id="fm-inv-date" class="input" style="width:110px" value="' + esc(currentPeriod()) + '-25">' +
      ' 摘要 <input id="fm-inv-summary" class="input" style="width:180px"> ' +
      '<button class="btn btn-primary" data-action="issue">开票</button></td></tr>' +
      '<tr><th>采购发票</th><td>供应商 <select id="fm-inv-sup" class="input" style="width:200px">' +
      (S().get('suppliers') || []).map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('') +
      '</select> 含税金额 <input id="fm-inv-amount2" class="input num" style="width:120px" placeholder="904000.00">' +
      ' 税率 <select id="fm-inv-rate2" class="input" style="width:80px">' +
      RATES.map(function (r) { return '<option value="' + r + '">' + (r * 100).toFixed(0) + '%</option>'; }).join('') + '</select>' +
      ' 日期 <input id="fm-inv-date2" class="input" style="width:110px" value="' + esc(currentPeriod()) + '-25">' +
      ' 摘要 <input id="fm-inv-summary2" class="input" style="width:180px"> ' +
      '<button class="btn btn-primary" data-action="receive">收票</button></td></tr></table>';

    html += '<h3 class="sec-title">发票列表（' + rows.length + ' 张）</h3>';
    html += '<table class="grid"><thead><tr><th style="width:140px">编号</th><th style="width:60px">类型</th><th style="width:110px">发票号</th>' +
      '<th>购销方</th><th style="width:100px">日期</th><th class="num" style="width:120px">含税金额</th>' +
      '<th class="num" style="width:110px">税额</th><th class="center" style="width:70px">状态</th>' +
      '<th style="width:150px">关联凭证</th><th style="width:160px">操作</th></tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="10" class="center muted">没有符合条件的发票</td></tr>';
    rows.forEach(function (inv) {
      var ops = '';
      if (inv.status !== '已作废') {
        ops += '<button class="btn btn-sm btn-danger" data-act="void" data-id="' + esc(inv.id) + '">作废</button> ';
        if (!inv.voucherId) {
          ops += '<input class="input fm-link" data-id="' + esc(inv.id) + '" style="width:120px" placeholder="凭证号">';
          ops += '<button class="btn btn-sm" data-act="link" data-id="' + esc(inv.id) + '">关联凭证</button>';
        }
      }
      html += '<tr><td class="mono">' + esc(inv.id) + '</td><td>' + inv.type + '</td><td class="mono">' + esc(inv.no || '—') + '</td>' +
        '<td>' + esc(partyName(inv)) + '</td><td>' + esc(inv.date) + '</td>' +
        '<td class="num">' + fmt(inv.amount) + '</td><td class="num">' + fmt(inv.tax) + '</td>' +
        '<td class="center"><span class="badge" data-status="' + esc(inv.status) + '">' + inv.status + '</span></td>' +
        '<td class="mono">' + esc(inv.voucherId || '—') + '</td><td>' + ops + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && (t.dataset.action || t.dataset.act))) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      var act = t.dataset.action || t.dataset.act;
      if (act === 'filter') {
        var ty = document.getElementById('fm-inv-type'), st = document.getElementById('fm-inv-status');
        F.type = ty ? ty.value : '';
        F.status = st ? st.value : '';
        renderInvoices(el);
        return;
      }
      if (act === 'issue') {
        var res = issueSales({
          customerId: val('fm-inv-cust'), amount: val('fm-inv-amount'), taxRate: Number(val('fm-inv-rate')),
          date: val('fm-inv-date'), summary: val('fm-inv-summary')
        });
        toast(res, '开票成功');
        if (res.ok) renderInvoices(el);
        return;
      }
      if (act === 'receive') {
        var res2 = receivePurchase({
          supplierId: val('fm-inv-sup'), amount: val('fm-inv-amount2'), taxRate: Number(val('fm-inv-rate2')),
          date: val('fm-inv-date2'), summary: val('fm-inv-summary2')
        });
        toast(res2, '收票成功');
        if (res2.ok) renderInvoices(el);
        return;
      }
      var id = t.dataset.id;
      if (act === 'void') {
        var rv = voidInvoice(id);
        toast(rv, '已作废');
        if (rv.ok) renderInvoices(el);
      } else if (act === 'link') {
        var inp = t.parentNode.querySelector('input.fm-link');
        var rl = linkVoucher(id, inp ? inp.value : '');
        toast(rl, '已关联');
        if (rl.ok) renderInvoices(el);
      }
    };
  }

  function val(id) {
    var n = document.getElementById(id);
    return n ? n.value.trim() : '';
  }

  function toast(res, okMsg) {
    if (root.FMToast) root.FMToast(res.ok ? okMsg + '：' + res.id : res.reason, res.ok ? 'ok' : 'bad');
  }

  root.FMInvoices = {
    list: list, getById: getById, issueSales: issueSales, receivePurchase: receivePurchase,
    void: voidInvoice, linkVoucher: linkVoucher, reconciliation: reconciliation, renderInvoices: renderInvoices
  };
})(typeof window !== 'undefined' ? window : globalThis);
