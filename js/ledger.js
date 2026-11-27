/* 财务管理系统 · 总账 / 明细账 / 余额表（chunk 2）
 * window.FMLedger = { trialBalance, accountBalance, generalLedger, detailLedger, balanceSheet, exportCSV,
 *                     renderLedger, renderTrialBalance }
 * 口径：期初 = 科目期初余额 + 期初之前已过账凭证净额；本期发生与期末只汇总已过账凭证。
 * 金额一律整数分；opening / closing 按科目自身方向折算（借方科目借正、贷方科目贷正，
 * 负值表示余额在对方方向）。显示 / 导出时用 FMStore.fmt() 或元两位小数。
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }
  function A() { return root.FMAccounts; }
  function V() { return root.FMVoucher; }

  function currentPeriod() {
    var p = S().get('periods');
    return (p && p.current) || '';
  }

  function voucherMap() {
    var m = {};
    (S().get('vouchers') || []).forEach(function (v) { m[v.id] = v; });
    return m;
  }

  /* 期初净额（借正，含下级）：科目期初余额 + period 之前期间已过账凭证净额 */
  function openingRaw(code, period) {
    var net = 0;
    A().all().forEach(function (a) {
      if (String(a.code).indexOf(code) !== 0) return;
      net += a.direction === '借' ? (a.opening || 0) : -(a.opening || 0);
    });
    var vmap = voucherMap();
    (S().get('entries') || []).forEach(function (e) {
      if (String(e.accountCode).indexOf(code) !== 0) return;
      var v = vmap[e.voucherId];
      if (!v || v.period >= period || v.status !== '已过账') return;
      net += (e.debit || 0) - (e.credit || 0);
    });
    return net;
  }

  /* 本期已过账发生额（含下级） */
  function activityPosted(code, period) {
    var vmap = voucherMap(), debit = 0, credit = 0;
    (S().get('entries') || []).forEach(function (e) {
      if (String(e.accountCode).indexOf(code) !== 0) return;
      var v = vmap[e.voucherId];
      if (!v || v.period !== period || v.status !== '已过账') return;
      debit += e.debit || 0;
      credit += e.credit || 0;
    });
    return { debit: debit, credit: credit };
  }

  /* 某科目某期间：{opening, debit, credit, closing, direction,...}，opening/closing 按方向折算 */
  function accountBalance(code, period) {
    var a = A().get(code);
    if (!a) return null;
    period = period || currentPeriod();
    var open = openingRaw(code, period);
    var act = activityPosted(code, period);
    var close = open + act.debit - act.credit;
    var sign = a.direction === '借' ? 1 : -1;
    return {
      code: a.code, name: a.name, category: a.category, direction: a.direction, leaf: A().isLeaf(a.code),
      opening: open * sign, debit: act.debit, credit: act.credit, closing: close * sign
    };
  }

  /* 总账：全部末级科目一行一条，支持按大类筛选 */
  function generalLedger(period, category) {
    period = period || currentPeriod();
    var rows = A().leaves()
      .filter(function (a) { return !category || a.category === category; })
      .map(function (a) { return accountBalance(a.code, period); });
    return { period: period, category: category || '', rows: rows };
  }

  /* 值按方向折算 → [借方列, 贷方列] */
  function splitCols(v, direction) {
    if (v >= 0) return direction === '借' ? [v, 0] : [0, v];
    return direction === '借' ? [0, -v] : [-v, 0];
  }

  /* 科目余额表：与 generalLedger 同口径 + 合计行与平衡校验 */
  function balanceSheet(period) {
    period = period || currentPeriod();
    var rows = generalLedger(period).rows;
    var openD = 0, openC = 0, closeD = 0, closeC = 0;
    rows.forEach(function (r) {
      var o = splitCols(r.opening, r.direction), c = splitCols(r.closing, r.direction);
      openD += o[0]; openC += o[1]; closeD += c[0]; closeC += c[1];
    });
    var diff = closeD - closeC;
    return {
      period: period, rows: rows,
      opening: { debit: openD, credit: openC },
      closing: { debit: closeD, credit: closeC },
      diff: diff, balanced: diff === 0,
      reason: diff === 0 ? '' : '余额表不平：借方合计 ' + S().fmt(closeD) + ' ≠ 贷方合计 ' + S().fmt(closeC) +
        '，差额 ' + S().fmt(Math.abs(diff)) + '（借 − 贷），请检查期初余额与已过账凭证'
    };
  }

  /* 试算平衡：复用 FMVoucher.trialBalance，另加按科目大类的借贷合计 */
  function trialBalance(period) {
    period = period || currentPeriod();
    var base = V().trialBalance(period);
    var by = {};
    A().CATEGORIES.forEach(function (c) { by[c] = { category: c, debit: 0, credit: 0 }; });
    var vmap = voucherMap();
    (S().get('entries') || []).forEach(function (e) {
      var v = vmap[e.voucherId];
      if (!v || v.period !== period || v.status !== '已过账') return; // 与 V.trialBalance 同口径：只计已过账
      var a = A().get(e.accountCode);
      var c = (a && a.category) || '未知';
      if (!by[c]) by[c] = { category: c, debit: 0, credit: 0 };
      by[c].debit += e.debit || 0;
      by[c].credit += e.credit || 0;
    });
    var byCategory = A().CATEGORIES.map(function (c) { return by[c]; });
    return {
      period: period, voucherCount: base.voucherCount,
      debit: base.debit, credit: base.credit, diff: base.diff, balanced: base.balanced,
      byCategory: byCategory
    };
  }

  /* 明细账：某科目某期间已过账分录按日期排序，余额逐行滚动 */
  function detailLedger(code, period) {
    var a = A().get(code);
    if (!a) return null;
    period = period || currentPeriod();
    var sign = a.direction === '借' ? 1 : -1;
    var vmap = voucherMap(), list = [];
    (S().get('entries') || []).forEach(function (e) {
      if (String(e.accountCode).indexOf(code) !== 0) return;
      var v = vmap[e.voucherId];
      if (!v || v.period !== period || v.status !== '已过账') return;
      list.push({ date: v.date, voucherId: v.id, line: e.line || 0, e: e });
    });
    list.sort(function (x, y) {
      if (x.date !== y.date) return x.date < y.date ? -1 : 1;
      if (x.voucherId !== y.voucherId) return x.voucherId < y.voucherId ? -1 : 1;
      return x.line - y.line;
    });
    var raw = openingRaw(code, period), rows = [];
    list.forEach(function (it) {
      raw += (it.e.debit || 0) - (it.e.credit || 0);
      rows.push({
        date: it.date, voucherId: it.voucherId, summary: it.e.summary || '',
        debit: it.e.debit || 0, credit: it.e.credit || 0, balance: raw * sign
      });
    });
    return {
      code: a.code, name: A().fullName(a.code), period: period, direction: a.direction,
      opening: openingRaw(code, period) * sign, closing: raw * sign, rows: rows
    };
  }

  /* CSV 导出：UTF-8 BOM，\r\n 行，逗号/引号/换行转义。
   * 浏览器里用 Blob 触发下载；Node（无 Blob/URL.createObjectURL）退化为返回 CSV 字符串。 */
  function exportCSV(rows, filename) {
    var csv = '\uFEFF' + (rows || []).map(function (r) {
      return (r || []).map(function (cell) {
        var s = cell === null || cell === undefined ? '' : String(cell);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n') + '\r\n';
    var canDownload = typeof Blob === 'function' && typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function' && typeof document !== 'undefined' &&
      typeof document.createElement === 'function';
    if (canDownload) {
      try {
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename || 'export.csv';
        if (document.body) document.body.appendChild(a);
        a.click();
        if (a.parentNode) a.parentNode.removeChild(a);
      } catch (e) { /* 下载失败仍返回字符串 */ }
    }
    return csv;
  }

  // 分 → 元两位小数（CSV 用，不带千分位）
  function fmtYuan(cents) { return ((cents || 0) / 100).toFixed(2); }

  /* ---------- 渲染：总账 / 余额表（点科目进明细账） ---------- */

  var L = { period: '', category: '', mode: 'list', code: '' };

  function renderLedger(el) {
    var esc = S().esc, fmt = S().fmt;
    if (!L.period) L.period = currentPeriod();
    if (L.mode === 'detail') return renderDetail(el);

    var bs = balanceSheet(L.period);
    var rows = L.category ? bs.rows.filter(function (r) { return r.category === L.category; }) : bs.rows;
    var html = '<div class="page-head"><h2>总账 / 余额表</h2><div class="page-actions">' +
      '<button class="btn" data-action="trial">试算平衡表</button></div></div>';
    html += '<div class="filter-bar">期间 <input id="fm-ledger-period" class="input" style="width:100px" value="' + esc(L.period) + '">' +
      '　科目大类 <select id="fm-ledger-cat" class="input" style="width:120px"><option value="">全部</option>' +
      A().CATEGORIES.map(function (c) {
        return '<option value="' + c + '"' + (L.category === c ? ' selected' : '') + '>' + c + '</option>';
      }).join('') + '</select>' +
      '　<button class="btn" data-action="filter">查询</button>' +
      '　<button class="btn" data-action="export">导出 CSV</button></div>';
    html += '<div class="notice ' + (bs.balanced ? 'ok' : 'bad') + '">' +
      (bs.balanced ? '期末余额借贷平衡：借方合计 ' + fmt(bs.closing.debit) + ' = 贷方合计 ' + fmt(bs.closing.credit) +
        '　期初借方 ' + fmt(bs.opening.debit) + '　期初贷方 ' + fmt(bs.opening.credit)
        : esc(bs.reason)) + '</div>';
    html += '<table class="grid"><thead><tr><th style="width:100px">科目编码</th><th>科目名称</th>' +
      '<th class="center" style="width:50px">方向</th>' +
      '<th class="num" style="width:125px">期初借方</th><th class="num" style="width:125px">期初贷方</th>' +
      '<th class="num" style="width:125px">本期借方</th><th class="num" style="width:125px">本期贷方</th>' +
      '<th class="num" style="width:125px">期末借方</th><th class="num" style="width:125px">期末贷方</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var oc = splitCols(r.opening, r.direction), cc = splitCols(r.closing, r.direction);
      html += '<tr class="row-link" data-action="detail" data-code="' + esc(r.code) + '" title="点击查看明细账">' +
        '<td class="mono">' + esc(r.code) + '</td><td>' + esc(r.name) + '</td><td class="center">' + r.direction + '</td>' +
        '<td class="num">' + (oc[0] ? fmt(oc[0]) : '') + '</td><td class="num">' + (oc[1] ? fmt(oc[1]) : '') + '</td>' +
        '<td class="num">' + (r.debit ? fmt(r.debit) : '') + '</td><td class="num">' + (r.credit ? fmt(r.credit) : '') + '</td>' +
        '<td class="num">' + (cc[0] ? fmt(cc[0]) : '') + '</td><td class="num">' + (cc[1] ? fmt(cc[1]) : '') + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      var act = t.dataset.action;
      if (act === 'filter') {
        var p = document.getElementById('fm-ledger-period'), c = document.getElementById('fm-ledger-cat');
        L.period = p ? p.value.trim() || currentPeriod() : currentPeriod();
        L.category = c ? c.value : '';
        L.mode = 'list';
        renderLedger(el);
      } else if (act === 'export') {
        var out = [['科目编码', '科目名称', '方向', '期初借方', '期初贷方', '本期借方', '本期贷方', '期末借方', '期末贷方']];
        bs.rows.forEach(function (r) {
          var oc2 = splitCols(r.opening, r.direction), cc2 = splitCols(r.closing, r.direction);
          out.push([r.code, r.name, r.direction, fmtYuan(oc2[0]), fmtYuan(oc2[1]), fmtYuan(r.debit), fmtYuan(r.credit), fmtYuan(cc2[0]), fmtYuan(cc2[1])]);
        });
        out.push(['合计', '', '', fmtYuan(bs.opening.debit), fmtYuan(bs.opening.credit), '', '', fmtYuan(bs.closing.debit), fmtYuan(bs.closing.credit)]);
        exportCSV(out, '余额表-' + L.period + '.csv');
      } else if (act === 'trial') {
        location.hash = '#/trialbalance';
      } else if (act === 'detail') {
        L.mode = 'detail';
        L.code = t.dataset.code;
        renderLedger(el);
      }
    };
  }

  function renderDetail(el) {
    var esc = S().esc, fmt = S().fmt;
    var d = detailLedger(L.code, L.period);
    if (!d) { el.innerHTML = '<div class="notice bad">科目“' + esc(L.code) + '”不存在</div>'; return; }
    var html = '<div class="page-head"><h2>明细账 · ' + esc(d.name) + '</h2><div class="page-actions">' +
      '<button class="btn" data-action="back">← 返回余额表</button>' +
      '<button class="btn" data-action="export-detail">导出 CSV</button></div></div>';
    html += '<div class="muted" style="margin:8px 0">期间 ' + esc(d.period) + ' · 方向 ' + d.direction +
      ' · 期初余额 ' + fmt(d.opening) + '（' + (d.opening >= 0 ? d.direction : (d.direction === '借' ? '贷' : '借')) +
      '）· 只含已过账凭证</div>';
    html += '<table class="grid"><thead><tr><th style="width:100px">日期</th><th style="width:140px">凭证号</th><th>摘要</th>' +
      '<th class="num" style="width:120px">借方</th><th class="num" style="width:120px">贷方</th>' +
      '<th class="num" style="width:140px">余额</th></tr></thead><tbody>';
    html += '<tr><td></td><td></td><td class="muted">期初余额</td><td></td><td></td><td class="num">' + fmt(d.opening) + '</td></tr>';
    d.rows.forEach(function (r) {
      html += '<tr><td>' + esc(r.date) + '</td><td class="mono">' + esc(r.voucherId) + '</td><td>' + esc(r.summary) + '</td>' +
        '<td class="num">' + (r.debit ? fmt(r.debit) : '') + '</td><td class="num">' + (r.credit ? fmt(r.credit) : '') + '</td>' +
        '<td class="num">' + fmt(r.balance) + '</td></tr>';
    });
    if (!d.rows.length) html += '<tr><td colspan="6" class="center muted">本期间无已过账发生额</td></tr>';
    html += '</tbody></table>';
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      if (t.dataset.action === 'back') { L.mode = 'list'; renderLedger(el); return; }
      if (t.dataset.action === 'export-detail') {
        var out = [['日期', '凭证号', '摘要', '借方', '贷方', '余额']];
        out.push(['', '', '期初余额', '', '', fmtYuan(d.opening)]);
        d.rows.forEach(function (r) {
          out.push([r.date, r.voucherId, r.summary, fmtYuan(r.debit), fmtYuan(r.credit), fmtYuan(r.balance)]);
        });
        out.push(['', '', '期末余额', '', '', fmtYuan(d.closing)]);
        exportCSV(out, '明细账-' + d.code + '-' + d.period + '.csv');
      }
    };
  }

  /* ---------- 渲染：试算平衡表 ---------- */

  function renderTrialBalance(el) {
    var esc = S().esc, fmt = S().fmt;
    if (!L.period) L.period = currentPeriod();
    var tb = trialBalance(L.period);
    var html = '<div class="page-head"><h2>试算平衡表</h2><div class="page-actions">' +
      '<button class="btn" data-action="back">← 返回总账</button></div></div>';
    html += '<div class="filter-bar">期间 <input id="fm-tb-period" class="input" style="width:100px" value="' + esc(L.period) + '">' +
      '　<button class="btn" data-action="filter">查询</button></div>';
    html += '<div class="notice ' + (tb.balanced ? 'ok' : 'bad') + '">' +
      (tb.balanced ? '试算平衡：本期借方合计 ' + fmt(tb.debit) + ' = 贷方合计 ' + fmt(tb.credit) + '，差额 0.00'
        : '试算不平衡：借方合计 ' + fmt(tb.debit) + ' ≠ 贷方合计 ' + fmt(tb.credit) + '，差额 ' + fmt(tb.diff) + '（借 − 贷），请先检查凭证') + '</div>';
    html += '<table class="grid"><thead><tr><th style="width:120px">科目大类</th>' +
      '<th class="num" style="width:180px">借方合计</th><th class="num" style="width:180px">贷方合计</th></tr></thead><tbody>';
    tb.byCategory.forEach(function (c) {
      if (!c.debit && !c.credit) return;
      html += '<tr><td>' + esc(c.category) + '</td><td class="num">' + fmt(c.debit) + '</td><td class="num">' + fmt(c.credit) + '</td></tr>';
    });
    html += '<tr class="total-row"><td><b>合计（凭证 ' + tb.voucherCount + ' 张）</b></td>' +
      '<td class="num"><b>' + fmt(tb.debit) + '</b></td><td class="num"><b>' + fmt(tb.credit) + '</b></td></tr>';
    html += '</tbody></table>';
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      if (t.dataset.action === 'back') { location.hash = '#/ledger'; return; }
      if (t.dataset.action === 'filter') {
        var p = document.getElementById('fm-tb-period');
        L.period = p ? p.value.trim() || currentPeriod() : currentPeriod();
        renderTrialBalance(el);
      }
    };
  }

  root.FMLedger = {
    trialBalance: trialBalance, accountBalance: accountBalance, generalLedger: generalLedger,
    detailLedger: detailLedger, balanceSheet: balanceSheet, exportCSV: exportCSV,
    renderLedger: renderLedger, renderTrialBalance: renderTrialBalance
  };
})(typeof window !== 'undefined' ? window : globalThis);
