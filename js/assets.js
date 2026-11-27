/* 财务管理系统 · 固定资产（chunk 4）
 * window.FMAssets = { list, add, dispose, depreciation, monthlyDepreciation, runDepreciation,
 *                     netBookValue, renderAssets }
 * 约定（与账簿同口径）：
 * - 金额一律整数分；余额只认已过账凭证（V.trialBalance / A.balance / FMLedger 同口径）。
 * - 购入 / 计提折旧 / 处置凭证一律走 voucher.js 的 create → audit → post（制单人“系统购置 /
 *   系统折旧 / 系统处置”），不直接改凭证 state。
 * - 折旧费用科目（末级、带部门辅助核算）：生产/仓储作业部门 → 4101 制造费用；
 *   销售部门 → 520106 销售费用-折旧费；其他部门 → 530106 管理费用-折旧费。
 *   （注：科目表里 5101 是“税金及附加”，制造费用是 4101，故不按 5101 记折旧。）
 * - 三种折旧方法都保证提满不留尾差：直线法最后 1 个月提剩余；双倍余额递减最后 2 年改直线法、
 *   年数总和法最后 1 个月提剩余。
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }
  function A() { return root.FMAccounts; }
  function V() { return root.FMVoucher; }
  function T() { return root.FMTax; }
  function fail(reason) { return { ok: false, reason: reason }; }

  function currentPeriod() {
    var p = S().get('periods');
    return (p && p.current) || '';
  }

  function lastDay(period) {
    var d = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate();
    return period + '-' + ('0' + d).slice(-2);
  }

  function operator() {
    return (S().get('company') || {}).operator || '';
  }

  // fromYm 至 toYm 的含头含尾月数（'YYYY-MM'）；to < from 返回 0
  function monthsInclusive(fromYm, toYm) {
    var y1 = Number(fromYm.slice(0, 4)), m1 = Number(fromYm.slice(5, 7));
    var y2 = Number(toYm.slice(0, 4)), m2 = Number(toYm.slice(5, 7));
    return (y2 - y1) * 12 + (m2 - m1) + 1;
  }

  // 分 → 元字符串（create 里 cleanCents 把输入当元处理）
  function yuan(cents) { return (cents / 100).toFixed(2); }

  /* 类别 → 最低折旧年限（月），取自 taxrules.js 的折旧年限表 */
  var CATEGORIES = {};
  (function () {
    var d = T().depreciation;
    CATEGORIES['房屋建筑物'] = d.building * 12;   // 20 年
    CATEGORIES['机器设备'] = d.machinery * 12;    // 10 年
    CATEGORIES['运输工具'] = d.vehicle * 12;      // 4 年
    CATEGORIES['电子设备'] = d.electronic * 12;   // 3 年
    CATEGORIES['办公设备'] = d.electronic * 12;   // 参照电子设备最低 3 年
  })();

  var PROD_DEPTS = ['D06'];                 // 仓储物流 / 生产作业 → 制造费用
  var SALES_DEPTS = ['D08', 'D09', 'D10', 'D11']; // 销售部门 → 销售费用

  function expenseAccountFor(dept) {
    if (PROD_DEPTS.indexOf(dept) >= 0) return { code: '4101', name: '制造费用' };
    if (SALES_DEPTS.indexOf(dept) >= 0) return { code: '520106', name: '销售费用-折旧费' };
    return { code: '530106', name: '管理费用-折旧费' };
  }

  /* ---------- 卡片 ---------- */

  function list() { return S().get('assets') || []; }

  function getCard(code) {
    var hit = null;
    list().forEach(function (c) { if (c.code === code) hit = c; });
    return hit;
  }

  function nextCode() {
    var max = 0;
    list().forEach(function (c) {
      var n = parseInt(String(c.code).replace(/^ZC/, ''), 10);
      if (n > max) max = n;
    });
    return 'ZC' + ('000' + (max + 1)).slice(-3);
  }

  function netBookValue(code) {
    var c = getCard(code);
    return c ? (c.cost - c.accumulated) : null;
  }

  /* ---------- 折旧计划：任意方法都提满不留尾差 ---------- */

  function depSchedule(card) {
    var months = card.months, cost = card.cost;
    var residual = Math.round(cost * (card.residualRate === undefined ? 0.05 : card.residualRate));
    var base = cost - residual;
    var method = card.method || '直线法';
    var out = [], m, y, amt, acc = 0;

    if (method === '双倍余额递减法') {
      var years = Math.max(1, Math.round(months / 12));
      var rate = 2 / years;
      var lastMonthly = 0, yearAccStart = 0;
      for (m = 1; m <= months; m++) {
        y = Math.min(years, Math.ceil(m / 12));
        if (m === (y - 1) * 12 + 1) yearAccStart = acc; // 年初净值（全年 12 个月按同一净值）
        if (y > years - 2) { // 最后 2 年改直线法提完
          if (m === Math.max(1, (years - 2) * 12 + 1)) {
            lastMonthly = Math.floor(Math.max(0, cost - acc - residual) / (months - m + 1));
          }
          amt = lastMonthly;
        } else {
          amt = Math.floor((cost - yearAccStart) * rate / 12); // 年初净值 × 年折旧率 / 12
        }
        if (m === months) amt = base - acc; // 最后 1 个月提完剩余
        if (amt < 0) amt = 0;
        out.push(amt);
        acc += amt;
      }
    } else if (method === '年数总和法') {
      var years2 = Math.max(1, Math.round(months / 12));
      var sumY = years2 * (years2 + 1) / 2;
      for (m = 1; m <= months; m++) {
        y = Math.min(years2, Math.ceil(m / 12));
        var remain = years2 - y + 1;
        amt = Math.floor(base * remain / sumY / 12);
        if (m === months) amt = base - acc; // 最后 1 个月提完剩余
        if (amt < 0) amt = 0;
        out.push(amt);
        acc += amt;
      }
    } else { // 直线法
      var monthly = Math.floor(base / months);
      for (m = 1; m <= months; m++) {
        amt = (m === months) ? (base - monthly * (months - 1)) : monthly;
        out.push(amt);
      }
    }
    return out;
  }

  /* 某资产某期间应提折旧（分）；提满 / 已处置 / 期间早于购入 / 超年限返回 0 */
  function depreciation(code, period) {
    var card = getCard(code);
    if (!card || card.status === '已处置') return 0;
    period = period || currentPeriod();
    var m = monthsInclusive(String(card.purchaseDate).slice(0, 7), String(period).slice(0, 7));
    if (m <= 0 || m > card.months) return 0;
    var base = card.cost - Math.round(card.cost * (card.residualRate === undefined ? 0.05 : card.residualRate));
    if (card.accumulated >= base) return 0; // 已提满
    return depSchedule(card)[m - 1];
  }

  /* 全表当月折旧汇总：按部门分费用科目，返回凭证行（每张资产一行，摘要带资产编码） */
  function monthlyDepreciation(period) {
    period = period || currentPeriod();
    var byDept = {}, entries = [], total = 0;
    list().forEach(function (card) {
      if (card.status === '已处置') return;
      var amt = depreciation(card.code, period);
      if (amt <= 0) return;
      total += amt;
      byDept[card.dept] = (byDept[card.dept] || 0) + amt;
      var acc = expenseAccountFor(card.dept);
      entries.push({
        accountCode: acc.code, accountName: acc.name, dept: card.dept,
        debit: amt, credit: 0, summary: '折旧 ' + card.code + ' ' + card.name
      });
    });
    return {
      period: period, total: total,
      byDept: Object.keys(byDept).map(function (d) { return { dept: d, amount: byDept[d] }; }),
      entries: entries
    };
  }

  /* 生成并过账一张凭证（create → audit → post），失败返回 {ok:false, reason} */
  function postVoucher(date, summary, maker, rows) {
    var entries = rows.map(function (r) {
      return {
        accountCode: r.accountCode, summary: r.summary || summary,
        debit: r.debit ? yuan(r.debit) : 0, credit: r.credit ? yuan(r.credit) : 0,
        aux: r.aux || {}
      };
    });
    var res = V().create({ date: date, summary: summary, maker: maker, attachCount: 0, entries: entries });
    if (!res.ok) return fail(res.reason);
    var auditor = operator() === maker ? '系统审核' : (operator() || '系统审核');
    var au = V().audit(res.id, auditor);
    if (!au.ok) return fail(au.reason);
    var po = V().post(res.id);
    if (!po.ok) return fail(po.reason);
    return { ok: true, id: res.id, voucher: res.voucher };
  }

  /* ---------- 新增（自动生成购入凭证并过账；失败不入库） ---------- */

  function add(card) {
    card = card || {};
    var period = currentPeriod();
    var cost = card.cost;
    if (typeof cost !== 'number' || !isFinite(cost) || cost <= 0 || Math.round(cost) !== cost)
      return fail('原值必须是大于 0 的整数分');
    var months = card.months;
    if (typeof months !== 'number' || !isFinite(months) || Math.round(months) !== months || months < 1 || months > 600)
      return fail('预计使用年限必须为 1–600 月的整数');
    var rate = card.residualRate === undefined ? 0.05 : card.residualRate;
    if (typeof rate !== 'number' || !isFinite(rate) || rate < 0 || rate > 0.5)
      return fail('预计净残值率必须在 0–50% 之间');
    var minMonths = CATEGORIES[card.category];
    if (!minMonths) return fail('类别必须是 房屋建筑物/机器设备/运输工具/电子设备/办公设备 之一');
    if (months < minMonths)
      return fail('类别“' + card.category + '”最低折旧年限为 ' + (minMonths / 12) + ' 年（' + minMonths +
        ' 月），使用年限 ' + months + ' 月低于税法最低折旧年限，不能入账');
    var date = card.purchaseDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return fail('购入日期格式不正确，应为 2026-11-05');
    var end = lastDay(period);
    if (date > end) return fail('购入日期不能晚于当前期间末（' + end + '）');
    if (date.slice(0, 7) !== period)
      return fail('购入日期 ' + date + ' 不在当前会计期间（' + period + '）内，无法生成购入凭证（期前购入请录期初）');
    var pay = card.payMethod || 'bank';
    var creditAccount = pay === 'cash' ? '1001' : (pay === 'credit' ? '2202' : '100201');
    var aux = {};
    if (pay === 'credit') {
      if (!card.supplier) return fail('赊购必须指定供应商（辅助核算 supplier）');
      aux.supplier = card.supplier;
    }
    var res = postVoucher(date, '购入固定资产 ' + (card.name || ''), '系统购置', [
      { accountCode: '1601', summary: '购入 ' + (card.name || ''), debit: cost },
      { accountCode: creditAccount, summary: '购入 ' + (card.name || ''), credit: cost, aux: aux }
    ]);
    if (!res.ok) return fail('购入凭证生成失败：' + res.reason);
    var newCard = {
      code: nextCode(), name: card.name || '固定资产', category: card.category,
      purchaseDate: date, cost: cost, months: months, residualRate: rate,
      method: card.method || '直线法', dept: card.dept || '', location: card.location || '',
      status: '在用', accumulated: 0, monthsElapsed: 0, voucherId: res.id
    };
    var assets = list();
    assets.push(newCard);
    S().set('assets', assets);
    S().log('新增固定资产', newCard.code, (card.name || '') + '，原值 ' + S().fmt(cost) + '，凭证 ' + res.id);
    return { ok: true, card: newCard, voucherId: res.id };
  }

  /* ---------- 计提本月折旧 ---------- */

  function runDepreciation(period) {
    period = period || currentPeriod();
    if (!/^\d{4}-\d{2}$/.test(period)) return fail('会计期间格式不正确，应为 2026-11');
    if (period !== currentPeriod()) return fail('只能计提当前会计期间（' + currentPeriod() + '）的折旧');
    if (root.FMClosing && root.FMClosing.isClosed(period)) return fail('会计期间 ' + period + ' 已结账，不能计提折旧');
    var marker = '计提 ' + period + ' 折旧';
    if ((S().get('vouchers') || []).some(function (v) { return v.summary === marker; }))
      return fail('本期折旧已计提');
    var md = monthlyDepreciation(period);
    if (md.total <= 0) return { ok: true, id: '', total: 0, byDept: md.byDept, detail: '本月无应提折旧' };
    var rows = md.entries.map(function (e) {
      return { accountCode: e.accountCode, summary: e.summary, debit: e.debit, aux: { dept: e.dept } };
    });
    rows.push({ accountCode: '1602', summary: marker, credit: md.total });
    var res = postVoucher(lastDay(period), marker, '系统折旧', rows);
    if (!res.ok) return fail('计提折旧失败：' + res.reason);
    list().forEach(function (card) {
      if (card.status === '已处置') return;
      var amt = depreciation(card.code, period);
      if (amt > 0) { card.accumulated += amt; card.monthsElapsed += 1; }
    });
    S().set('assets', list());
    S().log('计提折旧', res.id, marker + '，合计 ' + S().fmt(md.total));
    return { ok: true, id: res.id, total: md.total, byDept: md.byDept, voucher: res.voucher };
  }

  /* ---------- 处置 ---------- */

  // 处置：净值 = 原值 − 累计折旧；处置价 > 净值 贷 6301 利得，< 净值 借 6301 损失。
  // 未提满当月折旧的先自动补提一张折旧凭证，再出处置凭证。
  function dispose(code, period, price) {
    var card = getCard(code);
    if (!card) return fail('资产“' + code + '”不存在');
    if (card.status === '已处置') return fail('资产已处置，不能重复处置');
    period = period || currentPeriod();
    if (period !== currentPeriod()) return fail('只能处置当前会计期间（' + currentPeriod() + '）的资产');
    if (root.FMClosing && root.FMClosing.isClosed(period)) return fail('会计期间 ' + period + ' 已结账，不能处置资产');
    if (typeof price !== 'number' || !isFinite(price) || price < 0 || Math.round(price) !== price)
      return fail('处置价必须是 ≥0 的整数分');

    var catchup = null;
    var m = monthsInclusive(String(card.purchaseDate).slice(0, 7), String(period).slice(0, 7));
    if (card.monthsElapsed < m && card.monthsElapsed < card.months) {
      var amt = depreciation(code, period);
      if (amt > 0) {
        var cu = postVoucher(lastDay(period), '补提 ' + period + ' 折旧（' + code + ' ' + card.name + '）', '系统折旧', [
          { accountCode: expenseAccountFor(card.dept).code, summary: '补提折旧 ' + code + ' ' + card.name, debit: amt, aux: { dept: card.dept } },
          { accountCode: '1602', summary: '补提折旧 ' + code, credit: amt }
        ]);
        if (!cu.ok) return fail('补提折旧失败：' + cu.reason);
        card.accumulated += amt;
        card.monthsElapsed = m;
        S().set('assets', list());
        catchup = { id: cu.id, amount: amt };
      }
    }

    var net = card.cost - card.accumulated;
    var gain = price > net ? price - net : 0;
    var loss = price < net ? net - price : 0;
    var rows = [];
    if (card.accumulated > 0) rows.push({ accountCode: '1602', summary: '转销累计折旧 ' + code, debit: card.accumulated });
    if (price > 0) rows.push({ accountCode: '100201', summary: '处置收款 ' + code, debit: price });
    if (loss > 0) rows.push({ accountCode: '6301', summary: '资产处置损失 ' + code, debit: loss });
    rows.push({ accountCode: '1601', summary: '转销原值 ' + code, credit: card.cost });
    if (gain > 0) rows.push({ accountCode: '6301', summary: '资产处置利得 ' + code, credit: gain });
    var res = postVoucher(lastDay(period), '处置固定资产 ' + code + ' ' + card.name, '系统处置', rows);
    if (!res.ok) return fail('处置凭证生成失败：' + res.reason);
    card.status = '已处置';
    card.disposeDate = lastDay(period);
    card.disposePrice = price;
    S().set('assets', list());
    S().log('资产处置', code, '处置价 ' + S().fmt(price) + '，净值 ' + S().fmt(net) +
      (gain ? '，利得 ' + S().fmt(gain) : '') + (loss ? '，损失 ' + S().fmt(loss) : '') + '，凭证 ' + res.id);
    return { ok: true, id: res.id, net: net, price: price, gain: gain, loss: loss, card: card, catchup: catchup };
  }

  /* ---------- 渲染 ---------- */

  var V_ = { tab: 'list', disposing: '' };

  function renderAssets(el) {
    var esc = S().esc, fmt = S().fmt;
    var assets = list();
    var md = monthlyDepreciation();

    var html = '<div class="page-head"><h2>固定资产</h2><div class="page-actions">' +
      '<button class="btn" data-action="toggle-new">' + (V_.tab === 'new' ? '返回卡片列表' : '＋ 新增资产') + '</button>' +
      '　<button class="btn btn-primary" data-action="run-dep">计提本月折旧</button>' +
      '　<span class="muted">本月应提合计 ' + fmt(md.total) + '</span></div></div>';

    if (V_.tab === 'new') {
      html += '<h3 class="sec-title">新增资产（自动生成购入凭证并过账）</h3>';
      html += '<table class="form-table">' +
        '<tr><th>名称</th><td><input id="fm-a-name" class="input" style="width:200px"></td>' +
        '<th>类别</th><td><select id="fm-a-cat" class="input">' + Object.keys(CATEGORIES).map(function (c) {
          return '<option>' + c + '</option>';
        }).join('') + '</select></td></tr>' +
        '<tr><th>原值（元）</th><td><input id="fm-a-cost" class="input num" style="width:150px" inputmode="decimal"></td>' +
        '<th>使用年限（月）</th><td><input id="fm-a-months" class="input num" style="width:100px" inputmode="numeric"></td></tr>' +
        '<tr><th>净残值率（0-0.5）</th><td><input id="fm-a-rate" class="input num" style="width:100px" value="0.05"></td>' +
        '<th>折旧方法</th><td><select id="fm-a-method" class="input"><option>直线法</option><option>双倍余额递减法</option><option>年数总和法</option></select></td></tr>' +
        '<tr><th>购入日期</th><td><input id="fm-a-date" class="input" style="width:130px" placeholder="' + esc(currentPeriod()) + '-05"></td>' +
        '<th>使用部门</th><td><input id="fm-a-dept" class="input" style="width:80px" placeholder="D02"></td></tr>' +
        '<tr><th>存放地点</th><td><input id="fm-a-loc" class="input" style="width:150px"></td>' +
        '<th>付款方式</th><td><select id="fm-a-pay" class="input"><option value="bank">银行存款</option><option value="cash">库存现金</option><option value="credit">赊购（应付账款）</option></select>' +
        '　供应商 <input id="fm-a-sup" class="input" style="width:80px" placeholder="S001"></td></tr></table>';
      html += '<div style="margin-top:10px"><button class="btn btn-primary" data-action="save-new">保存并生成购入凭证</button></div>';
      el.innerHTML = html;
      el.onclick = function (ev) {
        var t = ev && ev.target;
        while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
        if (!t || !t.dataset) return;
        if (t.dataset.action === 'toggle-new') { V_.tab = 'list'; renderAssets(el); }
      };
      return;
    }

    html += '<table class="grid"><thead><tr><th style="width:80px">编码</th><th>名称</th>' +
      '<th style="width:90px">类别</th><th style="width:100px">购入日期</th>' +
      '<th class="num" style="width:120px">原值</th><th class="num" style="width:120px">累计折旧</th>' +
      '<th class="num" style="width:120px">净值</th><th class="center" style="width:60px">状态</th>' +
      '<th style="width:170px">操作</th></tr></thead><tbody>';
    assets.forEach(function (c) {
      var ops = '<button class="btn btn-sm" data-action="dep-detail" data-code="' + esc(c.code) + '">当月折旧</button>';
      if (c.status !== '已处置') {
        ops += ' <button class="btn btn-sm btn-danger" data-action="dispose-form" data-code="' + esc(c.code) + '">处置</button>';
      }
      html += '<tr><td class="mono">' + esc(c.code) + '</td><td>' + esc(c.name) + '</td>' +
        '<td>' + esc(c.category) + '</td><td>' + esc(c.purchaseDate) + '</td>' +
        '<td class="num">' + fmt(c.cost) + '</td><td class="num">' + (c.accumulated ? fmt(c.accumulated) : '') + '</td>' +
        '<td class="num"><b>' + fmt(netBookValue(c.code)) + '</b></td>' +
        '<td class="center"><span class="badge" data-status="' + esc(c.status) + '">' + esc(c.status) + '</span></td>' +
        '<td>' + ops + '</td></tr>';
    });
    if (!assets.length) html += '<tr><td colspan="9" class="center muted">暂无资产卡片</td></tr>';
    html += '</tbody></table>';

    if (V_.disposing) {
      var dc = getCard(V_.disposing);
      if (dc && dc.status !== '已处置') {
        html += '<div class="notice ok" style="margin-top:12px">处置 <b>' + esc(dc.code) + ' ' + esc(dc.name) +
          '</b>（净值 ' + fmt(netBookValue(dc.code)) + '）：处置价（元）' +
          '<input id="fm-dispose-price" class="input num" style="width:130px" inputmode="decimal">' +
          '　<button class="btn btn-danger" data-action="do-dispose" data-code="' + esc(dc.code) + '">确认处置</button></div>';
      }
    }

    html += '<h3 class="sec-title">本月折旧明细（' + esc(md.period) + '）</h3>';
    html += '<table class="grid"><thead><tr><th style="width:100px">费用科目</th><th style="width:80px">部门</th>' +
      '<th>摘要</th><th class="num" style="width:130px">本月折旧</th></tr></thead><tbody>';
    md.entries.forEach(function (e) {
      html += '<tr><td class="mono">' + esc(e.accountCode) + ' ' + esc(e.accountName) + '</td>' +
        '<td>' + esc(e.dept) + '</td><td>' + esc(e.summary) + '</td><td class="num">' + fmt(e.debit) + '</td></tr>';
    });
    if (!md.entries.length) html += '<tr><td colspan="4" class="center muted">本月无应提折旧</td></tr>';
    html += '<tr><td colspan="3"><b>合计</b></td><td class="num"><b>' + fmt(md.total) + '</b></td></tr>';
    html += '</tbody></table>';
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      var act = t.dataset.action;
      if (act === 'toggle-new') { V_.tab = 'new'; renderAssets(el); return; }
      if (act === 'dep-detail') {
        var c = getCard(t.dataset.code);
        root.FMToast((c ? c.code + ' ' + c.name + '：' : '') + '本月应提 ' +
          fmt(depreciation(t.dataset.code)), 'ok');
        return;
      }
      if (act === 'dispose-form') { V_.disposing = t.dataset.code; renderAssets(el); return; }
      if (act === 'run-dep') {
        var r1 = runDepreciation();
        root.FMToast(r1.ok ? '已计提' + (r1.id ? '：' + r1.id : '') + '，合计 ' + fmt(r1.total) : r1.reason, r1.ok ? 'ok' : 'bad');
        if (r1.ok) renderAssets(el);
        return;
      }
      if (act === 'do-dispose') {
        var price = S().toCents((document.getElementById('fm-dispose-price') || { value: '0' }).value);
        if (price === null) { root.FMToast('处置价格式不正确', 'bad'); return; }
        var r2 = dispose(t.dataset.code, null, price);
        root.FMToast(r2.ok ? '已处置' + (r2.id ? '：' + r2.id : '') + (r2.gain ? '，利得 ' + fmt(r2.gain) : '') +
          (r2.loss ? '，损失 ' + fmt(r2.loss) : '') : r2.reason, r2.ok ? 'ok' : 'bad');
        if (r2.ok) { V_.disposing = ''; renderAssets(el); }
      }
    };
  }

  root.FMAssets = {
    list: list, add: add, dispose: dispose, depreciation: depreciation,
    monthlyDepreciation: monthlyDepreciation, runDepreciation: runDepreciation,
    netBookValue: netBookValue, depSchedule: depSchedule, renderAssets: renderAssets
  };
})(typeof window !== 'undefined' ? window : globalThis);
