/* 财务管理系统 · 出纳 / 银行（chunk 3）
 * window.FMCashier = { accounts, balance, journal, reconcile, importBank, renderCashier }
 * 口径约定：
 * - 账户 = 1001 库存现金 + 100201 / 100202 银行存款下级科目；余额一律调 FMLedger.accountBalance
 *   （已过账口径），不自己重算；金额整数分。
 * - 银行对账：日记账分录与银行流水按“金额相等且日期相差 ≤ 3 天”自动勾对（双方各用一次），
 *   未勾对的日记账行 = 企业已记银行未记，未勾对的流水 = 银行已记企业未记（未达账项 / 在途）。
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }
  function A() { return root.FMAccounts; }

  /* 种子流水：bankStatements 可能是对象（正常）、数组或缺（chunk 2 旧数据），防御式取 0 行 */
  function seedStatements(code) {
    var bs = S().get('bankStatements');
    return (bs && !Array.isArray(bs) && bs[code]) ? bs[code] : [];
  }

  function currentPeriod() {
    var p = S().get('periods');
    return (p && p.current) || '';
  }

  function daysBetween(a, b) {
    function u(s) { return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))); }
    return Math.round((u(b) - u(a)) / 86400000);
  }

  var BANK_META = {
    '1001': { bank: '—', acctNo: '' },
    '100201': { bank: '工商银行', acctNo: '1109202633456781' },
    '100202': { bank: '建设银行', acctNo: '3105889022160043' }
  };

  /* ---------- 账户档案 ---------- */

  function accounts() {
    return ['1001', '100201', '100202'].map(function (code) {
      var a = A().get(code) || { name: code, opening: 0 };
      var m = BANK_META[code] || { bank: '', acctNo: '' };
      return {
        code: code, name: a.name, bank: m.bank, acctNo: m.acctNo,
        masked: m.acctNo ? '**** **** ' + m.acctNo.slice(-4) : '现金',
        opening: a.opening || 0
      };
    });
  }

  /* 余额：期初 + 已过账借方 − 已过账贷方（调 FMLedger.accountBalance，不自己重算） */
  function balance(code, period) {
    var b = root.FMLedger && root.FMLedger.accountBalance(code, period);
    return b ? b.closing : 0;
  }

  /* ---------- 日记账 ---------- */

  // 某账户某期间按日期排序的已过账分录行，含对方科目，余额逐行滚动
  function journal(code, period) {
    period = period || currentPeriod();
    var a = A().get(code);
    if (!a) return null;
    var vmap = {};
    (S().get('vouchers') || []).forEach(function (v) { vmap[v.id] = v; });
    var all = S().get('entries') || [];
    var list = [];
    all.forEach(function (e) {
      if (String(e.accountCode).indexOf(code) !== 0) return;
      var v = vmap[e.voucherId];
      if (!v || v.period !== period || v.status !== '已过账') return;
      // 对方科目：同一凭证里本行以外的分录
      var counter = all.filter(function (s) {
        return s.voucherId === e.voucherId && s.id !== e.id && String(s.accountCode).indexOf(code) !== 0;
      }).map(function (s) {
        var acc = A().get(s.accountCode);
        return (acc ? acc.code + ' ' + acc.name : s.accountCode) + (s.credit ? '（贷）' : '（借）');
      }).join('、');
      list.push({
        date: v.date, voucherId: v.id, summary: e.summary || '',
        debit: e.debit || 0, credit: e.credit || 0, counter: counter, line: e.line || 0
      });
    });
    list.sort(function (x, y) {
      if (x.date !== y.date) return x.date < y.date ? -1 : 1;
      return x.line - y.line;
    });
    var opening = root.FMLedger.accountBalance(code, period).opening;
    var run = opening;
    list.forEach(function (r) {
      run += r.debit - r.credit;
      r.balance = run;
    });
    return { code: code, name: a.name, period: period, opening: opening, closing: run, rows: list };
  }

  /* ---------- 银行对账 ---------- */

  // bankStatement: [{date, amount(分，正=入账), summary}]
  function reconcile(code, period, bankStatement) {
    period = period || currentPeriod();
    var j = journal(code, period);
    var jrows = (j ? j.rows : []).filter(function (r) { return (r.debit - r.credit) !== 0; })
      .map(function (r) {
        return { date: r.date, voucherId: r.voucherId, summary: r.summary, amount: r.debit - r.credit };
      });
    var st = (bankStatement || []).map(function (s) {
      return { date: s.date, amount: s.amount, summary: s.summary || '' };
    });
    var used = st.map(function () { return false; });
    var matched = [], unmatchedJournal = [];
    jrows.forEach(function (jr) {
      var hit = -1;
      for (var i = 0; i < st.length; i++) {
        if (used[i]) continue;
        if (st[i].amount !== jr.amount) continue;           // 金额必须相等（差 1 分也不勾）
        if (Math.abs(daysBetween(st[i].date, jr.date)) > 3) continue; // 日期 ±3 天内
        hit = i;
        break;
      }
      if (hit >= 0) { used[hit] = true; matched.push({ journal: jr, statement: st[hit] }); }
      else unmatchedJournal.push(jr);
    });
    var unmatchedStatement = st.filter(function (s, i) { return !used[i]; });
    return {
      code: code, period: period,
      matched: matched, unmatchedJournal: unmatchedJournal, unmatchedStatement: unmatchedStatement,
      balance: balance(code, period)
    };
  }

  /* ---------- 银行流水 CSV 导入 ----------
   * 格式：日期,摘要,金额 三列（首行表头自动跳过且不计坏行）；
   * 金额可带千分位 / ￥ / 正负号；坏行跳过并计数，附中文原因。 */
  function splitCSVLine(line) {
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function validDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    var mo = Number(m[2]), d = Number(m[3]);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
  }

  function importBank(csvText) {
    var rows = [], skipped = 0, skipReasons = [];
    String(csvText || '').split(/\r?\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var cols = splitCSVLine(t).map(function (c) { return c.trim(); });
      if (cols.length < 3) { skipped++; skipReasons.push('第 ' + (skipped + rows.length) + ' 行：列数不足（需要 日期,摘要,金额 三列）'); return; }
      if (/日期/.test(cols[0]) && !/^\d{4}-/.test(cols[0])) return; // 表头
      if (!validDate(cols[0])) { skipped++; skipReasons.push('日期“' + cols[0] + '”格式不正确，应为 2026-11-03'); return; }
      var cents = S().toCents(cols[2]);
      if (cents === null) { skipped++; skipReasons.push('金额“' + cols[2] + '”格式不正确（最多两位小数，可带千分位与正负号）'); return; }
      rows.push({ date: cols[0], summary: cols[1], amount: cents });
    });
    return { ok: true, rows: rows, skipped: skipped, skipReasons: skipReasons };
  }

  /* ---------- 渲染 ---------- */

  var K = { code: '100201', period: '', imported: null };

  function renderCashier(el) {
    var esc = S().esc, fmt = S().fmt;
    if (!K.period) K.period = currentPeriod();
    var accs = accounts();
    var acc = accs.filter(function (a) { return a.code === K.code; })[0] || accs[0];
    var j = journal(K.code, K.period);

    var html = '<div class="page-head"><h2>出纳 / 银行</h2><div class="page-actions">' +
      '<span class="muted">只含已过账凭证 · 余额与总账口径一致</span></div></div>';
    html += '<div class="tabs">' + accs.map(function (a) {
      return '<button class="tab' + (a.code === K.code ? ' active' : '') + '" data-action="acc" data-code="' + a.code + '">' +
        a.name + '</button>';
    }).join('') + '</div>';

    html += '<div class="cards">';
    html += '<div class="card"><div class="card-label">' + esc(acc.name) + '（' + esc(acc.code) + ' · ' + esc(acc.masked) + '）</div>' +
      '<div class="card-num"><span class="num">' + fmt(balance(K.code, K.period)) + '</span></div>' +
      '<div class="card-extra">期初 ' + fmt(acc.opening) + ' · 期末日记账 ' + fmt(j ? j.closing : 0) + '</div></div>';
    html += '</div>';

    html += '<h3 class="sec-title">银行 / 现金日记账（' + esc(K.period) + '）</h3>';
    html += '<table class="grid"><thead><tr><th style="width:100px">日期</th><th style="width:140px">凭证号</th><th>摘要</th>' +
      '<th style="width:220px">对方科目</th><th class="num" style="width:110px">借方</th>' +
      '<th class="num" style="width:110px">贷方</th><th class="num" style="width:130px">余额</th></tr></thead><tbody>';
    if (j) {
      html += '<tr><td></td><td></td><td class="muted">期初余额</td><td></td><td></td><td></td>' +
        '<td class="num">' + fmt(j.opening) + '</td></tr>';
      j.rows.forEach(function (r) {
        html += '<tr><td>' + esc(r.date) + '</td><td class="mono">' + esc(r.voucherId) + '</td>' +
          '<td>' + esc(r.summary) + '</td><td class="muted">' + esc(r.counter) + '</td>' +
          '<td class="num">' + (r.debit ? fmt(r.debit) : '') + '</td>' +
          '<td class="num">' + (r.credit ? fmt(r.credit) : '') + '</td>' +
          '<td class="num">' + fmt(r.balance) + '</td></tr>';
      });
      if (!j.rows.length) html += '<tr><td colspan="7" class="center muted">本期间无已过账发生额</td></tr>';
    }
    html += '</tbody></table>';

    /* 银行对账 */
    var source = K.imported || seedStatements(K.code);
    var rec = reconcile(K.code, K.period, source);
    html += '<h3 class="sec-title">银行对账（' + esc(K.code) + ' · ' + esc(K.period) + '）</h3>';
    html += '<div class="filter-bar">粘贴银行流水 CSV（日期,摘要,金额）<br>' +
      '<textarea id="fm-bank-csv" class="input" rows="3" style="width:520px;font-family:var(--font-mono,monospace)" ' +
      'placeholder="2026-11-25,银行手续费,-300.00"></textarea><br>' +
      '<button class="btn" data-action="import">导入 CSV 并对账</button>' +
      '　<button class="btn" data-action="seed-recon">用种子流水对账</button>' +
      '　<span class="muted">当前对账数据：' + (K.imported ? '导入的 ' + K.imported.length + ' 行' : '种子流水 ' + source.length + ' 行') + '</span></div>';
    html += '<div class="notice ' + (rec.unmatchedJournal.length || rec.unmatchedStatement.length ? 'bad' : 'ok') + '">' +
      '勾对 ' + rec.matched.length + ' 笔 · 企业已记银行未记 ' + rec.unmatchedJournal.length + ' 笔 · ' +
      '未达账项（银行已记企业未记）' + rec.unmatchedStatement.length + ' 笔 · 账面余额 ' + fmt(rec.balance) + '</div>';
    html += '<div class="cards" style="max-width:900px">';
    function stmtTable(title, list) {
      var h = '<div><div class="muted" style="margin:4px 0">' + title + '（' + list.length + ' 笔）</div>' +
        '<table class="grid"><thead><tr><th style="width:100px">日期</th><th>摘要</th>' +
        '<th class="num" style="width:120px">金额</th></tr></thead><tbody>';
      list.forEach(function (s) {
        h += '<tr><td>' + esc(s.date) + '</td><td>' + esc(s.summary) + '</td>' +
          '<td class="num">' + fmt(s.amount) + '</td></tr>';
      });
      if (!list.length) h += '<tr><td colspan="3" class="center muted">无</td></tr>';
      return h + '</tbody></table></div>';
    }
    html += stmtTable('未达账项（银行已记，企业未记 → 需补记或属在途）', rec.unmatchedStatement);
    html += stmtTable('企业已记，银行未记（在途）', rec.unmatchedJournal);
    html += '</div>';
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      var act = t.dataset.action;
      if (act === 'acc') { K.code = t.dataset.code; K.imported = null; renderCashier(el); return; }
      if (act === 'seed-recon') {
        K.imported = null;
        root.FMToast('已载入种子流水 ' + seedStatements(K.code).length + ' 行', 'ok');
        renderCashier(el);
        return;
      }
      if (act === 'import') {
        var ta = document.getElementById('fm-bank-csv');
        var res = importBank(ta ? ta.value : '');
        if (!res.rows.length) { root.FMToast(res.skipped ? '没有可导入的有效行，' + res.skipped + ' 行已跳过' : '没有可导入的行', 'bad'); return; }
        K.imported = res.rows;
        root.FMToast('已导入 ' + res.rows.length + ' 行' + (res.skipped ? '，跳过 ' + res.skipped + ' 行坏行' : ''), res.skipped ? 'bad' : 'ok');
        renderCashier(el);
      }
    };
  }

  root.FMCashier = { accounts: accounts, balance: balance, journal: journal, reconcile: reconcile, importBank: importBank, renderCashier: renderCashier };
})(typeof window !== 'undefined' ? window : globalThis);
