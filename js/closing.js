/* 财务管理系统 · 月结 / 反结账 / 结转损益（chunk 2）
 * window.FMClosing = { canClose, close, unclose, closeChecklist, carryForward, isClosed, renderClosing }
 * - 结账状态存 state.closedPeriods（已结账期间列表）；此后该期间凭证不可新增/过账/反过账/红字冲销
 *   （校验在 js/voucher.js 里读 closedPeriods）。
 * - 结账前自动结转损益：全部损益类末级科目本期（已过账）余额结转到 3103 本年利润，
 *   生成“结转本期损益”凭证（已审核、已过账）。
 * - 反结账只能反最近一个已结账期间，原因必填，写入审计日志。
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }
  function A() { return root.FMAccounts; }
  function V() { return root.FMVoucher; }
  function fail(reason) { return { ok: false, reason: reason }; }

  function currentPeriod() {
    var p = S().get('periods');
    return (p && p.current) || '';
  }

  function isClosed(period) {
    return ((S().get('closedPeriods') || []).indexOf(period) >= 0);
  }

  function closedPeriods() {
    return (S().get('closedPeriods') || []).slice().sort();
  }

  function inPeriods(period) {
    return ((S().get('periods') || { list: [] }).list || []).some(function (x) { return x.period === period; });
  }

  function operator() {
    return (S().get('company') || {}).operator || '';
  }

  /* ---------- 结账前检查清单 ---------- */
  // 返回 4 项 {ok, label, detail}：试算平衡 / 全部已过账 / 无未处理红字冲销 / 损益已结转
  function closeChecklist(period) {
    period = period || currentPeriod();
    var tb = V().trialBalance(period);
    var items = [];

    items.push({
      ok: tb.balanced,
      label: '本期试算平衡',
      detail: tb.balanced
        ? '借方合计 ' + S().fmt(tb.debit) + ' = 贷方合计 ' + S().fmt(tb.credit)
        : '借方合计 ' + S().fmt(tb.debit) + ' ≠ 贷方合计 ' + S().fmt(tb.credit) + '，差额 ' + S().fmt(Math.abs(tb.diff))
    });

    var vs = (S().get('vouchers') || []).filter(function (v) { return v.period === period; });
    var unaudited = vs.filter(function (v) { return v.status === '未审核'; }).length;
    var unauditedPosted = vs.filter(function (v) { return v.status === '已审核'; }).length;
    items.push({
      ok: unaudited === 0 && unauditedPosted === 0,
      label: '本期凭证全部已过账',
      detail: vs.length === 0 ? '本期无凭证'
        : (unaudited === 0 && unauditedPosted === 0 ? '全部 ' + vs.length + ' 张已过账'
          : '未审核 ' + unaudited + ' 张、已审核未过账 ' + unauditedPosted + ' 张')
    });

    var openRev = vs.filter(function (v) {
      return String(v.summary || '').indexOf('红字冲销') === 0 && v.status !== '已过账';
    });
    items.push({
      ok: openRev.length === 0,
      label: '本期无未处理的红字冲销',
      detail: openRev.length === 0 ? '无未过账的冲销凭证'
        : '有 ' + openRev.length + ' 张冲销凭证未过账（' + openRev.map(function (v) { return v.id; }).join('、') + '）'
    });

    var marker = '结转本期损益（' + period + '）';
    var carry = vs.filter(function (v) { return v.summary === marker; });
    var carried = carry.some(function (v) { return v.status === '已过账'; });
    items.push({
      ok: carried,
      label: '损益已结转',
      detail: carried ? '结转凭证已过账'
        : (carry.length ? '结转凭证未过账' : '损益未结转，结账时将自动结转')
    });
    return items;
  }

  /* ---------- 结转损益 ---------- */
  // 把全部损益类末级科目本期（已过账）余额结转到 3103 本年利润，返回结转金额（分）。
  function carryForward(period) {
    period = period || currentPeriod();
    if (!/^\d{4}-\d{2}$/.test(period)) return fail('会计期间格式不正确，应为 2026-11');
    if (isClosed(period)) return fail('会计期间 ' + period + ' 已结账，不能结转损益');
    if (period !== currentPeriod()) return fail('只能结转当前会计期间（' + currentPeriod() + '）的损益');
    var marker = '结转本期损益（' + period + '）';
    var exists = (S().get('vouchers') || []).some(function (v) { return v.summary === marker; });
    if (exists) return fail('本期损益已结转');

    var incomeRows = [], expenseRows = [], income = 0, expense = 0;
    A().leaves().forEach(function (a) {
      if (a.category !== '损益') return;
      var act = { debit: 0, credit: 0 };
      var vmap = {};
      (S().get('vouchers') || []).forEach(function (v) { vmap[v.id] = v; });
      (S().get('entries') || []).forEach(function (e) {
        if (String(e.accountCode).indexOf(a.code) !== 0) return;
        var v = vmap[e.voucherId];
        if (!v || v.period !== period || v.status !== '已过账') return;
        act.debit += e.debit || 0;
        act.credit += e.credit || 0;
      });
      // 方向折算后的本期净额：收入（贷向）= 贷 − 借；成本费用（借向）= 借 − 贷
      var amt = a.direction === '借' ? (act.debit - act.credit) : (act.credit - act.debit);
      if (amt <= 0) return;
      if (a.direction === '借') { expense += amt; expenseRows.push({ accountCode: a.code, summary: '', debit: 0, credit: amt }); }
      else { income += amt; incomeRows.push({ accountCode: a.code, summary: '', debit: amt, credit: 0 }); }
    });

    if (income === 0 && expense === 0) {
      return { ok: true, id: '', income: 0, expense: 0, amount: 0, voucher: null, detail: '本期损益为 0，无需结转' };
    }

    var rows = incomeRows.concat(expenseRows);
    var net = income - expense; // 正 = 净收益（贷 3103），负 = 净亏损（借 3103）
    rows.push({ accountCode: '3103', summary: '', debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0 });

    // 金额转成元字符串（create 内 cleanCents 把输入当元处理）
    var entries = rows.map(function (r) {
      return {
        accountCode: r.accountCode, summary: r.summary,
        debit: r.debit ? (r.debit / 100).toFixed(2) : 0,
        credit: r.credit ? (r.credit / 100).toFixed(2) : 0
      };
    });
    var lastDay = period + '-' + String(new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate()).padStart(2, '0');
    var res = V().create({ date: lastDay, summary: marker, maker: '系统结转', attachCount: 0, entries: entries });
    if (!res.ok) return fail('结转损益失败：' + res.reason);
    var auditor = operator() === '系统结转' ? '系统审核' : (operator() || '系统审核');
    var au = V().audit(res.id, auditor);
    if (!au.ok) return fail('结转损益失败：' + au.reason);
    var po = V().post(res.id);
    if (!po.ok) return fail('结转损益失败：' + po.reason);
    S().log('结转损益', res.id, marker + '，净额 ' + S().fmt(net));
    return { ok: true, id: res.id, income: income, expense: expense, amount: net, voucher: res.voucher };
  }

  /* ---------- 月结 / 反结账 ---------- */

  function canClose(period) {
    period = period || currentPeriod();
    if (!/^\d{4}-\d{2}$/.test(period)) return { ok: false, reason: '会计期间格式不正确，应为 2026-11' };
    if (!inPeriods(period)) return { ok: false, reason: '会计期间 ' + period + ' 不在会计期间列表中' };
    if (isClosed(period)) return { ok: false, reason: '会计期间 ' + period + ' 已结账，不能重复结账' };
    return { ok: true, period: period };
  }

  function close(period) {
    period = period || currentPeriod();
    var can = canClose(period);
    if (!can.ok) return can;
    var items = closeChecklist(period);
    var hard = items.slice(0, 3).filter(function (i) { return !i.ok; });
    if (hard.length) { // 先拦硬性检查（试算 / 过账 / 冲销），通过后才自动结转损益
      return fail('结账检查未通过：' + hard.map(function (i) { return i.label + '（' + i.detail + '）'; }).join('；'));
    }
    if (!items[3].ok) { // 损益未结转 → 自动结转
      var cf = carryForward(period);
      if (!cf.ok) return fail('结账失败：' + cf.reason);
      items = closeChecklist(period);
    }
    var bad = items.filter(function (i) { return !i.ok; });
    if (bad.length) {
      return fail('结账检查未通过：' + bad.map(function (i) { return i.label + '（' + i.detail + '）'; }).join('；'));
    }
    var cp = (S().get('closedPeriods') || []);
    cp.push(period);
    S().set('closedPeriods', cp);
    S().log('月结', period, '期间已结账并锁定');
    return { ok: true, period: period, checklist: items };
  }

  // 反结账：只能反最近一个已结账期间；原因必填，写审计日志。
  function unclose(period, reason) {
    var cp = closedPeriods();
    if (!reason || !String(reason).trim()) return fail('反结账原因不能为空，请填写原因');
    if (cp.indexOf(period) < 0) return fail('会计期间 ' + period + ' 未结账，无需反结账');
    var latest = cp[cp.length - 1];
    if (period !== latest) return fail('只能反结最近一个已结账期间（' + latest + '）');
    cp.pop();
    S().set('closedPeriods', cp);
    S().log('反结账', period, '原因：' + String(reason).trim());
    return { ok: true, period: period };
  }

  /* ---------- 渲染：结账页 ---------- */

  var C = { period: '' };

  function renderClosing(el) {
    var esc = S().esc, fmt = S().fmt;
    if (!C.period) C.period = currentPeriod();
    var list = ((S().get('periods') || { list: [] }).list || []).slice();
    closedPeriods().forEach(function (p) {
      if (!list.some(function (x) { return x.period === p; })) list.push({ period: p, closed: true });
    });
    var locked = isClosed(C.period);
    var items = closeChecklist(C.period);

    var html = '<div class="page-head"><h2>结账</h2><div class="page-actions">' +
      '<span class="muted">已结账期间：' + (closedPeriods().join('、') || '无') + '</span></div></div>';
    html += '<div class="filter-bar">期间 <select id="fm-close-period" class="input" style="width:120px">' +
      list.map(function (x) {
        return '<option value="' + x.period + '"' + (C.period === x.period ? ' selected' : '') + '>' + x.period + '</option>';
      }).join('') + '</select>' +
      '　<button class="btn" data-action="pick">查看</button></div>';

    html += '<div class="notice ' + (locked ? 'bad' : 'ok') + '">' +
      (locked ? '期间 ' + esc(C.period) + ' 已结账并锁定：该期间凭证不可新增、过账、反过账、红字冲销。'
        : '期间 ' + esc(C.period) + ' 未结账。') + '</div>';

    html += '<h3 class="sec-title">结账前检查清单</h3><table class="grid"><tbody>';
    items.forEach(function (i) {
      html += '<tr><td style="width:40px" class="center">' + (i.ok ? '✓' : '✗') + '</td>' +
        '<td style="width:200px">' + esc(i.label) + '</td>' +
        '<td class="' + (i.ok ? 'muted' : 'bad-text') + '">' + esc(i.detail) + '</td></tr>';
    });
    html += '</tbody></table>';

    html += '<div style="margin-top:12px">';
    if (locked) {
      html += '反结账原因（必填）<input id="fm-unclose-reason" class="input" style="width:260px" placeholder="例如：发现漏记凭证">' +
        '　<button class="btn btn-danger" data-action="unclose" data-id="' + esc(C.period) + '">反结账 ' + esc(C.period) + '</button>';
    } else {
      html += '<button class="btn btn-primary" data-action="close" data-id="' + esc(C.period) + '">结账 ' + esc(C.period) +
        '（未结转损益将自动结转）</button>';
    }
    html += '</div>';
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      var act = t.dataset.action;
      if (act === 'pick') {
        var sel = document.getElementById('fm-close-period');
        C.period = sel ? sel.value : C.period;
        renderClosing(el);
      } else if (act === 'close') {
        var r1 = close(t.dataset.id);
        root.FMToast(r1.ok ? '已结账：' + r1.period : r1.reason, r1.ok ? 'ok' : 'bad');
        if (r1.ok) renderClosing(el);
      } else if (act === 'unclose') {
        var input = document.getElementById('fm-unclose-reason');
        var r2 = unclose(t.dataset.id, input ? input.value : '');
        root.FMToast(r2.ok ? '已反结账：' + r2.period : r2.reason, r2.ok ? 'ok' : 'bad');
        if (r2.ok) renderClosing(el);
      }
    };
  }

  root.FMClosing = {
    canClose: canClose, close: close, unclose: unclose, closeChecklist: closeChecklist,
    carryForward: carryForward, isClosed: isClosed, renderClosing: renderClosing
  };
})(typeof window !== 'undefined' ? window : globalThis);
