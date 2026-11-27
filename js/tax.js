/* 财务管理系统 · 税务管理（chunk 6）
 * 管理函数并入 window.FMTax（js/taxrules.js 已占用 FMTax 全局名，本文件在同一对象上追加，
 * 税率/限额一律从该对象取，不得硬编码）：
 *   FMTax = { …taxrules 规则…, vatSummary, calcVAT, calcSurtax, calcCIT, calcStamp,
 *             fileVAT, fileCIT, payTax, renderTax }
 * 约定（与账簿同口径）：
 * - 只有已过账凭证进发生额/余额（A.activity 默认 postedOnly）；金额一律整数分，显示用 S().fmt。
 * - 申报/缴款凭证走 voucher.js create→audit→post（制单人“系统税务”），不直改 state。
 * - 一般纳税人：应纳增值税 = 销项 − 进项，可为负（留抵结转下期，不生成应交，也不计附加税）。
 * - 附加税计税依据 = 应纳增值税（≤0 时为 0）；小微“六税两费”减半按 从业≤300 且 资产总额≤5000 万 判断。
 * - 企业所得税：利润总额 = 损益类末级科目本期已过账发生额（贷方科目贷−借，借方科目借−贷，
 *   口径上视同当期损益已结转 3103 本年利润，3103 期初余额不计入）；小微实际税负 5%，
 *   超过 300 万全额按 25%，不能分段。印花税：买卖合同 0.03%、借款合同 0.005%，
 *   资金账簿 0.025% 仅期初计一次（本模块只算本期合同印花税）。
 * - 申报记录存 state.taxRecords：{id, period, type:'VAT'|'CIT', amount(分), status:'已申报'|'已缴纳', …}。
 */
(function (root) {
  'use strict';

  var R = root.FMTax || (root.FMTax = {}); // 规则表（taxrules.js）+ 管理函数，同一全局对象
  function S() { return root.FMStore; }
  function A() { return root.FMAccounts; }
  function V() { return root.FMVoucher; }
  function fail(reason) { return { ok: false, reason: reason }; }

  function currentPeriod() {
    var p = S().get('periods');
    return (p && p.current) || '';
  }

  function lastDay(period) {
    var d = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate();
    return period + '-' + ('0' + d).slice(-2);
  }

  function company() { return S().get('company') || {}; }
  function operator() { return company().operator || ''; }
  function isGeneral() { return (company().taxpayerType || 'general') === 'general'; }
  function yuan(cents) { return (cents / 100).toFixed(2); }

  /* 资产总额（分）：资产类末级科目余额合计（已过账口径，1602 等备抵科目余额为负自动冲减） */
  function totalAssetsCents() {
    var sum = 0;
    A().leaves().forEach(function (a) {
      if (a.category === '资产') sum += A().balance(a.code);
    });
    return sum;
  }

  /* 六税两费减半：从业 ≤300 且 资产总额 ≤5000 万（元），优惠期内 */
  function smallSixTax(opts) {
    if (lastDay(opts.period || currentPeriod()) > R.sixTaxTwoFeeHalfUntil) return false;
    var assets = opts.totalAssetsCents !== undefined ? opts.totalAssetsCents : totalAssetsCents();
    var staff = opts.staffCount !== undefined ? opts.staffCount : (company().staffCount || 0);
    return staff <= R.cit.smallProfit.staffLimit && assets / 100 <= R.cit.smallProfit.assetsLimit;
  }

  /* ---------- 增值税 ---------- */

  // 本期已过账发生额：22210101 进项（净借）/ 22210102 销项（净贷）/ 22210103 已交税金（净借）
  function vatSummary(period) {
    period = period || currentPeriod();
    function act(code) { return A().activity(code, period); }
    var a1 = act('22210101'), a2 = act('22210102'), a3 = act('22210103');
    var output = a2.credit - a2.debit;  // 销项税额（净贷方）
    var input = a1.debit - a1.credit;   // 进项税额（净借方）
    var paid = a3.debit - a3.credit;    // 已交税金（净借方）
    if (isGeneral()) {
      return {
        period: period, taxpayerType: '一般纳税人', output: output, input: input, paid: paid,
        payable: output - input,          // 应纳 = 销项 − 进项，可为负（留抵）
        balance: output - input - paid    // 扣除已交后的应缴余额
      };
    }
    // 小规模纳税人分支：月销 ≤15 万免征；征收率 3% 减按 1%（2026-01-01 至 2027-12-31）
    var sc = R.vat.smallScale;
    var sales = output; // 简化：以本期销售额（分）计
    var rate = null;
    if (sales > sc.exemptMonthly * 100) {
      var day = lastDay(period);
      rate = (day >= sc.reducedFrom && day <= sc.reducedUntil) ? sc.reduced : sc.levy;
    }
    var payable = rate === null ? 0 : Math.round(sales * rate);
    return {
      period: period, taxpayerType: '小规模纳税人', output: sales, input: 0, paid: paid,
      payable: payable, balance: payable - paid, exempt: rate === null,
      rateApplied: rate
    };
  }

  function calcVAT(period) {
    var v = vatSummary(period);
    v.carryForward = v.payable < 0 ? -v.payable : 0; // 留抵结转下期，不生成应交
    return v;
  }

  /* ---------- 附加税 ---------- */

  // calcSurtax(vatPayable 分, opts {totalAssetsCents, staffCount, period}) → {urban, edu, local, total, halved}
  function calcSurtax(vatPayable, opts) {
    opts = opts || {};
    var base = vatPayable > 0 ? vatPayable : 0; // 计税依据 = 实际缴纳（应缴）的增值税
    var st = R.surtax;
    var loc = company().location || 'urban';
    var urbanRate = loc === 'urban' ? st.urban : (loc === 'county' ? st.county : st.other);
    var halved = smallSixTax(opts);
    var half = halved ? 0.5 : 1;
    var urban = Math.round(base * urbanRate * half);
    var edu = Math.round(base * st.edu * half);
    var local = Math.round(base * st.localEdu * half);
    return {
      base: base, urban: urban, edu: edu, local: local, total: urban + edu + local, halved: halved,
      rates: { urban: urbanRate, edu: st.edu, local: st.localEdu }
    };
  }

  /* ---------- 企业所得税 ---------- */

  // 利润总额（分）：损益类末级科目本期已过账发生额（贷 − 借，收入为正贡献、费用为负贡献），
  // 加上 4101 制造费用。本系统没有成本结转步骤，chunk 4/5 把生产部门的折旧/工资计在 4101 上，
  // 它在这里就是生产部门的期间费用，必须进利润（否则利润虚增）；
  // 4001 生产成本 / 4301 研发支出 / 4401 工程施工是成本归集科目（存货性/可资本化），不算期间费用、不进来。
  function profitOfPeriod(period) {
    var profit = 0;
    A().leaves().forEach(function (a) {
      if (a.category !== '损益' && a.code !== '4101') return;
      var act = A().activity(a.code, period);
      profit += act.credit - act.debit;
    });
    return profit;
  }

  // calcCIT(period, opts {profitCents, totalAssetsCents, staffCount}) → {profit, taxable, rate, effectiveRate, tax, isSmall}
  function calcCIT(period, opts) {
    opts = opts || {};
    period = period || currentPeriod();
    var profit = opts.profitCents !== undefined ? opts.profitCents : profitOfPeriod(period);
    var assets = opts.totalAssetsCents !== undefined ? opts.totalAssetsCents : totalAssetsCents();
    var staff = opts.staffCount !== undefined ? opts.staffCount : (company().staffCount || 0);
    var taxable = profit > 0 ? profit : 0; // 简化口径：无纳税调整，应纳税所得额 = max(0, 利润总额)
    var small = taxable > 0 && R.isSmallProfit({
      taxableIncome: taxable / 100, staffCount: staff, totalAssets: assets / 100
    });
    var effective = small ? R.smallProfitEffectiveRate() : R.cit.rate;
    var tax = Math.round(taxable * effective);
    return {
      period: period, profit: profit, taxable: taxable, rate: R.cit.rate,
      effectiveRate: effective, tax: tax, isSmall: small,
      staffCount: staff, totalAssets: assets
    };
  }

  /* ---------- 印花税 ---------- */

  // 本期已过账凭证摘要含“合同”的：借款合同 0.005%，其余按买卖合同 0.03%；金额 = 凭证借贷合计 ÷ 2。
  // 资金账簿（实收资本 3001 + 资本公积 3002）×0.025% 仅期初计一次，不计入本期合同印花税（仅返回基数供参考）。
  function calcStamp(period) {
    period = period || currentPeriod();
    var vs = S().get('vouchers') || [], es = S().get('entries') || [];
    var posted = {};
    vs.forEach(function (v) { if (v.period === period && v.status === '已过账') posted[v.id] = v; });
    var sums = {};
    es.forEach(function (e) {
      if (!posted[e.voucherId]) return;
      sums[e.voucherId] = (sums[e.voucherId] || 0) + (e.debit || 0) + (e.credit || 0);
    });
    var sale = 0, loan = 0, hits = [];
    Object.keys(sums).forEach(function (id) {
      var s = posted[id].summary || '';
      if (s.indexOf('合同') < 0) return;
      var amount = Math.round(sums[id] / 2);
      var kind = s.indexOf('借款合同') >= 0 ? '借款合同' : '买卖合同';
      if (kind === '借款合同') loan += amount; else sale += amount;
      hits.push({ voucherId: id, summary: s, kind: kind, amount: amount });
    });
    var sd = R.stampDuty;
    var saleTax = Math.round(sale * sd.saleContract);
    var loanTax = Math.round(loan * sd.loanContract);
    var fundBase = A().balance('3001') + A().balance('3002');
    return {
      period: period, saleBase: sale, loanBase: loan, saleTax: saleTax, loanTax: loanTax,
      total: saleTax + loanTax, hits: hits,
      fundBookBase: fundBase, fundBookTax: Math.round(fundBase * sd.accountBook),
      note: '资金账簿印花税（实收资本+资本公积 ×0.025%）仅在期初/增资时计一次，不计入本期合同印花税'
    };
  }

  /* ---------- 申报与缴款 ---------- */

  function records() { return S().get('taxRecords') || []; }

  function findRecord(recordId) {
    var hit = null;
    records().forEach(function (r) { if (r.id === recordId) hit = r; });
    return hit;
  }

  function postVoucher(date, summary, rows) {
    var entries = rows.map(function (r) {
      return {
        accountCode: r.accountCode, summary: r.summary || summary,
        debit: r.debit ? yuan(r.debit) : 0, credit: r.credit ? yuan(r.credit) : 0,
        aux: r.aux || {}
      };
    });
    var res = V().create({ date: date, summary: summary, maker: '系统税务', attachCount: 0, entries: entries });
    if (!res.ok) return fail(res.reason);
    var au = V().audit(res.id, operator() === '系统税务' ? '系统审核' : (operator() || '系统审核'));
    if (!au.ok) return fail(au.reason);
    var po = V().post(res.id);
    if (!po.ok) return fail(po.reason);
    return { ok: true, id: res.id };
  }

  function baseGuards(period, what) {
    if (!/^\d{4}-\d{2}$/.test(period)) return fail('会计期间格式不正确，应为 2026-11');
    if (period !== currentPeriod()) return fail('只能申报当前会计期间（' + currentPeriod() + '）的' + what);
    if (root.FMClosing && root.FMClosing.isClosed(period)) return fail('会计期间 ' + period + ' 已结账，不能申报');
    return null;
  }

  // 增值税及附加申报：应纳>0 → 借 22210104 转出未交 / 贷 222102；附加 → 借 5101 税金及附加 / 贷 222105-107
  function fileVAT(period) {
    period = period || currentPeriod();
    /* chunk 8：角色权限拦截（出纳/审计不能申报） */
    var rg = root.FMRoles ? root.FMRoles.guard('fileTax') : { ok: true };
    if (!rg.ok) return fail(rg.reason);
    var g = baseGuards(period, '增值税');
    if (g) return g;
    if (findRecord('TAX-' + period + '-VAT')) return fail('本期增值税已申报，不能重复申报');
    var vat = calcVAT(period);
    var sur = calcSurtax(Math.max(0, vat.payable), { period: period });
    var rows = [];
    if (vat.payable > 0) {
      rows.push({ accountCode: '22210104', summary: '转出未交增值税', debit: vat.payable });
      rows.push({ accountCode: '222102', summary: '结转未交增值税', credit: vat.payable });
    }
    if (sur.total > 0) {
      rows.push({ accountCode: '5101', summary: '计提附加税费', debit: sur.total });
      if (sur.urban > 0) rows.push({ accountCode: '222105', summary: '应交城市维护建设税', credit: sur.urban });
      if (sur.edu > 0) rows.push({ accountCode: '222106', summary: '应交教育费附加', credit: sur.edu });
      if (sur.local > 0) rows.push({ accountCode: '222107', summary: '应交地方教育附加', credit: sur.local });
    }
    var voucherId = null;
    if (rows.length) {
      var res = postVoucher(lastDay(period), '申报 ' + period + ' 增值税及附加税费', rows);
      if (!res.ok) return fail('增值税申报失败：' + res.reason);
      voucherId = res.id;
    }
    var rec = {
      id: 'TAX-' + period + '-VAT', period: period, type: 'VAT',
      amount: Math.max(0, vat.payable),
      surtax: { urban: sur.urban, edu: sur.edu, local: sur.local, total: sur.total, halved: sur.halved },
      detail: { output: vat.output, input: vat.input, paid: vat.paid, balance: vat.balance },
      status: '已申报', filedAt: lastDay(period), voucherId: voucherId,
      note: vat.payable <= 0 ? '应纳增值税 ≤ 0（留抵 ' + S().fmt(-vat.payable) + ' 结转下期），无需缴款' : ''
    };
    S().set('taxRecords', records().concat([rec]));
    S().log('增值税申报', rec.id, '销项 ' + S().fmt(vat.output) + '，应纳 ' + S().fmt(rec.amount) + '，附加 ' + S().fmt(sur.total));
    return { ok: true, id: rec.id, record: rec, voucherId: voucherId, vat: vat, surtax: sur };
  }

  // 企业所得税申报：借 6801 所得税费用 / 贷 222103
  function fileCIT(period) {
    period = period || currentPeriod();
    /* chunk 8：角色权限拦截（出纳/审计不能申报） */
    var rg = root.FMRoles ? root.FMRoles.guard('fileTax') : { ok: true };
    if (!rg.ok) return fail(rg.reason);
    var g = baseGuards(period, '企业所得税');
    if (g) return g;
    if (findRecord('TAX-' + period + '-CIT')) return fail('本期企业所得税已申报，不能重复申报');
    var cit = calcCIT(period);
    var rows = [], voucherId = null;
    if (cit.tax > 0) {
      rows.push({ accountCode: '6801', summary: '计提企业所得税', debit: cit.tax });
      rows.push({ accountCode: '222103', summary: '应交企业所得税', credit: cit.tax });
      var res = postVoucher(lastDay(period), '申报 ' + period + ' 企业所得税', rows);
      if (!res.ok) return fail('企业所得税申报失败：' + res.reason);
      voucherId = res.id;
    }
    var rec = {
      id: 'TAX-' + period + '-CIT', period: period, type: 'CIT',
      amount: cit.tax,
      detail: { profit: cit.profit, taxable: cit.taxable, rate: cit.rate, effectiveRate: cit.effectiveRate, isSmall: cit.isSmall },
      status: '已申报', filedAt: lastDay(period), voucherId: voucherId,
      note: cit.tax <= 0 ? '本期利润 ≤ 0，无需计提企业所得税' : ''
    };
    S().set('taxRecords', records().concat([rec]));
    S().log('企业所得税申报', rec.id, '利润 ' + S().fmt(cit.profit) + '，税 ' + S().fmt(cit.tax));
    return { ok: true, id: rec.id, record: rec, voucherId: voucherId, cit: cit };
  }

  // 缴款：VAT → 借 222102 + 222105/106/107；CIT → 借 222103；贷 100201。状态改“已缴纳”。
  function payTax(recordId) {
    var rec = findRecord(recordId);
    if (!rec) return fail('申报记录“' + recordId + '”不存在');
    if (rec.status === '已缴纳') return fail('该税款已缴纳，不能重复缴款');
    if (rec.period !== currentPeriod()) return fail('只能缴纳当前会计期间（' + currentPeriod() + '）的税款');
    if (root.FMClosing && root.FMClosing.isClosed(rec.period)) return fail('会计期间 ' + rec.period + ' 已结账，不能缴款');
    var rows = [], total = 0;
    function dr(code, amount, summary) {
      if (amount > 0) { rows.push({ accountCode: code, summary: summary, debit: amount }); total += amount; }
    }
    var typeName = { VAT: '增值税及附加', CIT: '企业所得税' }[rec.type] || rec.type;
    if (rec.type === 'VAT') {
      dr('222102', rec.amount, '缴纳增值税');
      if (rec.surtax) {
        dr('222105', rec.surtax.urban, '缴纳城市维护建设税');
        dr('222106', rec.surtax.edu, '缴纳教育费附加');
        dr('222107', rec.surtax.local, '缴纳地方教育附加');
      }
    } else if (rec.type === 'CIT') {
      dr('222103', rec.amount, '缴纳企业所得税');
    } else {
      return fail('未知的税款类型：' + rec.type);
    }
    if (!rows.length) return fail('本期无应缴税款，无需缴款');
    rows.push({ accountCode: '100201', summary: '银行缴纳税款', credit: total });
    var res = postVoucher(lastDay(rec.period), '缴款 ' + rec.period + ' ' + typeName, rows);
    if (!res.ok) return fail('税款缴款失败：' + res.reason);
    rec.status = '已缴纳';
    rec.paidAt = lastDay(rec.period);
    rec.payVoucherId = res.id;
    S().set('taxRecords', records());
    S().log('税款缴款', res.id, typeName + ' ' + S().fmt(total));
    return { ok: true, id: res.id, total: total, record: rec };
  }

  /* ---------- 渲染 ---------- */

  function renderTax(el) {
    var esc = S().esc, fmt = S().fmt;
    var period = currentPeriod();
    var vat = calcVAT(period);
    var sur = calcSurtax(Math.max(0, vat.payable), { period: period });
    var cit = calcCIT(period);
    var stamp = calcStamp(period);
    var recs = records().slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    var filedVAT = recs.some(function (r) { return r.period === period && r.type === 'VAT'; });
    var filedCIT = recs.some(function (r) { return r.period === period && r.type === 'CIT'; });

    var html = '<div class="page-head"><h2>税务管理</h2><div class="page-actions">' +
      '<button class="btn btn-primary" data-action="fileVAT"' + (filedVAT ? ' disabled' : '') + '>申报增值税及附加</button>' +
      '　<button class="btn btn-primary" data-action="fileCIT"' + (filedCIT ? ' disabled' : '') + '>申报企业所得税</button></div></div>';

    html += '<h3 class="sec-title">增值税（' + esc(period) + ' · ' + esc(vat.taxpayerType) + '）</h3>';
    html += '<div class="cards">' +
      card('销项税额', fmt(vat.output)) + card('进项税额', fmt(vat.input)) +
      card('应纳增值税', fmt(vat.payable)) + card('已交税金', fmt(vat.paid)) +
      card(vat.payable < 0 ? '期末留抵（结转下期）' : '应缴余额', fmt(vat.payable < 0 ? vat.carryForward : vat.balance)) +
      '</div>';
    if (vat.payable < 0) html += '<div class="notice ok">应纳增值税为负，留抵 ' + fmt(vat.carryForward) + ' 结转下期抵扣，本期不生成应交税费、不计附加税。</div>';

    html += '<h3 class="sec-title">附加税费（计税依据 = 应纳增值税' + (sur.halved ? ' · 小微六税两费减半' : '') + '）</h3>';
    html += '<table class="grid"><thead><tr><th>税费</th><th class="num">税率</th><th class="num">计税依据</th><th class="num">应缴</th></tr></thead><tbody>';
    [['城市维护建设税', sur.rates.urban, sur.urban], ['教育费附加', sur.rates.edu, sur.edu],
     ['地方教育附加', sur.rates.local, sur.local]].forEach(function (x) {
      html += '<tr><td>' + x[0] + '</td><td class="num">' + (x[1] * 100).toFixed(1).replace(/\.0$/, '') + '%' +
        (sur.halved ? ' × 50%' : '') + '</td><td class="num">' + fmt(sur.base) + '</td><td class="num">' + fmt(x[2]) + '</td></tr>';
    });
    html += '<tr><td><b>合计</b></td><td></td><td></td><td class="num"><b>' + fmt(sur.total) + '</b></td></tr></tbody></table>';

    html += '<h3 class="sec-title">企业所得税（' + esc(period) + '）</h3>';
    html += '<div class="cards">' + card('利润总额', fmt(cit.profit)) +
      card('应纳税所得额', fmt(cit.taxable)) + card('法定税率', (cit.rate * 100).toFixed(0) + '%') +
      card('实际税率', (cit.effectiveRate * 100).toFixed(cit.effectiveRate * 100 % 1 ? 2 : 0) + '%') +
      card('应交所得税', fmt(cit.tax)) + '</div>';
    html += '<div class="notice ' + (cit.isSmall ? 'ok' : 'bad') + '">' +
      (cit.isSmall ? '✓ 小型微利企业：应纳税所得额 ≤ ' + fmt(R.cit.smallProfit.incomeLimit * 100) +
        '、从业 ' + cit.staffCount + ' ≤ 300、资产总额 ' + fmt(cit.totalAssets) + ' ≤ 5,000 万，减按 25% 计入 × 20% 税率，实际税负 5%。'
        : '✗ 不符合小型微利条件（所得额 ≤ ' + fmt(R.cit.smallProfit.incomeLimit * 100) + '、从业 ≤ 300、资产 ≤ 5,000 万须同时满足），全额按 25%，不能分段。') +
      '</div>';

    html += '<h3 class="sec-title">印花税（本期合同）</h3>';
    html += '<table class="grid"><thead><tr><th>税目</th><th class="num">计税金额</th><th class="num">税率</th><th class="num">税额</th></tr></thead><tbody>';
    html += '<tr><td>买卖合同</td><td class="num">' + fmt(stamp.saleBase) + '</td><td class="num">0.03%</td><td class="num">' + fmt(stamp.saleTax) + '</td></tr>';
    html += '<tr><td>借款合同</td><td class="num">' + fmt(stamp.loanBase) + '</td><td class="num">0.005%</td><td class="num">' + fmt(stamp.loanTax) + '</td></tr>';
    html += '<tr><td><b>合计</b></td><td></td><td></td><td class="num"><b>' + fmt(stamp.total) + '</b></td></tr>';
    html += '</tbody></table>';
    html += '<div class="muted">' + esc(stamp.note) + '（资金账簿基数 ' + fmt(stamp.fundBookBase) + '，对应税额 ' + fmt(stamp.fundBookTax) + '，仅供参考）</div>';

    html += '<h3 class="sec-title">申报记录</h3>';
    if (!recs.length) {
      html += '<div class="notice ok">暂无申报记录。计提本月税款请点上方“申报”按钮。</div>';
    } else {
      html += '<table class="grid"><thead><tr><th style="width:180px">记录号</th><th style="width:90px">期间</th>' +
        '<th style="width:130px">税种</th><th class="num" style="width:130px">税额</th>' +
        '<th class="num" style="width:120px">附加</th><th class="center" style="width:90px">状态</th>' +
        '<th style="width:200px">备注</th><th class="center" style="width:90px">操作</th></tr></thead><tbody>';
      recs.forEach(function (r) {
        html += '<tr><td class="mono">' + esc(r.id) + '</td><td>' + esc(r.period) + '</td>' +
          '<td>' + esc(r.type === 'VAT' ? '增值税及附加' : r.type === 'CIT' ? '企业所得税' : r.type) + '</td>' +
          '<td class="num">' + fmt(r.amount) + '</td>' +
          '<td class="num">' + (r.surtax ? fmt(r.surtax.total) : '') + '</td>' +
          '<td class="center">' + esc(r.status) + '</td><td class="muted">' + esc(r.note || '') + '</td>' +
          '<td class="center">' + (r.status === '已申报' && r.amount + (r.surtax ? r.surtax.total : 0) > 0
            ? '<button class="btn btn-sm" data-pay="' + esc(r.id) + '">缴款</button>' : '') + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && (t.dataset.action || t.dataset.pay))) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      if (t.dataset.action === 'fileVAT') {
        var r1 = fileVAT(period);
        root.FMToast(r1.ok ? '已申报增值税：' + r1.id + '，应纳 ' + fmt(r1.record.amount) : r1.reason, r1.ok ? 'ok' : 'bad');
        if (r1.ok) renderTax(el);
      } else if (t.dataset.action === 'fileCIT') {
        var r2 = fileCIT(period);
        root.FMToast(r2.ok ? '已申报企业所得税：' + r2.id + '，税额 ' + fmt(r2.record.amount) : r2.reason, r2.ok ? 'ok' : 'bad');
        if (r2.ok) renderTax(el);
      } else if (t.dataset.pay) {
        var r3 = payTax(t.dataset.pay);
        root.FMToast(r3.ok ? '已缴款：' + r3.id + '，' + fmt(r3.total) : r3.reason, r3.ok ? 'ok' : 'bad');
        if (r3.ok) renderTax(el);
      }
    };
  }

  function card(label, value) {
    return '<div class="card"><div class="card-label">' + label + '</div><div class="card-num num">' + value + '</div></div>';
  }

  R.vatSummary = vatSummary;
  R.calcVAT = calcVAT;
  R.calcSurtax = calcSurtax;
  R.calcCIT = calcCIT;
  R.calcStamp = calcStamp;
  R.fileVAT = fileVAT;
  R.fileCIT = fileCIT;
  R.payTax = payTax;
  R.renderTax = renderTax;
})(typeof window !== 'undefined' ? window : globalThis);
