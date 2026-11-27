/* 财务管理系统 · 预算管理（chunk 8）
 * window.FMBudget = { setBudget, getBudget, listBudgets, actualVsBudget, renderBudget }
 * - 预算存 state.budgets：{dept, accountCode, year, monthly:[12 个整数分]}。
 *   键 = 部门 + 末级费用科目 + 年度；dept 空串 = 不分部门（全部部门合计口径）。
 * - 科目限定 4101 制造费用 / 5201 销售费用 / 5301 管理费用 族的末级科目。
 * - actualVsBudget(period, dept, accountCode)：实际数 = 该科目当期已过账借方发生额
 *   （FMAccounts.activity，postedOnly；dept 非空时按 aux.dept 过滤），与当月预算（monthly[月-1]）比较，
 *   返回 {budget, actual, diff, over}；over = actual > budget（超支，页面标红）。
 * - 金额一律整数分；显示用 S().fmt()。
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }
  function A() { return root.FMAccounts; }

  // 允许做预算的费用科目族（一级前缀）
  var FAMILIES = ['4101', '5201', '5301'];

  function currentPeriod() {
    var p = S().get('periods');
    return (p && p.current) || '';
  }

  function budgets() { return S().get('budgets') || []; }

  function fail(reason) { return { ok: false, reason: reason }; }

  // 末级费用科目校验：必须是叶子且属于 4101/5201/5301 族
  function validAccount(code) {
    var a = A().get(code);
    if (!a) return '科目“' + code + '”不存在';
    if (!A().isLeaf(code)) return '科目“' + code + '”不是末级科目';
    var ok = FAMILIES.some(function (f) { return String(code).indexOf(f) === 0; });
    if (!ok) return '预算科目只能是制造费用（4101）/ 销售费用（5201）/ 管理费用（5301）族';
    return null;
  }

  // 月份金额归一：数组 12 项（分/元字符串均可）或单项（12 个月同值）
  function normalizeMonthly(m) {
    var arr = Array.isArray(m) ? m : (m !== undefined && m !== null ? [m] : []);
    var out = [];
    for (var i = 0; i < 12; i++) {
      var v = arr[i] !== undefined ? arr[i] : (Array.isArray(m) ? 0 : m);
      var c = typeof v === 'number' ? (isFinite(v) && Math.round(v) === v ? v : null) : S().toCents(v);
      if (c === null || c < 0) return null;
      out.push(c);
    }
    return out;
  }

  // setBudget({dept, accountCode, year, monthly})：同键覆盖更新
  function setBudget(opts) {
    opts = opts || {};
    var dept = String(opts.dept || '').trim();
    var code = String(opts.accountCode || '').trim();
    var accErr = validAccount(code);
    if (accErr) return fail(accErr);
    var year = parseInt(opts.year, 10);
    if (!year || year < 2000 || year > 2100) return fail('预算年度不正确，应为 2026 这样的四位年份');
    var monthly = normalizeMonthly(opts.monthly);
    if (!monthly) return fail('月预算金额格式不正确（应为 ≥ 0 的金额，最多两位小数）');
    var arr = budgets();
    var hit = null;
    arr.forEach(function (b) {
      if (b.dept === dept && b.accountCode === code && b.year === year) hit = b;
    });
    if (hit) {
      hit.monthly = monthly;
    } else {
      arr.push({ dept: dept, accountCode: code, year: year, monthly: monthly });
    }
    S().set('budgets', arr);
    var total = monthly.reduce(function (s, c) { return s + c; }, 0);
    S().log('设置预算', code + (dept ? '@' + dept : '') + '/' + year, '月度 ' + S().fmt(monthly[0]) + '，年度 ' + S().fmt(total));
    return { ok: true, record: hit || arr[arr.length - 1] };
  }

  function getBudget(dept, accountCode, year) {
    var hit = null;
    budgets().forEach(function (b) {
      if (b.dept === (dept || '') && b.accountCode === accountCode && b.year === year) hit = b;
    });
    return hit;
  }

  function listBudgets(year) {
    return budgets().filter(function (b) { return !year || b.year === year; })
      .sort(function (x, y) {
        if (x.accountCode !== y.accountCode) return x.accountCode < y.accountCode ? -1 : 1;
        return (x.dept || '') < (y.dept || '') ? -1 : 1;
      });
  }

  // 实际 vs 预算：实际 = 当期已过账借方发生额（dept 非空按辅助部门过滤）
  function actualVsBudget(period, dept, accountCode) {
    period = period || currentPeriod();
    var b = getBudget(dept || '', accountCode, Number(String(period).slice(0, 4)));
    var month = Math.max(1, Math.min(12, Number(String(period).slice(5, 7)) || 1));
    var budget = b ? b.monthly[month - 1] : 0;
    var opts = { postedOnly: true, periodOnly: true };
    if (dept) opts.aux = { dept: dept };
    var act = A().activity(accountCode, period, opts);
    var actual = act.debit - act.credit; // 费用借方净额（红字冲销为负时冲减）
    return {
      period: period, dept: dept || '', accountCode: accountCode,
      hasBudget: !!b, budget: budget, actual: actual,
      diff: budget - actual, over: actual > budget
    };
  }

  /* ---------- 渲染 ---------- */

  var B = { year: 0 };

  function renderBudget(el) {
    var esc = S().esc, fmt = S().fmt;
    var period = currentPeriod();
    if (!B.year) B.year = Number(period.slice(0, 4)) || 2026;

    var rows = listBudgets(B.year);
    var html = '<div class="page-head"><h2>预算管理</h2><div class="page-actions">' +
      '<span class="muted">部门 + 末级费用科目（4101/5201/5301 族）+ 年度 · 实际数 = 已过账借方发生额</span></div></div>';
    html += '<div class="filter-bar">年度 <input id="fm-bud-year" class="input" style="width:90px" value="' + B.year + '">' +
      '　<button class="btn" data-action="filter">查询</button></div>';

    html += '<table class="grid"><thead><tr><th style="width:110px">部门</th><th style="width:110px">科目</th><th>名称</th>' +
      '<th class="num" style="width:130px">年度预算</th><th class="num" style="width:130px">当期（' + esc(period) + '）预算</th>' +
      '<th class="num" style="width:130px">当期实际</th><th class="num" style="width:130px">差额</th>' +
      '<th class="center" style="width:80px">状态</th></tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="8" class="center muted">' + B.year + ' 年暂无预算</td></tr>';
    rows.forEach(function (b) {
      var vb = actualVsBudget(period, b.dept, b.accountCode);
      var annual = b.monthly.reduce(function (s, c) { return s + c; }, 0);
      var acc = A().get(b.accountCode) || { name: b.accountCode };
      html += '<tr><td>' + esc(deptName(b.dept) || '（全部部门）') + '</td><td class="mono">' + esc(b.accountCode) + '</td>' +
        '<td>' + esc(acc.name) + '</td><td class="num">' + fmt(annual) + '</td>' +
        '<td class="num">' + (vb.hasBudget ? fmt(vb.budget) : '<span class="muted">未设</span>') + '</td>' +
        '<td class="num' + (vb.over ? ' bad-text' : '') + '">' + fmt(vb.actual) + '</td>' +
        '<td class="num">' + (vb.hasBudget ? fmt(vb.diff) : '') + '</td>' +
        '<td class="center">' + (vb.over ? '<b class="bad-text">超支</b>' : (vb.hasBudget ? '<span class="ok-text">正常</span>' : '—')) + '</td></tr>';
    });
    html += '</tbody></table>';

    /* 新增 / 修改预算表单：一次设置 12 个月同值 */
    var depts = (S().get('departments') || []);
    var accOptions = [];
    A().leaves().forEach(function (a) {
      if (FAMILIES.some(function (f) { return String(a.code).indexOf(f) === 0; })) accOptions.push(a);
    });
    html += '<h3 class="sec-title">设置预算（12 个月同值，可逐月改后另行调整）</h3><table class="form-table">' +
      '<tr><th>部门</th><td><select id="fm-bud-dept" class="input" style="width:180px"><option value="">（全部部门）</option>' +
      depts.map(function (d) { return '<option value="' + d.id + '">' + esc(d.name) + '</option>'; }).join('') + '</select></td>' +
      '<th>费用科目</th><td><select id="fm-bud-acc" class="input" style="width:240px">' +
      accOptions.map(function (a) { return '<option value="' + a.code + '">' + a.code + ' ' + esc(a.name) + '</option>'; }).join('') + '</select></td></tr>' +
      '<tr><th>年度</th><td><input id="fm-bud-yr" class="input" style="width:90px" value="' + B.year + '"></td>' +
      '<th>月预算（元）</th><td><input id="fm-bud-amt" class="input num" style="width:120px" placeholder="30000.00"> ' +
      '<button class="btn btn-primary" data-action="save">保存预算</button></td></tr></table>';
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      var act = t.dataset.action;
      if (act === 'filter') {
        var y = document.getElementById('fm-bud-year');
        B.year = parseInt(y ? y.value : '', 10) || Number(period.slice(0, 4));
        renderBudget(el);
      } else if (act === 'save') {
        var dept = val('fm-bud-dept'), acc = val('fm-bud-acc'), yr = val('fm-bud-yr'), amt = val('fm-bud-amt');
        var res = setBudget({ dept: dept, accountCode: acc, year: parseInt(yr, 10), monthly: amt });
        if (root.FMToast) root.FMToast(res.ok ? '预算已保存：' + acc : res.reason, res.ok ? 'ok' : 'bad');
        if (res.ok) renderBudget(el);
      }
    };
  }

  function val(id) {
    var n = document.getElementById(id);
    return n ? n.value.trim() : '';
  }

  function deptName(id) {
    if (!id) return '';
    var d = (S().get('departments') || []);
    for (var i = 0; i < d.length; i++) if (d[i].id === id) return d[i].name;
    return id;
  }

  root.FMBudget = {
    setBudget: setBudget, getBudget: getBudget, listBudgets: listBudgets,
    actualVsBudget: actualVsBudget, renderBudget: renderBudget
  };
})(typeof window !== 'undefined' ? window : globalThis);
