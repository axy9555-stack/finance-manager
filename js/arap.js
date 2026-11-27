/* 财务管理系统 · 应收应付 / 往来账（chunk 3）
 * window.FMARAP = { customers, suppliers, customerBalance, supplierBalance, aging,
 *                   listReceivables, listPayables, renderARAP }
 * 口径约定：
 * - 客户/供应商只是辅助核算：应收只看科目 1122（aux.customer），应付只看 2202（aux.supplier），
 *   不另建科目；金额一律整数分。
 * - 只汇总已过账凭证（与 V.trialBalance / A.balance / FMLedger 同口径）。
 * - customerBalance / supplierBalance 的 opening/closing：应收借正（客户欠我们为正）、
 *   应付贷正（我们欠供应商为正），合计分别等于 A.balance('1122') / A.balance('2202')。
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }
  function A() { return root.FMAccounts; }

  function currentPeriod() {
    var p = S().get('periods');
    return (p && p.current) || '';
  }

  function periodEndDate(period) {
    var y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7));
    var d = new Date(y, m, 0).getDate();
    return period + '-' + ('0' + d).slice(-2);
  }

  // b − a 的天数（'YYYY-MM-DD'）
  function daysBetween(a, b) {
    function u(s) { return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))); }
    return Math.round((u(b) - u(a)) / 86400000);
  }

  function voucherMap() {
    var m = {};
    (S().get('vouchers') || []).forEach(function (v) { m[v.id] = v; });
    return m;
  }

  function entriesOf(kind, code) { // kind: 'customer' | 'supplier'
    return (S().get('entries') || []).filter(function (e) {
      return e.aux && e.aux[kind] === code;
    });
  }

  /* ---------- 往来档案 ---------- */

  // 从 store 档案读，凭证 aux 里出现但档案没有的编码自动补一个（名称取编码）
  function parties(kind) {
    var list = (S().get(kind === 'customer' ? 'customers' : 'suppliers') || []).map(function (p) {
      return {
        id: p.id, name: p.name, contact: p.contact || '', phone: p.phone || '',
        creditLimit: p.creditLimit || 0, creditDays: p.creditDays || 30, auto: false
      };
    });
    var have = {};
    list.forEach(function (p) { have[p.id] = true; });
    (S().get('entries') || []).forEach(function (e) {
      var code = e.aux && e.aux[kind];
      if (code && !have[code]) {
        have[code] = true;
        list.push({ id: code, name: code, contact: '', phone: '', creditLimit: 0, creditDays: 30, auto: true });
      }
    });
    return list;
  }

  function customers() { return parties('customer'); }
  function suppliers() { return parties('supplier'); }

  /* ---------- 余额 ---------- */

  // 某客户截至某期间的应收余额（1122，借正）：期初 + 已过账应收发生 − 已过账收款
  function customerBalance(code, period) {
    period = period || currentPeriod();
    var opening = 0;
    A().all().forEach(function (a) {
      if (String(a.code).indexOf('1122') !== 0) return;
      (a.openingAux || []).forEach(function (o) { if (o.customer === code) opening += o.amount || 0; });
    });
    var vmap = voucherMap(), debit = 0, credit = 0, pre = 0, name = code;
    entriesOf('customer', code).forEach(function (e) {
      if (String(e.accountCode).indexOf('1122') !== 0) return;
      var v = vmap[e.voucherId];
      if (!v || v.status !== '已过账') return;
      if (v.period < period) pre += (e.debit || 0) - (e.credit || 0);
      else if (v.period === period) { debit += e.debit || 0; credit += e.credit || 0; }
    });
    (S().get('customers') || []).some(function (p) { if (p.id === code) { name = p.name; return true; } return false; });
    var open = opening + pre;
    return { code: code, name: name, opening: open, debit: debit, credit: credit, closing: open + debit - credit };
  }

  // 某供应商截至某期间的应付余额（2202，贷正）：期初 + 已过账采购发生 − 已过账付款
  function supplierBalance(code, period) {
    period = period || currentPeriod();
    var opening = 0;
    A().all().forEach(function (a) {
      if (String(a.code).indexOf('2202') !== 0) return;
      (a.openingAux || []).forEach(function (o) { if (o.supplier === code) opening += o.amount || 0; });
    });
    var vmap = voucherMap(), debit = 0, credit = 0, pre = 0, name = code;
    entriesOf('supplier', code).forEach(function (e) {
      if (String(e.accountCode).indexOf('2202') !== 0) return;
      var v = vmap[e.voucherId];
      if (!v || v.status !== '已过账') return;
      if (v.period < period) pre += (e.credit || 0) - (e.debit || 0);
      else if (v.period === period) { debit += e.debit || 0; credit += e.credit || 0; }
    });
    (S().get('suppliers') || []).some(function (p) { if (p.id === code) { name = p.name; return true; } return false; });
    var open = opening + pre;
    return { code: code, name: name, opening: open, debit: debit, credit: credit, closing: open + credit - debit };
  }

  /* ---------- 账龄分析（FIFO：先发生的先被结算，剩余挂账按原始凭证日期计账龄） ---------- */

  var AGE_LABELS = ['0–30 天', '31–60 天', '61–90 天', '90 天以上'];

  function ageIndex(days) {
    if (days <= 30) return 0;
    if (days <= 60) return 1;
    if (days <= 90) return 2;
    return 3;
  }

  function aging(kind, period) {
    period = period || currentPeriod();
    var isRecv = kind !== 'payable';
    var end = periodEndDate(period);
    var openingDate = (S().get('company') || {}).openingDate || period + '-01';
    var list = isRecv ? customers() : suppliers();
    var vmap = voucherMap();
    var buckets = AGE_LABELS.map(function (l) { return { label: l, amount: 0, pct: 0 }; });

    list.forEach(function (p) {
      // 期初挂账：按期初建账日期计账龄
      var opening = 0;
      A().all().forEach(function (a) {
        var pref = isRecv ? '1122' : '2202';
        if (String(a.code).indexOf(pref) !== 0) return;
        (a.openingAux || []).forEach(function (o) {
          if (o[isRecv ? 'customer' : 'supplier'] === p.id) opening += o.amount || 0;
        });
      });
      var items = [];
      if (opening > 0) items.push({ date: openingDate, amount: opening });

      // 已过账分录按凭证日期先后结算 FIFO
      var moves = [];
      entriesOf(isRecv ? 'customer' : 'supplier', p.id).forEach(function (e) {
        var pref = isRecv ? '1122' : '2202';
        if (String(e.accountCode).indexOf(pref) !== 0) return;
        var v = vmap[e.voucherId];
        if (!v || v.status !== '已过账' || v.period > period) return;
        var delta = isRecv ? (e.debit || 0) - (e.credit || 0) : (e.credit || 0) - (e.debit || 0);
        if (delta !== 0) moves.push({ date: v.date, delta: delta });
      });
      moves.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
      moves.forEach(function (mv) {
        if (mv.delta > 0) { items.push({ date: mv.date, amount: mv.delta }); return; }
        var rem = -mv.delta; // 结算：从最早挂账开始核销
        while (rem > 0 && items.length) {
          var take = Math.min(rem, items[0].amount);
          items[0].amount -= take;
          rem -= take;
          if (items[0].amount <= 0) items.shift();
        }
        /* 队列空后仍有剩余：超额收款/付款，不参与账龄 */
      });

      items.forEach(function (it) {
        if (it.amount <= 0) return;
        var age = Math.max(0, daysBetween(it.date, end));
        buckets[ageIndex(age)].amount += it.amount;
      });
    });

    var total = buckets.reduce(function (s, b) { return s + b.amount; }, 0);
    buckets.forEach(function (b) {
      b.pct = total > 0 ? Math.round(b.amount / total * 10000) / 100 : 0;
    });
    return { kind: isRecv ? 'receivable' : 'payable', period: period, buckets: buckets, total: total };
  }

  /* ---------- 往来明细（逐行滚动 + 账龄天数，只含已过账） ---------- */

  function partyLedger(kind, code, period) {
    period = period || currentPeriod();
    var isRecv = kind !== 'supplier' && kind !== 'payable'; // kind: customer/receivable 或 supplier/payable
    var end = periodEndDate(period);
    var openingDate = (S().get('company') || {}).openingDate || period + '-01';
    var vmap = voucherMap();
    var bal = isRecv ? customerBalance(code, period) : supplierBalance(code, period);
    var rows = [];
    if (bal.opening !== 0 || bal.debit !== 0 || bal.credit !== 0) {
      rows.push({
        code: code, name: bal.name, voucherId: '', date: openingDate, summary: '期初余额',
        debit: isRecv ? bal.opening : 0, credit: isRecv ? 0 : bal.opening,
        balance: bal.opening, ageDays: Math.max(0, daysBetween(openingDate, end))
      });
    }
    var run = bal.opening;
    var moves = [];
    entriesOf(isRecv ? 'customer' : 'supplier', code).forEach(function (e) {
      var pref = isRecv ? '1122' : '2202';
      if (String(e.accountCode).indexOf(pref) !== 0) return;
      var v = vmap[e.voucherId];
      if (!v || v.status !== '已过账' || v.period !== period) return;
      moves.push({ date: v.date, vid: v.id, line: e.line || 0, e: e, v: v });
    });
    moves.sort(function (x, y) {
      if (x.date !== y.date) return x.date < y.date ? -1 : 1;
      if (x.vid !== y.vid) return x.vid < y.vid ? -1 : 1;
      return x.line - y.line;
    });
    moves.forEach(function (mv) {
      run += isRecv ? (mv.e.debit || 0) - (mv.e.credit || 0) : (mv.e.credit || 0) - (mv.e.debit || 0);
      rows.push({
        code: code, name: bal.name, voucherId: mv.vid, date: mv.date,
        summary: mv.e.summary || mv.v.summary || '',
        debit: mv.e.debit || 0, credit: mv.e.credit || 0, balance: run,
        ageDays: Math.max(0, daysBetween(mv.date, end))
      });
    });
    return { code: code, name: bal.name, period: period, opening: bal.opening, closing: run, rows: rows };
  }

  function listReceivables(period) {
    period = period || currentPeriod();
    var rows = [];
    customers().forEach(function (p) {
      rows = rows.concat(partyLedger('customer', p.id, period).rows);
    });
    rows.sort(function (x, y) {
      if (x.date !== y.date) return x.date < y.date ? -1 : 1;
      return x.code < y.code ? -1 : x.code > y.code ? 1 : 0;
    });
    return { period: period, kind: 'receivable', rows: rows };
  }

  function listPayables(period) {
    period = period || currentPeriod();
    var rows = [];
    suppliers().forEach(function (p) {
      rows = rows.concat(partyLedger('supplier', p.id, period).rows);
    });
    rows.sort(function (x, y) {
      if (x.date !== y.date) return x.date < y.date ? -1 : 1;
      return x.code < y.code ? -1 : x.code > y.code ? 1 : 0;
    });
    return { period: period, kind: 'payable', rows: rows };
  }

  /* ---------- 渲染 ---------- */

  var R = { kind: 'customer', code: '' };

  function renderARAP(el) {
    var esc = S().esc, fmt = S().fmt;
    var isRecv = R.kind === 'customer';
    if (R.code) return renderPartyDetail(el);

    var balFn = isRecv ? customerBalance : supplierBalance;
    var list = isRecv ? customers() : suppliers();
    var ag = aging(isRecv ? 'receivable' : 'payable');

    var html = '<div class="page-head"><h2>应收应付</h2><div class="page-actions">' +
      '<span class="muted">科目 ' + (isRecv ? '1122 应收账款' : '2202 应付账款') + ' · 只含已过账凭证</span></div></div>';
    html += '<div class="tabs">' +
      '<button class="tab' + (isRecv ? ' active' : '') + '" data-kind="customer">客户应收</button>' +
      '<button class="tab' + (!isRecv ? ' active' : '') + '" data-kind="supplier">供应商应付</button></div>';

    html += '<table class="grid"><thead><tr><th style="width:80px">编码</th><th>名称</th>' +
      '<th class="num" style="width:120px">信用额度</th><th class="center" style="width:60px">账期</th>' +
      '<th class="num" style="width:120px">期初余额</th><th class="num" style="width:120px">本期借方</th>' +
      '<th class="num" style="width:120px">本期贷方</th><th class="num" style="width:130px">期末余额</th></tr></thead><tbody>';
    list.forEach(function (p) {
      var b = balFn(p.id, currentPeriod());
      html += '<tr class="row-link" data-action="detail" data-code="' + esc(p.id) + '" title="点击查看往来明细">' +
        '<td class="mono">' + esc(p.id) + (p.auto ? ' <span class="muted">(自动)</span>' : '') + '</td>' +
        '<td>' + esc(p.name) + '</td><td class="num">' + (p.creditLimit ? fmt(p.creditLimit) : '—') + '</td>' +
        '<td class="center">' + p.creditDays + ' 天</td>' +
        '<td class="num">' + (b.opening ? fmt(b.opening) : '') + '</td>' +
        '<td class="num">' + (b.debit ? fmt(b.debit) : '') + '</td>' +
        '<td class="num">' + (b.credit ? fmt(b.credit) : '') + '</td>' +
        '<td class="num"><b>' + (b.closing ? fmt(b.closing) : '') + '</b></td></tr>';
    });
    html += '</tbody></table>';

    html += '<h3 class="sec-title">账龄分析（' + esc(ag.period) + ' 月末，FIFO 核销）</h3>';
    html += '<div style="max-width:720px">';
    ag.buckets.forEach(function (b) {
      html += '<div style="display:flex;align-items:center;margin:6px 0">' +
        '<span style="width:90px" class="muted">' + esc(b.label) + '</span>' +
        '<div style="flex:1;background:var(--muted,#eee);border-radius:4px;height:18px;margin:0 10px;overflow:hidden">' +
        '<div style="width:' + b.pct + '%;height:100%;background:var(--primary,#3b82f6)"></div></div>' +
        '<span class="num" style="width:130px;text-align:right">' + fmt(b.amount) + '</span>' +
        '<span class="muted" style="width:70px;text-align:right">' + b.pct + '%</span></div>';
    });
    html += '<div style="margin-top:6px" class="tot">挂账总额 <b class="num">' + fmt(ag.total) + '</b></div></div>';
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && (t.dataset.kind || t.dataset.action))) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      if (t.dataset.kind) { R.kind = t.dataset.kind; R.code = ''; renderARAP(el); return; }
      if (t.dataset.action === 'detail') { R.code = t.dataset.code; renderARAP(el); }
    };
  }

  function renderPartyDetail(el) {
    var esc = S().esc, fmt = S().fmt;
    var led = partyLedger(R.kind, R.code);
    if (!led) { el.innerHTML = '<div class="notice bad">往来单位不存在</div>'; return; }
    var html = '<div class="page-head"><h2>往来明细 · ' + esc(led.name) + '</h2><div class="page-actions">' +
      '<button class="btn" data-action="back">← 返回往来余额表</button></div></div>';
    html += '<div class="muted" style="margin:8px 0">期间 ' + esc(led.period) + ' · ' +
      (R.kind === 'customer' ? '应收（借正）' : '应付（贷正）') + ' · 期初 ' + fmt(led.opening) +
      ' · 期末 ' + fmt(led.closing) + '</div>';
    html += '<table class="grid"><thead><tr><th style="width:100px">日期</th><th style="width:140px">凭证号</th><th>摘要</th>' +
      '<th class="num" style="width:120px">借方</th><th class="num" style="width:120px">贷方</th>' +
      '<th class="num" style="width:130px">余额</th><th class="center" style="width:70px">账龄(天)</th></tr></thead><tbody>';
    led.rows.forEach(function (r) {
      html += '<tr><td>' + esc(r.date) + '</td><td class="mono">' + esc(r.voucherId || '—') + '</td>' +
        '<td>' + esc(r.summary) + '</td>' +
        '<td class="num">' + (r.debit ? fmt(r.debit) : '') + '</td>' +
        '<td class="num">' + (r.credit ? fmt(r.credit) : '') + '</td>' +
        '<td class="num">' + fmt(r.balance) + '</td><td class="center">' + r.ageDays + '</td></tr>';
    });
    if (!led.rows.length) html += '<tr><td colspan="7" class="center muted">无往来发生额</td></tr>';
    html += '</tbody></table>';
    el.innerHTML = html;
    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (t && t.dataset && t.dataset.action === 'back') { R.code = ''; renderARAP(el); }
    };
  }

  root.FMARAP = {
    customers: customers, suppliers: suppliers,
    customerBalance: customerBalance, supplierBalance: supplierBalance,
    aging: aging, listReceivables: listReceivables, listPayables: listPayables,
    partyLedger: partyLedger, renderARAP: renderARAP
  };
})(typeof window !== 'undefined' ? window : globalThis);
