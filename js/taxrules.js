/* 财务管理系统 · 2026 年财税规则参数表
 * 口径来源：项目根目录 TAX_RULES_2026.md（唯一口径）。
 * 所有税率 / 扣除标准只允许写在这个文件里，其他模块一律从 window.FMTax 取，不得硬编码。
 * 政策调整时只改这里。
 */
(function (root) {
  'use strict';

  var FMTax = {
    // 1. 增值税（《增值税法》2026-01-01 施行）
    vat: {
      generalRates: { goods: 0.13, transport: 0.09, service: 0.06 },
      // 税目 → 税率档的归类（一般纳税人）
      categoryNames: {
        goods: '销售货物、加工修理修配劳务',
        transport: '交通运输、邮政、基础电信、建筑、不动产租赁、转让土地使用权',
        service: '销售服务、无形资产（除前述）'
      },
      smallScale: { levy: 0.03, reduced: 0.01, reducedFrom: '2026-01-01', reducedUntil: '2027-12-31', exemptMonthly: 150000, exemptQuarterly: 450000 },
      // 一般纳税人可选的简易计税征收率
      simplified: { standard: 0.03, realEstate: 0.05 },
      threshold: 5000000
    },
    // 2. 企业所得税（小微优惠执行至 2027-12-31）
    cit: {
      rate: 0.25,
      highTech: 0.15,
      smallProfit: { incomeLimit: 3000000, staffLimit: 300, assetsLimit: 50000000, includeRate: 0.25, rate: 0.20, until: '2027-12-31' }
    },
    // 3. 个人所得税（工资薪金，累计预扣法）
    iit: {
      basicDeductionMonthly: 5000,
      // [累计应纳税所得额上限, 预扣率, 速算扣除数]
      brackets: [[36000, 0.03, 0], [144000, 0.10, 2520], [300000, 0.20, 16920], [420000, 0.25, 31920],
        [660000, 0.30, 52920], [960000, 0.35, 85920], [Infinity, 0.45, 181920]],
      // 年终奖单独计税：按月换算后的月度税率表（元）
      monthlyBrackets: [[3000, 0.03, 0], [12000, 0.10, 210], [25000, 0.20, 1410], [35000, 0.25, 2660],
        [55000, 0.30, 4410], [80000, 0.35, 7160], [Infinity, 0.45, 15160]],
      specialDeductions: {
        childEdu: 2000,          // 子女教育：每个子女每月
        infantCare: 2000,        // 3 岁以下婴幼儿照护：每个婴幼儿每月
        degreeEdu: 400,          // 继续教育（学历）：每月，同一学历最长 48 个月
        degreeEduMaxMonths: 48,
        certEdu: 3600,           // 继续教育（职业资格证书）：取得当年
        housingLoan: 1000,       // 首套住房贷款利息：每月，最长 240 个月
        housingLoanMaxMonths: 240,
        rent: { tier1: 1500, tier2: 1100, tier3: 800 }, // 直辖市 / 省会 / 其他城市
        elderly: { onlyChild: 3000, sharedMax: 1500 },  // 赡养老人：独生子女 / 非独生每人上限
        medical: { threshold: 15000, cap: 80000 }       // 大病医疗：仅汇算清缴时扣
      },
      settlement: { from: '03-01', to: '06-30', exemptIncome: 120000, exemptTax: 400 },
      annualBonusSeparateUntil: '2027-12-31'
    },
    // 4. 城建税、教育费附加、地方教育附加（计税依据：实际缴纳的增值税 + 消费税）
    surtax: { urban: 0.07, county: 0.05, other: 0.01, edu: 0.03, localEdu: 0.02 },
    sixTaxTwoFeeHalfUntil: '2027-12-31',
    // 5. 社会保险与住房公积金（简化费率，可按当地政策调整；缴费基数=应发工资，
    //    封顶=当地社平工资×baseCapMultiple，本系统只留参数不做封顶校验）
    social: {
      pension: { personal: 0.08, company: 0.16 },
      medical: { personal: 0.02, company: 0.08 },
      unemployment: { personal: 0.005, company: 0.005 },
      injury: { company: 0.005 },
      maternity: { company: 0.008 },
      housingFund: { personal: 0.12, company: 0.12 },
      baseCapMultiple: 3
    },
    // 6. 固定资产折旧（最低年限，年）与默认残值率
    depreciation: { building: 20, machinery: 10, vehicle: 4, electronic: 3, residualRate: 0.05 },
    // 印花税
    stampDuty: { saleContract: 0.0003, loanContract: 0.00005, accountBook: 0.00025 }
  };

  // 小型微利企业判断：三个条件同时满足（且不属于限制、禁止行业）
  FMTax.isSmallProfit = function (p) {
    p = p || {};
    if (p.restrictedIndustry) return false;
    var s = FMTax.cit.smallProfit;
    var income = Number(p.taxableIncome), staff = Number(p.staffCount), assets = Number(p.totalAssets);
    if (!isFinite(income) || !isFinite(staff) || !isFinite(assets)) return false;
    if (p.taxableIncome === null || p.staffCount === null || p.totalAssets === null) return false;
    return income <= s.incomeLimit && staff <= s.staffLimit && assets <= s.assetsLimit;
  };

  // 小微企业实际税负（25% 计入 × 20% 税率 = 5%）
  FMTax.smallProfitEffectiveRate = function () {
    var s = FMTax.cit.smallProfit;
    return Math.round(s.includeRate * s.rate * 10000) / 10000;
  };

  // 增值税适用税率 / 征收率。
  // taxpayerType: 'general' | '一般纳税人' | 'small' | '小规模纳税人'
  // category: 'goods' | 'transport' | 'service' | 'realEstate'（小规模销售/出租不动产、转让土地使用权，不享受减按 1%）
  // date: 'YYYY-MM-DD'，仅小规模用于判断 1% 优惠期，缺省为当天。无法识别返回 null。
  FMTax.vatRateFor = function (taxpayerType, category, date) {
    var vat = FMTax.vat;
    if (taxpayerType === 'general' || taxpayerType === '一般纳税人') {
      var r = vat.generalRates[category];
      return typeof r === 'number' ? r : null;
    }
    if (taxpayerType === 'small' || taxpayerType === '小规模纳税人') {
      if (category === 'realEstate') return vat.simplified.realEstate;
      var d = date || new Date().toISOString().slice(0, 10);
      return d >= vat.smallScale.reducedFrom && d <= vat.smallScale.reducedUntil ? vat.smallScale.reduced : vat.smallScale.levy;
    }
    return null;
  };

  root.FMTax = FMTax;
})(typeof window !== 'undefined' ? window : globalThis);
