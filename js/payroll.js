/* 财务管理系统 · 薪酬工资 / 个税（chunk 5）
 * window.FMPayroll = { list, getStaffPay, calcSocial, calcTax, calcMonthlyTax, calcBonusTax,
 *                      extraMonthly, accrue, pay, renderPayroll }
 * 约定（与账簿同口径）：
 * - 金额一律整数分；余额只认已过账凭证；计提/发放凭证走 voucher.js create→audit→post（制单人“系统薪酬”）。
 * - 个税累计预扣法：本期应预扣 = 累计应纳税所得额×预扣率−速算扣除数−累计已预扣；税率表/速算扣除数/
 *   减除费用/专项附加扣除标准/社保费率全部取自 js/taxrules.js，不硬编码。
 * - 累计口径：本年 1 月至本期的已计提工资单（state.payrolls）逐月累计；无工资单的历史月份按 0 算。
 * - 税额取整规则：税额按分四舍五入（Math.round(taxable×rate−速算扣除数)）；应纳税所得额 ≤0 税额为 0，
 *   本期应扣 = max(0, 累计税额 − 累计已预扣)。
 * - 费用科目（末级、带部门辅助核算）：生产/仓储 D06 → 4101 制造费用；销售 D08-D11 → 520101/520107/520108；
 *   其他部门 → 530101/530110/530111（职工薪酬 / 社会保险费 / 住房公积金）。
 *   （注：科目表 5101 是“税金及附加”，故不按 5101 记工资。）
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }
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

  // 分 → 元字符串（create 里 cleanCents 把输入当元处理）
  function yuan(cents) { return (cents / 100).toFixed(2); }

  /* ---------- 员工档案 ---------- */

  // 职务 → 默认月薪（元），按序匹配；都不中按 专员 8000 兜底
  var TITLE_SALARY = [['总经理', 35000], ['经理', 18000], ['主管', 12000], ['会计', 8000], ['专员', 8000], ['代表', 6000]];

  function staffList() { return S().get('staff') || []; }

  function getStaff(id) {
    var hit = null;
    staffList().forEach(function (s) { if (s.id === id) hit = s; });
    return hit;
  }

  // 月薪标准（分）：员工记录 salary 优先，缺省按职务名匹配
  function getStaffPay(id) {
    var s = getStaff(id);
    if (!s) return 0;
    if (s.salary) return s.salary;
    var title = s.title || '';
    for (var i = 0; i < TITLE_SALARY.length; i++) {
      if (title.indexOf(TITLE_SALARY[i][0]) >= 0) return TITLE_SALARY[i][1] * 100;
    }
    return 800000;
  }

  /* 七项专项附加扣除的月度合计（分）：子女/婴幼儿按人数、学历/房贷按开关、租金按档、赡养老人封顶 */
  function extraMonthly(staff) {
    var d = (staff && staff.deductions) || {};
    var sd = T().iit.specialDeductions;
    var yuanPerMonth = 0;
    yuanPerMonth += (d.children || 0) * sd.childEdu;      // 子女教育 2000/子女/月
    yuanPerMonth += (d.infant || 0) * sd.infantCare;      // 婴幼儿照护 2000/婴幼儿/月
    if (d.education) yuanPerMonth += sd.degreeEdu;        // 学历继续教育 400/月
    if (d.mortgage) yuanPerMonth += sd.housingLoan;       // 住房贷款利息 1000/月
    yuanPerMonth += d.rent || 0;                          // 住房租金 1500/1100/800
    yuanPerMonth += Math.min(d.parents || 0, sd.elderly.onlyChild); // 赡养老人 ≤3000（独生封顶）
    return yuanPerMonth * 100;
  }

  /* ---------- 五险一金（费率取自 taxrules.social） ---------- */

  function calcSocial(grossCents) {
    var r = T().social;
    function item(rate) { return Math.round(grossCents * rate); }
    var personal = {
      pension: item(r.pension.personal), medical: item(r.medical.personal),
      unemployment: item(r.unemployment.personal), fund: item(r.housingFund.personal)
    };
    var company = {
      pension: item(r.pension.company), medical: item(r.medical.company),
      unemployment: item(r.unemployment.company), injury: item(r.injury.company),
      maternity: item(r.maternity.company), fund: item(r.housingFund.company)
    };
    personal.total = personal.pension + personal.medical + personal.unemployment + personal.fund;
    company.total = company.pension + company.medical + company.unemployment +
      company.injury + company.maternity + company.fund;
    return { base: grossCents, personal: personal, personalTotal: personal.total, company: company, companyTotal: company.total };
  }

  /* ---------- 个税累计预扣法 ---------- */

  // input: {cumIncome, cumDeduction5000, cumSocialPersonal, cumExtraDeduction, cumOther, cumTaxPaid}（分）
  function calcTax(input) {
    input = input || {};
    var taxable = (input.cumIncome || 0) - (input.cumDeduction5000 || 0) -
      (input.cumSocialPersonal || 0) - (input.cumExtraDeduction || 0) - (input.cumOther || 0);
    taxable = Math.round(taxable);
    if (taxable <= 0) return { taxable: 0, rate: 0, quickDeduction: 0, taxPayable: 0 };
    var taxableYuan = taxable / 100; // 税率表限额是元，应纳税所得额是分，先换元找档
    var br = T().iit.brackets;
    for (var i = 0; i < br.length; i++) {
      if (taxableYuan <= br[i][0]) {
        var taxCum = Math.round(taxable * br[i][1] - br[i][2] * 100); // 速算扣除数为元 → 分
        var payable = taxCum - (input.cumTaxPaid || 0);
        if (payable < 0) payable = 0;
        return { taxable: taxable, rate: br[i][1], quickDeduction: br[i][2] * 100, taxPayable: payable };
      }
    }
  }

  // 某员工某期间的累计口径个税：本年已计提工资单逐月累计 + 本期
  function calcMonthlyTax(staffId, period, monthGross) {
    var staff = getStaff(staffId);
    if (!staff) return fail('员工“' + staffId + '”不存在');
    period = period || currentPeriod();
    var gross = monthGross === undefined ? getStaffPay(staffId) : monthGross;
    var soc = calcSocial(gross);
    var prior = priorRecords(staffId, period);
    var months = prior.length + 1;
    var cumIncome = prior.reduce(function (s, p) { return s + p.gross; }, 0) + gross;
    var cumDed = T().iit.basicDeductionMonthly * 100 * months;
    var cumSoc = prior.reduce(function (s, p) { return s + p.social + p.fund; }, 0) + soc.personal.pension + soc.personal.medical + soc.personal.unemployment + soc.personal.fund;
    var cumExtra = prior.reduce(function (s, p) { return s + p.extra; }, 0) + extraMonthly(staff);
    var cumPaid = prior.reduce(function (s, p) { return s + p.tax; }, 0);
    var t = calcTax({ cumIncome: cumIncome, cumDeduction5000: cumDed, cumSocialPersonal: cumSoc, cumExtraDeduction: cumExtra, cumTaxPaid: cumPaid });
    t.months = months;
    t.cumIncome = cumIncome;
    t.cumDeduction5000 = cumDed;
    t.cumSocialPersonal = cumSoc;
    t.cumExtraDeduction = cumExtra;
    return t;
  }

  /* 年终奖单独计税（只做计算，不出界面）：÷12 找按月换算税率表，至 2027-12-31 */
  function calcBonusTax(bonusCents, date) {
    if (typeof bonusCents !== 'number' || !isFinite(bonusCents) || bonusCents <= 0)
      return fail('年终奖金额必须是大于 0 的整数分');
    var d = date || (currentPeriod() + '-28');
    var until = T().iit.annualBonusSeparateUntil;
    if (d > until) return fail('年终奖单独计税政策执行至 ' + until + '，' + d + ' 起并入综合所得计税');
    var monthlyYuan = bonusCents / 1200; // ÷12（分 → 元）
    var br = T().iit.monthlyBrackets;
    for (var i = 0; i < br.length; i++) {
      if (monthlyYuan <= br[i][0]) {
        var tax = Math.round(bonusCents * br[i][1] - br[i][2] * 100);
        return { ok: true, bonus: bonusCents, monthlyYuan: monthlyYuan, rate: br[i][1], quickDeduction: br[i][2] * 100, tax: Math.max(0, tax) };
      }
    }
  }

  /* ---------- 工资单与凭证 ---------- */

  function records(period) {
    return (S().get('payrolls') || []).filter(function (p) { return p.period === period; });
  }

  function priorRecords(staffId, period) {
    return (S().get('payrolls') || []).filter(function (p) {
      return p.staffId === staffId && p.period < period && p.period.slice(0, 4) === period.slice(0, 4);
    });
  }

  function list(period) { return period ? records(period) : (S().get('payrolls') || []); }

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

  // 部门 → [工资科目, 社保科目, 公积金科目]（均末级、带部门辅助核算）
  function deptExpense(dept) {
    if (dept === 'D06') return ['4101', '4101', '4101'];                    // 生产/仓储 → 制造费用
    if (['D08', 'D09', 'D10', 'D11'].indexOf(dept) >= 0) return ['520101', '520107', '520108']; // 销售
    return ['530101', '530110', '530111'];                                  // 管理
  }

  /* 计提本月工资：生成工资单 + 计提凭证（借费用、贷 221101/221102/221103，含单位社保公积金） */
  function accrue(period) {
    period = period || currentPeriod();
    if (!/^\d{4}-\d{2}$/.test(period)) return fail('会计期间格式不正确，应为 2026-11');
    if (period !== currentPeriod()) return fail('只能计提当前会计期间（' + currentPeriod() + '）的工资');
    if (root.FMClosing && root.FMClosing.isClosed(period)) return fail('会计期间 ' + period + ' 已结账，不能计提工资');
    if (records(period).length) return fail('本期工资已计提，不能重复计提');

    var staff = staffList();
    if (!staff.length) return fail('没有员工档案，无法计提工资');
    var grossByDept = {}, socialByDept = {}, fundByDept = {};
    var recs = [], rows = [];
    var totalGross = 0, totalTax = 0, totalNet = 0, totalExtra = 0;
    var totalSocialP = 0, totalFundP = 0, totalSocialC = 0, totalFundC = 0;

    staff.forEach(function (st) {
      var gross = getStaffPay(st.id);
      var soc = calcSocial(gross);
      var social = soc.personal.pension + soc.personal.medical + soc.personal.unemployment; // 个人三险
      var fund = soc.personal.fund;
      var extra = extraMonthly(st);
      var prior = priorRecords(st.id, period);
      var months = prior.length + 1;
      var cumIncome = prior.reduce(function (s, p) { return s + p.gross; }, 0) + gross;
      var cumDed = T().iit.basicDeductionMonthly * 100 * months;
      var cumSoc = prior.reduce(function (s, p) { return s + p.social + p.fund; }, 0) + social + fund;
      var cumExtra = prior.reduce(function (s, p) { return s + p.extra; }, 0) + extra;
      var cumPaid = prior.reduce(function (s, p) { return s + p.tax; }, 0);
      var t = calcTax({ cumIncome: cumIncome, cumDeduction5000: cumDed, cumSocialPersonal: cumSoc, cumExtraDeduction: cumExtra, cumTaxPaid: cumPaid });
      var net = gross - social - fund - t.taxPayable;
      recs.push({
        id: 'PAY-' + period + '-' + st.id, staffId: st.id, name: st.name, dept: st.dept, title: st.title,
        period: period, gross: gross, social: social, fund: fund, extra: extra,
        taxable: t.taxable, rate: t.rate, quick: t.quickDeduction, tax: t.taxPayable, net: net,
        status: '已计提', payDate: ''
      });
      grossByDept[st.dept] = (grossByDept[st.dept] || 0) + gross;
      socialByDept[st.dept] = (socialByDept[st.dept] || 0) + soc.company.pension + soc.company.medical + soc.company.unemployment + soc.company.injury + soc.company.maternity;
      fundByDept[st.dept] = (fundByDept[st.dept] || 0) + soc.company.fund;
      totalGross += gross; totalTax += t.taxPayable; totalNet += net; totalExtra += extra;
      totalSocialP += social; totalFundP += fund;
      totalSocialC += soc.company.pension + soc.company.medical + soc.company.unemployment + soc.company.injury + soc.company.maternity;
      totalFundC += soc.company.fund;
    });

    Object.keys(grossByDept).forEach(function (dept) {
      rows.push({ accountCode: deptExpense(dept)[0], summary: '计提工资 ' + dept, debit: grossByDept[dept], aux: { dept: dept } });
    });
    Object.keys(socialByDept).forEach(function (dept) {
      rows.push({ accountCode: deptExpense(dept)[1], summary: '单位社会保险费 ' + dept, debit: socialByDept[dept], aux: { dept: dept } });
    });
    Object.keys(fundByDept).forEach(function (dept) {
      rows.push({ accountCode: deptExpense(dept)[2], summary: '单位住房公积金 ' + dept, debit: fundByDept[dept], aux: { dept: dept } });
    });
    rows.push({ accountCode: '221101', summary: '应付职工薪酬-工资', credit: totalGross });
    if (totalSocialC > 0) rows.push({ accountCode: '221102', summary: '单位社会保险费', credit: totalSocialC });
    if (totalFundC > 0) rows.push({ accountCode: '221103', summary: '单位住房公积金', credit: totalFundC });

    var marker = '计提 ' + period + ' 工资';
    var res = postVoucher(lastDay(period), marker, '系统薪酬', rows);
    if (!res.ok) return fail('计提工资失败：' + res.reason);
    S().set('payrolls', (S().get('payrolls') || []).concat(recs));
    S().log('计提工资', res.id, marker + '，应发 ' + S().fmt(totalGross) + '，个税 ' + S().fmt(totalTax));
    return {
      ok: true, id: res.id, count: recs.length,
      totalGross: totalGross, totalTax: totalTax, totalNet: totalNet, totalExtra: totalExtra,
      totalSocialPersonal: totalSocialP, totalFundPersonal: totalFundP,
      totalSocialCompany: totalSocialC, totalFundCompany: totalFundC, voucher: res.voucher
    };
  }

  /* 发放本月工资：借 221101，贷 100201 实发 / 222104 个税 / 221102 个人社保 / 221103 个人公积金 */
  function pay(period) {
    period = period || currentPeriod();
    if (!/^\d{4}-\d{2}$/.test(period)) return fail('会计期间格式不正确，应为 2026-11');
    if (period !== currentPeriod()) return fail('只能发放当前会计期间（' + currentPeriod() + '）的工资');
    if (root.FMClosing && root.FMClosing.isClosed(period)) return fail('会计期间 ' + period + ' 已结账，不能发放工资');
    var recs = records(period);
    if (!recs.length) return fail('本期工资未计提，不能发放');
    if (recs.some(function (r) { return r.status === '已发放'; })) return fail('本期工资已发放，不能重复发放');

    var totalGross = 0, totalNet = 0, totalTax = 0, totalSocial = 0, totalFund = 0;
    recs.forEach(function (r) {
      totalGross += r.gross; totalNet += r.net; totalTax += r.tax;
      totalSocial += r.social; totalFund += r.fund;
    });
    var rows = [{ accountCode: '221101', summary: '发放 ' + period + ' 工资', debit: totalGross }];
    if (totalNet > 0) rows.push({ accountCode: '100201', summary: '银行代发工资', credit: totalNet });
    if (totalTax > 0) rows.push({ accountCode: '222104', summary: '代扣个人所得税', credit: totalTax });
    if (totalSocial > 0) rows.push({ accountCode: '221102', summary: '代扣个人社会保险费', credit: totalSocial });
    if (totalFund > 0) rows.push({ accountCode: '221103', summary: '代扣个人住房公积金', credit: totalFund });
    var res = postVoucher(lastDay(period), '发放 ' + period + ' 工资', '系统薪酬', rows);
    if (!res.ok) return fail('发放工资失败：' + res.reason);
    var all = S().get('payrolls') || [];
    var day = lastDay(period);
    all.forEach(function (r) {
      if (r.period === period) { r.status = '已发放'; r.payDate = day; }
    });
    S().set('payrolls', all);
    S().log('发放工资', res.id, '应发 ' + S().fmt(totalGross) + '，实发 ' + S().fmt(totalNet));
    return { ok: true, id: res.id, totalGross: totalGross, totalNet: totalNet, totalTax: totalTax, totalSocial: totalSocial, totalFund: totalFund, voucher: res.voucher };
  }

  /* ---------- 渲染 ---------- */

  var P = { period: '' };

  function renderPayroll(el) {
    var esc = S().esc, fmt = S().fmt;
    if (!P.period) P.period = currentPeriod();
    var recs = records(P.period);
    var accrued = recs.length > 0;
    var paid = recs.length > 0 && recs.every(function (r) { return r.status === '已发放'; });

    var html = '<div class="page-head"><h2>薪酬工资</h2><div class="page-actions">' +
      '<button class="btn btn-primary" data-action="accrue"' + (accrued ? ' disabled' : '') + '>计提本月工资</button>' +
      '　<button class="btn btn-primary" data-action="pay"' + (!accrued || paid ? ' disabled' : '') + '>发放本月工资</button></div></div>';

    if (!accrued) {
      html += '<div class="notice ok">期间 ' + esc(P.period) + ' 未计提。员工名册与月薪标准如下：</div>';
      html += '<table class="grid"><thead><tr><th style="width:80px">工号</th><th>姓名</th><th style="width:110px">部门</th>' +
        '<th style="width:130px">职务</th><th class="num" style="width:130px">月薪标准</th>' +
        '<th class="num" style="width:130px">专项附加扣除（元/月）</th></tr></thead><tbody>';
      staffList().forEach(function (st) {
        html += '<tr><td class="mono">' + esc(st.id) + '</td><td>' + esc(st.name) + '</td>' +
          '<td>' + esc(st.dept) + '</td><td>' + esc(st.title) + '</td>' +
          '<td class="num">' + fmt(getStaffPay(st.id)) + '</td>' +
          '<td class="num">' + (extraMonthly(st) ? fmt(extraMonthly(st)) : '') + '</td></tr>';
      });
      html += '</tbody></table>';
      el.innerHTML = html;
    } else {
      var tG = recs.reduce(function (s, r) { return s + r.gross; }, 0);
      var tT = recs.reduce(function (s, r) { return s + r.tax; }, 0);
      var tN = recs.reduce(function (s, r) { return s + r.net; }, 0);
      var soc = recs.reduce(function (s, r) { return s + r.social; }, 0);
      var fund = recs.reduce(function (s, r) { return s + r.fund; }, 0);
      var companySoc = recs.reduce(function (s, r) {
        var c = calcSocial(r.gross).company;
        return s + c.pension + c.medical + c.unemployment + c.injury + c.maternity;
      }, 0);
      var companyFund = recs.reduce(function (s, r) { return s + calcSocial(r.gross).company.fund; }, 0);

      html += '<div class="cards"><div class="card"><div class="card-label">应发合计</div><div class="card-num num">' + fmt(tG) + '</div></div>' +
        '<div class="card"><div class="card-label">个人社保+公积金</div><div class="card-num num">' + fmt(soc + fund) + '</div></div>' +
        '<div class="card"><div class="card-label">个税合计</div><div class="card-num num">' + fmt(tT) + '</div></div>' +
        '<div class="card"><div class="card-label">实发合计</div><div class="card-num num">' + fmt(tN) + '</div></div></div>';

      html += '<table class="grid"><thead><tr><th style="width:80px">工号</th><th>姓名</th><th style="width:80px">部门</th>' +
        '<th class="num" style="width:110px">应发</th><th class="num" style="width:100px">个人社保</th>' +
        '<th class="num" style="width:100px">公积金</th><th class="num" style="width:100px">专项附加</th>' +
        '<th class="num" style="width:100px">个税</th><th class="num" style="width:120px">实发</th>' +
        '<th class="center" style="width:70px">状态</th></tr></thead><tbody>';
      recs.forEach(function (r) {
        html += '<tr><td class="mono">' + esc(r.staffId) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.dept) + '</td>' +
          '<td class="num">' + fmt(r.gross) + '</td><td class="num">' + fmt(r.social) + '</td>' +
          '<td class="num">' + fmt(r.fund) + '</td><td class="num">' + (r.extra ? fmt(r.extra) : '') + '</td>' +
          '<td class="num">' + (r.tax ? fmt(r.tax) : '') + '</td><td class="num"><b>' + fmt(r.net) + '</b></td>' +
          '<td class="center">' + esc(r.status) + '</td></tr>';
      });
      html += '</tbody></table>';

      /* 个税明细（累计口径展开） */
      html += '<h3 class="sec-title">个税明细（累计预扣法，' + esc(P.period) + '）</h3>';
      html += '<table class="grid"><thead><tr><th>姓名</th><th class="num">累计收入</th><th class="num">减除费用</th>' +
        '<th class="num">累计专项扣除</th><th class="num">累计专项附加</th><th class="num">应纳税所得额</th>' +
        '<th class="center">预扣率</th><th class="num">速算扣除</th><th class="num">本期个税</th></tr></thead><tbody>';
      recs.forEach(function (r) {
        var prior = priorRecords(r.staffId, P.period);
        var months = prior.length + 1;
        var cumIncome = prior.reduce(function (s, p) { return s + p.gross; }, 0) + r.gross;
        var cumDed = T().iit.basicDeductionMonthly * 100 * months;
        var cumSoc = prior.reduce(function (s, p) { return s + p.social + p.fund; }, 0) + r.social + r.fund;
        var cumExtra = prior.reduce(function (s, p) { return s + p.extra; }, 0) + r.extra;
        var ratePct = (r.rate * 100).toFixed(1).replace(/\.0$/, '') + '%';
        html += '<tr><td>' + esc(r.name) + '</td><td class="num">' + fmt(cumIncome) + '</td>' +
          '<td class="num">' + fmt(cumDed) + '</td><td class="num">' + fmt(cumSoc) + '</td>' +
          '<td class="num">' + (cumExtra ? fmt(cumExtra) : '') + '</td><td class="num">' + fmt(r.taxable) + '</td>' +
          '<td class="center">' + ratePct + '</td><td class="num">' + (r.rate && r.quick ? fmt(r.quick) : '') + '</td>' +
          '<td class="num">' + (r.tax ? fmt(r.tax) : '0') + '</td></tr>';
      });
      html += '</tbody></table>';

      /* 五险一金汇总 */
      html += '<h3 class="sec-title">五险一金汇总</h3><table class="grid"><thead><tr>' +
        '<th></th><th class="num">养老</th><th class="num">医疗</th><th class="num">失业</th><th class="num">工伤</th>' +
        '<th class="num">生育</th><th class="num">公积金</th><th class="num">合计</th></tr></thead><tbody>';
      function rateRow(label, key) {
        var cells = ['pension', 'medical', 'unemployment', 'injury', 'maternity', 'fund'].map(function (k) {
          var v = recs.reduce(function (s, r) {
            var c = calcSocial(r.gross);
            return s + ((c[key] && c[key][k]) || 0);
          }, 0);
          return '<td class="num">' + (v ? fmt(v) : '—') + '</td>';
        }).join('');
        return '<tr><td>' + label + '</td>' + cells + '</tr>';
      }
      html += '<tr><td>个人合计</td><td class="num">' + fmt(recs.reduce(function (s, r) { return s + calcSocial(r.gross).personal.pension; }, 0)) + '</td>' +
        '<td class="num">' + fmt(recs.reduce(function (s, r) { return s + calcSocial(r.gross).personal.medical; }, 0)) + '</td>' +
        '<td class="num">' + fmt(recs.reduce(function (s, r) { return s + calcSocial(r.gross).personal.unemployment; }, 0)) + '</td>' +
        '<td>—</td><td>—</td>' +
        '<td class="num">' + fmt(fund) + '</td><td class="num"><b>' + fmt(soc + fund) + '</b></td></tr>';
      html += rateRow('单位合计', 'company');
      html += '</tbody></table>';
      el.innerHTML = html;
    }

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      var act = t.dataset.action;
      if (act === 'accrue') {
        var r1 = accrue(P.period);
        root.FMToast(r1.ok ? '已计提' + (r1.id ? '：' + r1.id : '') + '，应发 ' + fmt(r1.totalGross) : r1.reason, r1.ok ? 'ok' : 'bad');
        if (r1.ok) renderPayroll(el);
      } else if (act === 'pay') {
        var r2 = pay(P.period);
        root.FMToast(r2.ok ? '已发放' + (r2.id ? '：' + r2.id : '') + '，实发 ' + fmt(r2.totalNet) : r2.reason, r2.ok ? 'ok' : 'bad');
        if (r2.ok) renderPayroll(el);
      }
    };
  }

  root.FMPayroll = {
    list: list, getStaffPay: getStaffPay, calcSocial: calcSocial, calcTax: calcTax,
    calcMonthlyTax: calcMonthlyTax, calcBonusTax: calcBonusTax, extraMonthly: extraMonthly,
    accrue: accrue, pay: pay, renderPayroll: renderPayroll
  };
})(typeof window !== 'undefined' ? window : globalThis);
