/* 财务管理系统 · 财务报表（chunk 7）
 * window.FMReports = { balanceSheet, incomeStatement, cashFlow, renderReports }
 * 口径约定（与 V.trialBalance / A.balance / FMLedger / FMCashier 同口径）：
 * - 只读已过账凭证（status === '已过账'）；未审核、未过账不进报表。
 * - 报表是只读计算：不生成凭证、不改 state（除导出 CSV 下载外，不写 localStorage）。
 * - 金额一律整数"分"；显示用 FMStore.fmt()。
 * - 利润表 / 现金流量表按本期发生额取数，但剔除"结转本期损益"凭证（否则结账后损益科目
 *   发生额被结转凭证对冲，三表会全部归零）；资产负债表用 A.balance / 总账口径（含结转后余额），
 *   未分配利润 = 3103 本年利润期末余额 + 未结转损益净额（结账后后者为 0，即恰好 = 3103 期末余额）。
 * - 科目映射一律按 js/accounts.js 实际科目表（不猜编码）：
 *   货币资金 1001/1002、应收票据 1121、应收账款 1122、坏账准备 1231（减项）、预付 1123、
 *   其他应收 1221、存货 1401/1402/1403/1405/1408（减 1471）、固定资产净值 1601−1602（−1603）、
 *   无形资产净值 1701−1702（−1703）、长期待摊 1801；
 *   负债：短期借款 2001、应付票据 2201、应付账款 2202、预收 2203、应付职工薪酬 2211、
 *   应交税费 2221、其他应付款 2241；
 *   权益：实收资本 3001、资本公积 3002、盈余公积 3101、未分配利润 = 3103 本年利润 + 3104-未分配利润 310405
 *   （+未结转损益 − 4101 制造费用余额；4101 系生产部门期间费用，与利润表 / chunk 6 口径一致）+ 利润分配其余明细兑底；
 *   利润表：收入 6001、其他业务收入 6002/6051、成本 5001、税金及附加 5101、销售费用 5201、
 *   管理费用 5301、财务费用 5401、制造费用（费用化）4101、其他业务成本 5002/5411、
 *   营业外收入 6301、营业外支出 5421、所得税费用 5801/6801（两码并存，取发生额之和）。
 * - 现金及等价物 = 1001 库存现金 + 1002 银行存款（只算末级子目 1001/100201/100202）。
 * - 父科目不重复算：一律取末级科目余额之和（A.balance 按方向折算，父科目自身无余额）。
 */
(function (root) {
  'use strict';

  function S() { return root.FMStore; }
  function A() { return root.FMAccounts; }

  function currentPeriod() {
    var p = S().get('periods');
    return (p && p.current) || '';
  }

  /* ---------- 底层取数（全部已过账口径） ---------- */

  function isCarry(v) {
    return String(v.summary || '').indexOf('结转本期损益') === 0;
  }

  function voucherMap() {
    var m = {};
    (S().get('vouchers') || []).forEach(function (v) { m[v.id] = v; });
    return m;
  }

  // 本期已过账分录（excludeCarry=true 时剔除结转损益凭证）
  function postedEntries(period, excludeCarry) {
    period = period || currentPeriod();
    var vmap = voucherMap(), out = [];
    (S().get('entries') || []).forEach(function (e) {
      var v = vmap[e.voucherId];
      if (!v || v.period !== period || v.status !== '已过账') return;
      if (excludeCarry && isCarry(v)) return;
      out.push({ e: e, v: v });
    });
    return out;
  }

  // 按科目前缀汇总本期发生额 {debit, credit}（含下级，已过账）
  function activityByPrefix(prefixes, period, excludeCarry) {
    var debit = 0, credit = 0;
    postedEntries(period, excludeCarry).forEach(function (it) {
      var code = String(it.e.accountCode);
      for (var i = 0; i < prefixes.length; i++) {
        if (code.indexOf(prefixes[i]) === 0) {
          debit += it.e.debit || 0;
          credit += it.e.credit || 0;
          break;
        }
      }
    });
    return { debit: debit, credit: credit };
  }

  // 借向科目本期净额（借 − 贷）；贷向科目本期净额（贷 − 借）。自动按科目方向折算。
  function periodNet(prefixes, period) {
    var act = activityByPrefix(prefixes, period, true);
    var a = A().get(String(prefixes[0]).slice(0, 4));
    var borrow = !a || a.direction === '借';
    return borrow ? act.debit - act.credit : act.credit - act.debit;
  }

  // 某前缀下全部末级科目余额之和（按各自方向折算，父科目不重复算）
  function leafSum(prefixes, period) {
    var sum = 0;
    A().leaves().forEach(function (a) {
      var code = String(a.code);
      for (var i = 0; i < prefixes.length; i++) {
        if (code.indexOf(prefixes[i]) === 0) { sum += A().balance(code, period); break; }
      }
    });
    return sum;
  }

  function hasPrefix(code, prefixes) {
    code = String(code);
    for (var i = 0; i < prefixes.length; i++) if (code.indexOf(prefixes[i]) === 0) return true;
    return false;
  }

  // 某前缀下末级科目余额按自然方向净额：natural='借' → 借向为正、贷向（减项）为负；'贷' 反之。
  // 用于借/贷方向混合的科目组（如 2221 下借向的进项税额、转出未交增值税），保证净额口径正确。
  function leafNet(prefixes, period, natural) {
    var sum = 0;
    A().leaves().forEach(function (a) {
      var code = String(a.code);
      for (var i = 0; i < prefixes.length; i++) {
        if (code.indexOf(prefixes[i]) === 0) {
          var b = A().balance(code, period);
          sum += a.direction === natural ? b : -b;
          break;
        }
      }
    });
    return sum;
  }

  /* ---------- 资产负债表（时点表，期末数） ---------- */

  var BS_CURRENT_MAP = ['1001', '1002', '1121', '1122', '1231', '1123', '1221', '1401', '1402', '1403', '1405', '1408', '1471'];
  var BS_NONCURRENT_MAP = ['1601', '1602', '1603', '1701', '1702', '1703', '1801'];
  var BS_LIAB_MAP = ['2001', '2201', '2202', '2203', '2211', '2221', '2241'];

  function balanceSheet(period) {
    period = period || currentPeriod();

    // 未结转损益净额（利润方向）＝ 损益类末级科目当前余额 − 4101 制造费用余额。
    // 4101 在本系统是生产部门的期间费用（chunk 4 折旧、chunk 5 工资社保记 4101，系统没有
    // 成本结转步骤，结账也只结转损益类），与 chunk 6 FMTax.profitOfPeriod 的利润口径一致；
    // 不扣 4101 的话 pnlNet 会比 incomeStatement().profitBeforeTax 多一个制造费用，
    // 且 4101 又同时被列在资产行，两边各错一半、恰好抵消才显得平。借方余额为正 → 减去即扣费用。
    var pnlNet = 0;
    A().leaves().forEach(function (a) {
      if (a.category !== '损益') return;
      var bal = A().balance(a.code, period);
      pnlNet += a.direction === '贷' ? bal : -bal;
    });
    pnlNet -= A().balance('4101', period); // 制造费用（生产部门期间费用）按余额扣减，与利润表同口径

    function sumLines(lines) {
      return lines.reduce(function (s, l) { return s + l.amount; }, 0);
    }

    var assets = [
      { label: '货币资金', amount: leafNet(['1001', '1002'], period, '借') },
      { label: '应收票据', amount: leafNet(['1121'], period, '借') },
      { label: '应收账款', amount: leafNet(['1122'], period, '借') },
      { label: '坏账准备（减项）', amount: -leafNet(['1231'], period, '贷') },
      { label: '预付款项', amount: leafNet(['1123'], period, '借') },
      { label: '其他应收款', amount: leafNet(['1221'], period, '借') },
      { label: '存货', amount: leafNet(['1401', '1402', '1403', '1405', '1408'], period, '借') - leafNet(['1471'], period, '贷') },
      // 成本类科目兑底（4001 生产成本 / 4301 研发支出 / 4401 工程施工）。
      // 4101 制造费用不在此列：它是生产部门期间费用（chunk 4/5 口径），计入下方 pnlNet（权益侧），
      // 与利润表 / chunk 6 企业所得税口径一致。
      { label: '在产品及成本类科目', amount: leafNet(['4001', '4301', '4401'], period, '借') }
    ];
    var noncurrent = [
      { label: '固定资产净值', amount: leafNet(['1601'], period, '借') - leafNet(['1602'], period, '贷') - leafNet(['1603'], period, '贷') },
      { label: '无形资产净值', amount: leafNet(['1701'], period, '借') - leafNet(['1702'], period, '贷') - leafNet(['1703'], period, '贷') },
      { label: '长期待摊费用', amount: leafNet(['1801'], period, '借') }
    ];
    // 其余资产科目兜底归类（保证"资产总计 = 各资产项之和"且账实一致）
    var otherCur = 0, otherNon = 0;
    A().leaves().forEach(function (a) {
      if (a.category !== '资产') return;
      var code = String(a.code);
      if (hasPrefix(code, BS_CURRENT_MAP) || hasPrefix(code, BS_NONCURRENT_MAP)) return;
      var b1 = A().balance(code, period);
      if (code < '1500') otherCur += a.direction === '借' ? b1 : -b1;
      else otherNon += a.direction === '借' ? b1 : -b1;
    });
    assets.push({ label: '其他流动资产', amount: otherCur });
    noncurrent.push({ label: '其他非流动资产', amount: otherNon });
    assets = assets.concat(noncurrent);

    var liabilities = [
      { label: '短期借款', amount: leafNet(['2001'], period, '贷') },
      { label: '应付票据', amount: leafNet(['2201'], period, '贷') },
      { label: '应付账款', amount: leafNet(['2202'], period, '贷') },
      { label: '预收款项', amount: leafNet(['2203'], period, '贷') },
      { label: '应付职工薪酬', amount: leafNet(['2211'], period, '贷') },
      { label: '应交税费', amount: leafNet(['2221'], period, '贷') },
      { label: '其他应付款', amount: leafNet(['2241'], period, '贷') }
    ];
    var otherLiabCur = 0, otherLiabNon = 0;
    A().leaves().forEach(function (a) {
      if (a.category !== '负债') return;
      var code = String(a.code);
      if (hasPrefix(code, BS_LIAB_MAP)) return;
      var b2 = A().balance(code, period);
      if (code < '2401') otherLiabCur += a.direction === '贷' ? b2 : -b2;
      else otherLiabNon += a.direction === '贷' ? b2 : -b2;
    });
    liabilities.push({ label: '其他流动负债', amount: otherLiabCur });
    liabilities.push({ label: '非流动负债', amount: otherLiabNon });

    var equity = [
      { label: '实收资本', amount: leafNet(['3001'], period, '贷') },
      { label: '资本公积', amount: leafNet(['3002'], period, '贷') },
      { label: '盈余公积', amount: leafNet(['3101'], period, '贷') },
      { label: '未分配利润', amount: A().balance('3103', period) + A().balance('310405', period) + pnlNet,
        note: pnlNet ? '（含未结转损益及制造费用调整 ' + S().fmt(pnlNet) + '）' : '' }
    ];

    var otherEquity = 0;
    A().leaves().forEach(function (a) {
      if (a.category !== '所有者权益') return;
      var code = String(a.code);
      if (code === '3001' || code === '3002' || code.indexOf('3101') === 0 ||
        code === '3103' || code.indexOf('310405') === 0) return;
      otherEquity += A().balance(code, period);
    });
    if (otherEquity !== 0) equity.push({ label: '其他权益（利润分配）', amount: otherEquity });

    var totalAssets = sumLines(assets);
    var totalLiabilities = sumLines(liabilities);
    var totalEquity = sumLines(equity);
    var diff = totalAssets - (totalLiabilities + totalEquity);
    return {
      period: period, assets: assets, liabilities: liabilities, equity: equity,
      totalAssets: totalAssets, totalLiabilities: totalLiabilities, totalEquity: totalEquity,
      totalLiabEquity: totalLiabilities + totalEquity,
      diff: diff, balanced: Math.abs(diff) <= 1, pnlNet: pnlNet,
      reason: Math.abs(diff) <= 1 ? '' :
        '资产负债表不平：资产总计 ' + S().fmt(totalAssets) + ' ≠ 负债 + 权益 ' + S().fmt(totalLiabilities + totalEquity) +
        '，差额 ' + S().fmt(Math.abs(diff)) + ' 分。请检查期初试算与已过账凭证是否平衡（报表不平不允许硬凑）'
    };
  }

  /* ---------- 利润表（期间表，本期数，剔除结转损益凭证） ---------- */

  function incomeStatement(period) {
    period = period || currentPeriod();
    var revenue = periodNet(['6001'], period);
    var otherOperatingIncome = periodNet(['6002', '6051'], period);
    var cost = periodNet(['5001'], period);
    var manufacturingExpense = periodNet(['4101'], period); // 生产/仓储部门期间费用（chunk 4/5 口径）
    var taxes = periodNet(['5101'], period);
    var salesExpense = periodNet(['5201'], period);
    var adminExpense = periodNet(['5301'], period);
    var financeExpense = periodNet(['5401'], period);
    var otherOperatingExpense = periodNet(['5002', '5411'], period);
    var operatingProfit = revenue + otherOperatingIncome - cost - manufacturingExpense -
      taxes - salesExpense - adminExpense - financeExpense - otherOperatingExpense;
    var nonOperatingIncome = periodNet(['6301'], period);
    var nonOperatingExpense = periodNet(['5421'], period);
    var nonOperatingNet = nonOperatingIncome - nonOperatingExpense;
    var profitBeforeTax = operatingProfit + nonOperatingNet;
    var incomeTax = periodNet(['5801'], period) + periodNet(['6801'], period); // 两码并存，取发生额之和
    var netProfit = profitBeforeTax - incomeTax;
    return {
      period: period, revenue: revenue, otherOperatingIncome: otherOperatingIncome,
      cost: cost, manufacturingExpense: manufacturingExpense, taxes: taxes,
      salesExpense: salesExpense, adminExpense: adminExpense, financeExpense: financeExpense,
      otherOperatingExpense: otherOperatingExpense, operatingProfit: operatingProfit,
      nonOperatingIncome: nonOperatingIncome, nonOperatingExpense: nonOperatingExpense,
      nonOperatingNet: nonOperatingNet, profitBeforeTax: profitBeforeTax,
      incomeTax: incomeTax, netProfit: netProfit
    };
  }

  /* ---------- 现金流量表（期间表，本期数，直接法） ---------- */

  var CASH_CODES = ['1001', '100201', '100202']; // 1001 库存现金 + 1002 银行存款末级子目

  var FIN_PREFIX = ['3001', '3002', '2001', '2501', '2502', '2231', '2232', '3104']; // 筹资：增资/借款还款/利息股利
  var INV_PREFIX = ['1601', '1604', '1605', '1606', '1701', '1702', '1501', '1511', '1521', '1101']; // 投资：长期资产购建处置
  var SALE_IN = ['6001', '6002', '6051', '1122', '1121', '2203'];     // 销售收现（含收回应收、预收）
  var STAFF_OUT = ['2211'];                                          // 支付职工（工资 221101 + 社保公积金）
  var TAX_OUT = ['222102', '222103', '222104', '222105', '222106', '222107', '222108', '5101']; // 缴纳税费
  var PURCHASE_OUT = ['1401', '1402', '1403', '1405', '1408', '1411', '2202', '2203', '1123', '5001']; // 购买商品/接受劳务

  function cashFlow(period) {
    period = period || currentPeriod();
    var vmap = voucherMap();
    var buckets = {
      operating: { in: 0, out: 0, inDetail: { sales: 0, other: 0 }, outDetail: { purchase: 0, staff: 0, tax: 0, other: 0 } },
      investing: { in: 0, out: 0, inDetail: { dispose: 0, other: 0 }, outDetail: { build: 0, other: 0 } },
      financing: { in: 0, out: 0, inDetail: { capital: 0, borrow: 0, other: 0 }, outDetail: { repay: 0, interestDividend: 0, other: 0 } }
    };
    var voucherNet = 0;

    (S().get('entries') || []).forEach(function (e) {
      var code = String(e.accountCode);
      if (!hasPrefix(code, CASH_CODES)) return;
      var v = vmap[e.voucherId];
      if (!v || v.period !== period || v.status !== '已过账' || isCarry(v)) return;
      var cashIn = e.debit || 0, cashOut = e.credit || 0;
      voucherNet += cashIn - cashOut;

      // 对方科目（本凭证内非现金分录）：分类依据
      var counters = [];
      (S().get('entries') || []).forEach(function (s) {
        if (s.voucherId === e.voucherId && !hasPrefix(String(s.accountCode), CASH_CODES)) counters.push(String(s.accountCode));
      });
      function counterHits(prefixes) {
        return counters.some(function (c) { return hasPrefix(c, prefixes); });
      }
      function counterExact(prefixes) {
        return counters.some(function (c) { return prefixes.indexOf(c) >= 0; });
      }

      var cat, sub;
      if (counterHits(FIN_PREFIX)) {
        cat = buckets.financing;
        if (cashIn > 0) {
          sub = counterHits(['3001', '3002']) ? 'capital' : (counterHits(['2001', '2501', '2502']) ? 'borrow' : 'other');
        } else {
          sub = counterHits(['2001', '2501', '2502']) ? 'repay' :
            (counterHits(['2231', '2232']) || counterExact(['310402']) ? 'interestDividend' : 'other');
        }
      } else if (counterHits(INV_PREFIX)) {
        cat = buckets.investing;
        if (cashIn > 0) sub = counterHits(['1606', '1701', '1702']) ? 'dispose' : 'other';
        else sub = counterHits(['1601', '1604', '1605', '1701']) ? 'build' : 'other';
      } else {
        cat = buckets.operating;
        if (cashIn > 0) {
          sub = counterHits(SALE_IN) ? 'sales' : 'other';
        } else {
          sub = counterHits(STAFF_OUT) ? 'staff' :
            (counterExact(TAX_OUT) || counterHits(['5101']) ? 'tax' :
              (counterHits(PURCHASE_OUT) ? 'purchase' : 'other'));
        }
      }
      if (cashIn > 0) {
        cat.in += cashIn;
        cat.inDetail[sub] += cashIn;
      }
      if (cashOut > 0) {
        cat.out += cashOut;
        cat.outDetail[sub] += cashOut;
      }
    });

    function net(b) { return b.in - b.out; }
    var op = buckets.operating, inv = buckets.investing, fin = buckets.financing;
    op.net = net(op); inv.net = net(inv); fin.net = net(fin);
    var netIncrease = op.net + inv.net + fin.net;

    // 期初现金 = 现金科目期初（含以前期间已过账净额，与总账同口径）
    var openingCash = 0;
    CASH_CODES.forEach(function (c) {
      var b = root.FMLedger && root.FMLedger.accountBalance(c, period);
      openingCash += b ? b.opening : 0;
    });
    var closingCash = openingCash + netIncrease;

    // 校验一：期末现金 = 资产负债表货币资金（差 ≤ 1 分算平）
    var bs = balanceSheet(period);
    var bsMoney = bs.assets[0].amount;
    var diffBS = closingCash - bsMoney;

    // 校验二（双源核对）：凭证分录现金发生额 vs 出纳日记账轧差
    var journalNet = 0;
    if (root.FMCashier) {
      CASH_CODES.forEach(function (c) {
        var j = root.FMCashier.journal(c, period);
        if (j) j.rows.forEach(function (r) { journalNet += (r.debit || 0) - (r.credit || 0); });
      });
    }

    return {
      period: period,
      operating: op, investing: inv, financing: fin,
      netIncrease: netIncrease, openingCash: openingCash, closingCash: closingCash,
      voucherNet: voucherNet,
      checkVsBalanceSheet: { balanceSheetAmount: bsMoney, diff: diffBS, balanced: Math.abs(diffBS) <= 1 },
      checkVsJournal: { voucherNet: voucherNet, journalNet: journalNet, match: voucherNet === journalNet },
      balanced: Math.abs(diffBS) <= 1 && voucherNet === journalNet
    };
  }

  /* ---------- CSV ---------- */

  function fmtYuan(cents) { return ((cents || 0) / 100).toFixed(2); }

  function bsCSV(period) {
    var bs = balanceSheet(period);
    var rows = [['资产负债表', bs.period, '单位：元'], ['项目', '期末余额']];
    bs.assets.forEach(function (l) { rows.push([l.label, fmtYuan(l.amount)]); });
    rows.push(['资产总计', fmtYuan(bs.totalAssets)]);
    bs.liabilities.forEach(function (l) { rows.push([l.label, fmtYuan(l.amount)]); });
    rows.push(['负债合计', fmtYuan(bs.totalLiabilities)]);
    bs.equity.forEach(function (l) { rows.push([l.label, fmtYuan(l.amount)]); });
    rows.push(['负债和所有者权益总计', fmtYuan(bs.totalLiabEquity)]);
    rows.push(['平衡校验（资产 − 负债 − 权益）', fmtYuan(bs.diff), bs.balanced ? '平衡' : '不平']);
    return { rows: rows, name: '资产负债表-' + bs.period + '.csv' };
  }

  function isCSV(period) {
    var inc = incomeStatement(period);
    var rows = [['利润表', inc.period, '单位：元'], ['项目', '本期金额']];
    rows.push(['一、营业收入', fmtYuan(inc.revenue)],
      ['　其他业务收益', fmtYuan(inc.otherOperatingIncome)],
      ['　营业成本', fmtYuan(inc.cost)],
      ['　制造费用（费用化）', fmtYuan(inc.manufacturingExpense)],
      ['　税金及附加', fmtYuan(inc.taxes)],
      ['　销售费用', fmtYuan(inc.salesExpense)],
      ['　管理费用', fmtYuan(inc.adminExpense)],
      ['　财务费用', fmtYuan(inc.financeExpense)],
      ['　其他业务成本及减值', fmtYuan(inc.otherOperatingExpense)],
      ['二、营业利润', fmtYuan(inc.operatingProfit)],
      ['加：营业外收入', fmtYuan(inc.nonOperatingIncome)],
      ['减：营业外支出', fmtYuan(inc.nonOperatingExpense)],
      ['三、利润总额', fmtYuan(inc.profitBeforeTax)],
      ['减：所得税费用', fmtYuan(inc.incomeTax)],
      ['四、净利润', fmtYuan(inc.netProfit)]);
    return { rows: rows, name: '利润表-' + inc.period + '.csv' };
  }

  function cfCSV(period) {
    var cf = cashFlow(period);
    var rows = [['现金流量表', cf.period, '单位：元'], ['项目', '本期金额']];
    rows.push(['一、经营活动产生的现金流量：', ''],
      ['　销售商品、提供劳务收到的现金', fmtYuan(cf.operating.inDetail.sales)],
      ['　收到其他与经营活动有关的现金', fmtYuan(cf.operating.inDetail.other)],
      ['　经营活动现金流入小计', fmtYuan(cf.operating.in)],
      ['　购买商品、接受劳务支付的现金', fmtYuan(cf.operating.outDetail.purchase)],
      ['　支付给职工以及为职工支付的现金', fmtYuan(cf.operating.outDetail.staff)],
      ['　支付的各项税费', fmtYuan(cf.operating.outDetail.tax)],
      ['　支付其他与经营活动有关的现金', fmtYuan(cf.operating.outDetail.other)],
      ['　经营活动现金流出小计', fmtYuan(cf.operating.out)],
      ['　经营活动产生的现金流量净额', fmtYuan(cf.operating.net)],
      ['二、投资活动产生的现金流量：', ''],
      ['　处置长期资产收回的现金净额', fmtYuan(cf.investing.inDetail.dispose)],
      ['　投资活动现金流入小计', fmtYuan(cf.investing.in)],
      ['　购建固定资产、无形资产支付的现金', fmtYuan(cf.investing.outDetail.build)],
      ['　投资活动现金流出小计', fmtYuan(cf.investing.out)],
      ['　投资活动产生的现金流量净额', fmtYuan(cf.investing.net)],
      ['三、筹资活动产生的现金流量：', ''],
      ['　吸收投资收到的现金', fmtYuan(cf.financing.inDetail.capital)],
      ['　取得借款收到的现金', fmtYuan(cf.financing.inDetail.borrow)],
      ['　筹资活动现金流入小计', fmtYuan(cf.financing.in)],
      ['　偿还债务支付的现金', fmtYuan(cf.financing.outDetail.repay)],
      ['　偿付利息、股利支付的现金', fmtYuan(cf.financing.outDetail.interestDividend)],
      ['　筹资活动现金流出小计', fmtYuan(cf.financing.out)],
      ['　筹资活动产生的现金流量净额', fmtYuan(cf.financing.net)],
      ['四、现金及现金等价物净增加额', fmtYuan(cf.netIncrease)],
      ['　加：期初现金及现金等价物余额', fmtYuan(cf.openingCash)],
      ['　期末现金及现金等价物余额', fmtYuan(cf.closingCash)],
      ['校验一：期末现金 − 资产负债表货币资金', fmtYuan(cf.checkVsBalanceSheet.diff), cf.checkVsBalanceSheet.balanced ? '平' : '不平'],
      ['校验二：凭证现金发生额 = 出纳日记账发生额', fmtYuan(cf.voucherNet), cf.checkVsJournal.match ? '一致' : '不一致']);
    return { rows: rows, name: '现金流量表-' + cf.period + '.csv' };
  }

  /* ---------- 渲染：三张表分页签 ---------- */

  var R = { tab: 'bs', period: '' };

  function numCell(v) {
    return '<td class="num">' + ((v || 0) === 0 ? '' : S().fmt(v)) + '</td>';
  }

  function renderReports(el) {
    var esc = S().esc, fmt = S().fmt;
    if (!R.period) R.period = currentPeriod();
    var html = '<div class="page-head"><h2>财务报表</h2><div class="page-actions">' +
      '<span class="muted">只读已过账凭证 · 不生成凭证、不改账</span></div></div>';
    html += '<div class="filter-bar">期间 <input id="fm-rep-period" class="input" style="width:100px" value="' + esc(R.period) + '">' +
      '　<button class="btn" data-action="filter">查询</button></div>';
    html += '<div class="tabs">' +
      [['bs', '资产负债表'], ['is', '利润表'], ['cf', '现金流量表']].map(function (t) {
        return '<button class="tab' + (R.tab === t[0] ? ' active' : '') + '" data-action="tab" data-tab="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div>';

    if (R.tab === 'bs') html += renderBS();
    else if (R.tab === 'is') html += renderIS();
    else html += renderCF();
    el.innerHTML = html;

    el.onclick = function (ev) {
      var t = ev && ev.target;
      while (t && t !== el && !(t.dataset && t.dataset.action)) t = t.parentNode;
      if (!t || t === el || !t.dataset) return;
      var act = t.dataset.action;
      if (act === 'tab') { R.tab = t.dataset.tab; renderReports(el); }
      else if (act === 'filter') {
        var p = document.getElementById('fm-rep-period');
        R.period = p ? p.value.trim() || currentPeriod() : currentPeriod();
        renderReports(el);
      } else if (act === 'export') {
        var out = R.tab === 'bs' ? bsCSV(R.period) : (R.tab === 'is' ? isCSV(R.period) : cfCSV(R.period));
        root.FMLedger.exportCSV(out.rows, out.name); // 复用总账导出（UTF-8 BOM，浏览器下载 / Node 返回字符串）
        if (root.FMToast) root.FMToast('已导出 ' + out.name, 'ok');
      }
    };
  }

  function renderBS() {
    var esc = S().esc, fmt = S().fmt;
    var bs = balanceSheet(R.period);
    var html = '<div class="notice ' + (bs.balanced ? 'ok' : 'bad') + '">平衡校验：资产总计 ' + fmt(bs.totalAssets) +
      (bs.balanced ? ' = 负债合计 ' + fmt(bs.totalLiabilities) + ' + 权益合计 ' + fmt(bs.totalEquity)
        : ' ≠ 负债 + 权益 ' + fmt(bs.totalLiabEquity) + '，差额 ' + fmt(Math.abs(bs.diff)) + ' 分（' + esc(bs.reason) + '）') + '</div>';
    html += '<table class="grid"><thead><tr><th>资产</th><th class="num" style="width:160px">期末余额</th></tr></thead><tbody>';
    bs.assets.forEach(function (l) {
      html += '<tr><td>' + esc(l.label) + '</td>' + numCell(l.amount) + '</tr>';
    });
    html += '<tr class="total-row"><td><b>资产总计</b></td><td class="num"><b>' + fmt(bs.totalAssets) + '</b></td></tr></tbody></table>';
    html += '<table class="grid" style="margin-top:16px"><thead><tr><th>负债及所有者权益</th><th class="num" style="width:160px">期末余额</th></tr></thead><tbody>';
    bs.liabilities.forEach(function (l) {
      html += '<tr><td>' + esc(l.label) + '</td>' + numCell(l.amount) + '</tr>';
    });
    html += '<tr class="total-row"><td><b>负债合计</b></td><td class="num"><b>' + fmt(bs.totalLiabilities) + '</b></td></tr>';
    bs.equity.forEach(function (l) {
      html += '<tr><td>' + esc(l.label) + (l.note ? '<span class="muted">' + esc(l.note) + '</span>' : '') + '</td>' + numCell(l.amount) + '</tr>';
    });
    html += '<tr class="total-row"><td><b>负债和所有者权益总计</b></td><td class="num"><b>' + fmt(bs.totalLiabEquity) + '</b></td></tr>';
    html += '</tbody></table>';
    html += '<div style="margin-top:12px"><button class="btn" data-action="export">导出 CSV</button></div>';
    return html;
  }

  function renderIS() {
    var esc = S().esc, fmt = S().fmt;
    var inc = incomeStatement(R.period);
    function row(label, v, bold) {
      return '<tr' + (bold ? ' class="total-row"' : '') + '><td>' + label + '</td>' + numCell(v) + '</tr>';
    }
    var html = '<table class="grid"><thead><tr><th>项目</th><th class="num" style="width:160px">本期金额</th></tr></thead><tbody>';
    html += row('一、营业收入', inc.revenue);
    html += row('　其他业务收益', inc.otherOperatingIncome);
    html += row('　减：营业成本', inc.cost);
    html += row('　减：制造费用（费用化）', inc.manufacturingExpense);
    html += row('　减：税金及附加', inc.taxes);
    html += row('　减：销售费用', inc.salesExpense);
    html += row('　减：管理费用', inc.adminExpense);
    html += row('　减：财务费用', inc.financeExpense);
    html += row('　减：其他业务成本及减值', inc.otherOperatingExpense);
    html += row('二、营业利润', inc.operatingProfit, true);
    html += row('加：营业外收入', inc.nonOperatingIncome);
    html += row('减：营业外支出', inc.nonOperatingExpense);
    html += row('三、利润总额', inc.profitBeforeTax, true);
    html += row('减：所得税费用', inc.incomeTax);
    html += row('四、净利润', inc.netProfit, true);
    html += '</tbody></table>';
    html += '<div class="muted" style="margin:8px 0">口径：本期已过账发生额（剔除“结转本期损益”凭证）；利润表取数不改变科目余额。</div>';
    html += '<div style="margin-top:12px"><button class="btn" data-action="export">导出 CSV</button></div>';
    return html;
  }

  function renderCF() {
    var esc = S().esc, fmt = S().fmt;
    var cf = cashFlow(R.period);
    var ok1 = cf.checkVsBalanceSheet.balanced, ok2 = cf.checkVsJournal.match;
    var html = '<div class="notice ' + (cf.balanced ? 'ok' : 'bad') + '">平衡校验：期末现金 ' + fmt(cf.closingCash) +
      (ok1 ? ' = 资产负债表货币资金 ' + fmt(cf.checkVsBalanceSheet.balanceSheetAmount)
        : ' ≠ 资产负债表货币资金 ' + fmt(cf.checkVsBalanceSheet.balanceSheetAmount) + '，差额 ' + fmt(Math.abs(cf.checkVsBalanceSheet.diff)) + ' 分') +
      '；凭证现金发生额与出纳日记账' + (ok2 ? '轧差一致' : '不一致（差 ' + fmt(Math.abs(cf.voucherNet - cf.checkVsJournal.journalNet)) + ' 分）') + '</div>';
    function row(label, v, bold) {
      return '<tr' + (bold ? ' class="total-row"' : '') + '><td>' + label + '</td>' + numCell(v) + '</tr>';
    }
    var html2 = '<table class="grid"><thead><tr><th>项目</th><th class="num" style="width:160px">本期金额</th></tr></thead><tbody>';
    var op = cf.operating, inv = cf.investing, fin = cf.financing;
    html2 += row('一、经营活动产生的现金流量：', 0);
    html2 += row('　销售商品、提供劳务收到的现金', op.inDetail.sales);
    html2 += row('　收到其他与经营活动有关的现金', op.inDetail.other);
    html2 += row('　经营活动现金流入小计', op.in);
    html2 += row('　购买商品、接受劳务支付的现金', op.outDetail.purchase);
    html2 += row('　支付给职工以及为职工支付的现金', op.outDetail.staff);
    html2 += row('　支付的各项税费', op.outDetail.tax);
    html2 += row('　支付其他与经营活动有关的现金', op.outDetail.other);
    html2 += row('　经营活动现金流出小计', op.out);
    html2 += row('　经营活动产生的现金流量净额', op.net, true);
    html2 += row('二、投资活动产生的现金流量：', 0);
    html2 += row('　处置固定资产、无形资产收回的现金净额', inv.inDetail.dispose);
    html2 += row('　投资活动现金流入小计', inv.in);
    html2 += row('　购建固定资产、无形资产和其他长期资产支付的现金', inv.outDetail.build);
    html2 += row('　投资活动现金流出小计', inv.out);
    html2 += row('　投资活动产生的现金流量净额', inv.net, true);
    html2 += row('三、筹资活动产生的现金流量：', 0);
    html2 += row('　吸收投资收到的现金', fin.inDetail.capital);
    html2 += row('　取得借款收到的现金', fin.inDetail.borrow);
    html2 += row('　筹资活动现金流入小计', fin.in);
    html2 += row('　偿还债务支付的现金', fin.outDetail.repay);
    html2 += row('　偿付利息、股利支付的现金', fin.outDetail.interestDividend);
    html2 += row('　筹资活动现金流出小计', fin.out);
    html2 += row('　筹资活动产生的现金流量净额', fin.net, true);
    html2 += row('四、现金及现金等价物净增加额', cf.netIncrease, true);
    html2 += row('　加：期初现金及现金等价物余额', cf.openingCash);
    html2 += row('　期末现金及现金等价物余额', cf.closingCash, true);
    html2 += '</tbody></table>';
    html += html2;
    html += '<div style="margin-top:12px"><button class="btn" data-action="export">导出 CSV</button></div>';
    return html;
  }

  root.FMReports = {
    balanceSheet: balanceSheet, incomeStatement: incomeStatement, cashFlow: cashFlow,
    renderReports: renderReports
  };
})(typeof window !== 'undefined' ? window : globalThis);
