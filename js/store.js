/* 财务管理系统 · 数据层
 * window.FMStore = {load, save, reset, seed, get, set, log, toCents, fmt, esc}
 * - localStorage 键 finance-manager-v1；localStorage 不可用（Node / 隐私模式）时退回内存。
 * - 金额一律用“分”（整数）存储，显示时用 fmt() 转元。
 * - get(key) 返回的是内存中的活引用，改完要调 save()（或直接用 set）。
 */
(function (root) {
  'use strict';

  var KEY = 'finance-manager-v1';
  var TOP_KEYS = ['company', 'periods', 'closedPeriods', 'accounts', 'vouchers', 'entries', 'departments', 'staff',
    'customers', 'suppliers', 'taxRecords', 'assets', 'payrolls', 'invoices', 'budgets', 'bankStatements', 'auditLog'];
  var state = null;
  var memory = null; // 内存兜底

  function storage() {
    try {
      if (root.localStorage && typeof root.localStorage.getItem === 'function') return root.localStorage;
    } catch (e) { /* 被禁用 */ }
    return null;
  }

  /* ---------- 金额工具：全程整数分，不做浮点运算 ---------- */

  // '1,234.56' / 1234.56 / '￥-12.3' → 分（整数）；非法（含超过两位小数）返回 null
  function toCents(v) {
    if (v === null || v === undefined) return null;
    var s = typeof v === 'number' ? (isFinite(v) ? v.toFixed(2) : '') : String(v);
    s = s.replace(/[,，\s￥¥]/g, '');
    if (s === '') return null;
    var m = /^([+-])?(\d*)(?:\.(\d{0,2}))?$/.exec(s);
    if (!m || (m[2] === '' && !m[3])) return null;
    var cents = parseInt(m[2] || '0', 10) * 100 + parseInt(((m[3] || '') + '00').slice(0, 2), 10);
    return m[1] === '-' ? -cents : cents;
  }

  // 分 → '1,234.56'
  function fmt(cents) {
    cents = Math.round(Number(cents) || 0);
    var neg = cents < 0;
    var abs = Math.abs(cents);
    var yuan = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var fen = ('0' + (abs % 100)).slice(-2);
    return (neg ? '-' : '') + yuan + '.' + fen;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 种子数据 ---------- */

  function Y(s) { return toCents(s); }

  // 期初余额（2026-10-31，按科目自身余额方向，单位元）。借方合计 = 贷方合计 = 26,757,350.50
  // chunk 4：1601/1602 期初与资产卡片合计一致，差额（资产净值 480.325 万）计入未分配利润 310405。
  var OPENING = {
    '1001': '38650.00',
    '100201': '4862300.50',
    '100202': '1250000.00',
    '1121': '300000.00',
    '1122': '3268400.00',
    '1123': '180000.00',
    '1221': '56000.00',
    '1231': '163420.00',
    '1405': '5640000.00',
    '1411': '42000.00',
    '1601': '10280000.00',
    '1602': '2753250.00',
    '1701': '480000.00',
    '1702': '144000.00',
    '1801': '360000.00',
    '2001': '2000000.00',
    '2202': '2845600.00',
    '2203': '220000.00',
    '221101': '986000.00',
    '221102': '268400.00',
    '221103': '98600.00',
    '222102': '186500.00',
    '222103': '142000.00',
    '222104': '23650.00',
    '222105': '13055.00',
    '222106': '5595.00',
    '222107': '3730.00',
    '2231': '7250.00',
    '2241': '85000.00',
    '3001': '10000000.00',
    '3002': '500000.00',
    '310101': '386000.00',
    '3103': '685200.00',
    '310405': '5240100.50'
  };

  // 往来科目期初余额按辅助项的明细（合计 = 科目期初）
  var OPENING_AUX = {
    '1122': [['customer', 'C001', '820000.00'], ['customer', 'C002', '1150000.00'], ['customer', 'C003', '368400.00'],
      ['customer', 'C004', '530000.00'], ['customer', 'C005', '400000.00']],
    '1121': [['customer', 'C006', '300000.00']],
    '1123': [['supplier', 'S005', '180000.00']],
    '1221': [['staff', 'E008', '30000.00'], ['staff', 'E012', '26000.00']],
    '2202': [['supplier', 'S001', '960000.00'], ['supplier', 'S002', '1085600.00'], ['supplier', 'S003', '500000.00'],
      ['supplier', 'S004', '300000.00']],
    '2203': [['customer', 'C007', '220000.00']]
  };

  function seedAccounts() {
    var chart = root.FMAccounts && root.FMAccounts.defaultChart ? root.FMAccounts.defaultChart() : [];
    return chart.map(function (a) {
      a.opening = OPENING[a.code] ? Y(OPENING[a.code]) : 0;
      if (OPENING_AUX[a.code]) {
        a.openingAux = OPENING_AUX[a.code].map(function (r) {
          var o = { amount: Y(r[2]) };
          o[r[0]] = r[1];
          return o;
        });
      }
      return a;
    });
  }

  /* chunk 4：固定资产卡片种子。已提月份按期初日（2026-10-31）倒算，直线法累计折旧；
   * Σ原值 = 1601 期初（10,280,000.00），Σ累计折旧 = 1602 期初（2,753,250.00）。 */
  function seedAssets() {
    var asOf = '2026-10';
    var defs = [
      // [名称, 类别, 购入日期, 原值(元), 年限(月), 残值率, 部门, 存放地点]
      ['办公楼', '房屋建筑物', '2021-12-01', '8000000.00', 240, 0.04, 'D01', '园区 1 号楼'],
      ['生产线 A', '机器设备', '2023-01-15', '1200000.00', 120, 0.05, 'D06', '1 号仓'],
      ['生产线 B', '机器设备', '2024-06-01', '600000.00', 120, 0.05, 'D06', '2 号仓'],
      ['厢式货车', '运输工具', '2024-03-10', '350000.00', 48, 0.04, 'D08', '园区车库'],
      ['机架式服务器', '电子设备', '2025-01-10', '80000.00', 36, 0.10, 'D07', '机房'],
      ['办公电脑', '电子设备', '2025-05-20', '50000.00', 36, 0.10, 'D02', '财务部']
    ];
    function monthsInclusive(fromYm, toYm) {
      var y1 = +fromYm.slice(0, 4), m1 = +fromYm.slice(5, 7), y2 = +toYm.slice(0, 4), m2 = +toYm.slice(5, 7);
      return (y2 - y1) * 12 + (m2 - m1) + 1;
    }
    return defs.map(function (d, i) {
      var cost = Y(d[3]);
      var monthly = Math.floor((cost - Math.round(cost * d[5])) / d[4]);
      var me = Math.min(d[4], monthsInclusive(d[2].slice(0, 7), asOf));
      return {
        code: 'ZC' + ('000' + (i + 1)).slice(-3), name: d[0], category: d[1], purchaseDate: d[2],
        cost: cost, months: d[4], residualRate: d[5], method: '直线法', dept: d[6], location: d[7],
        status: '在用', accumulated: me * monthly, monthsElapsed: me
      };
    });
  }

  function seedVouchers() {
    // 增值税额按 js/taxrules.js 的税率计算，不在这里硬编码税率
    var rates = (root.FMTax && root.FMTax.vat && root.FMTax.vat.generalRates) || {};
    function tax(cents, category) { return Math.round(cents * (rates[category] || 0)); }

    var buy = Y('800000.00'), sale1 = Y('1200000.00'), sale2 = Y('450000.00'), rent = Y('60000.00');
    var MAKER = '王丽', AUDITOR = '李强';
    var defs = [
      ['2026-11-02', '采购商品一批入库（华东电子）', '已过账', 2, [
        ['1405', '采购商品入库', buy, 0],
        ['22210101', '采购进项税额', tax(buy, 'goods'), 0],
        ['2202', '应付华东电子货款', 0, buy + tax(buy, 'goods'), { supplier: 'S001' }]]],
      ['2026-11-03', '销售商品给南京瑞丰科技', '已过账', 2, [
        ['1122', '应收瑞丰科技货款', sale1 + tax(sale1, 'goods'), 0, { customer: 'C001' }],
        ['600101', '商品销售收入', 0, sale1],
        ['22210102', '销售销项税额', 0, tax(sale1, 'goods')]]],
      ['2026-11-05', '收到上海华东电子货款', '已过账', 1, [
        ['100201', '收华东电子货款', Y('650000.00'), 0],
        ['1122', '收华东电子货款', 0, Y('650000.00'), { customer: 'C002' }]]],
      ['2026-11-06', '支付深圳科创电子货款', '已过账', 1, [
        ['2202', '付深圳科创货款', Y('480000.00'), 0, { supplier: 'S002' }],
        ['100201', '付深圳科创货款', 0, Y('480000.00')]]],
      ['2026-11-10', '发放 10 月工资', '已过账', 1, [
        ['221101', '发放 10 月工资', Y('986000.00'), 0],
        ['100201', '银行代发工资', 0, Y('852400.00')],
        ['2241', '代扣个人社保公积金', 0, Y('111800.00')],
        ['222104', '代扣 10 月个人所得税', 0, Y('21800.00')]]],
      ['2026-11-12', '缴纳 10 月增值税及附加、个税', '已过账', 3, [
        ['222102', '缴纳 10 月增值税', Y('186500.00'), 0],
        ['222105', '缴纳 10 月城建税', Y('13055.00'), 0],
        ['222106', '缴纳 10 月教育费附加', Y('5595.00'), 0],
        ['222107', '缴纳 10 月地方教育附加', Y('3730.00'), 0],
        ['222104', '缴纳 9 月代扣个税', Y('23650.00'), 0],
        ['100201', '银行扣缴税费', 0, Y('232530.00')]]],
      ['2026-11-15', '支付 11 月办公室租金', '已审核', 2, [
        ['530103', '11 月办公室租金', rent, 0, { dept: 'D04' }],
        ['22210101', '租金进项税额', tax(rent, 'transport'), 0],
        ['100201', '付办公室租金', 0, rent + tax(rent, 'transport')]]],
      ['2026-11-18', '销售一部报销差旅费', '已审核', 5, [
        ['520103', '赵磊报销广州出差差旅费', Y('8650.40'), 0, { dept: 'D08' }],
        ['1001', '现金支付差旅报销', 0, Y('8650.40')]]],
      ['2026-11-20', '销售商品给南京瑞丰科技（款已收）', '已审核', 2, [
        ['100201', '收瑞丰科技货款', sale2 + tax(sale2, 'goods'), 0],
        ['600101', '商品销售收入', 0, sale2],
        ['22210102', '销售销项税额', 0, tax(sale2, 'goods')]]],
      ['2026-11-21', '支付短期借款利息', '未审核', 1, [
        ['2231', '冲 10 月已计提利息', Y('7250.00'), 0],
        ['540101', '11 月借款利息', Y('7250.00'), 0],
        ['100202', '建行扣收借款利息', 0, Y('14500.00')]]],
      ['2026-11-30', '计提 11 月工资', '未审核', 1, [
        ['520101', '销售一部工资', Y('150000.00'), 0, { dept: 'D08' }],
        ['520101', '销售二部工资', Y('130000.00'), 0, { dept: 'D09' }],
        ['520101', '市场部工资', Y('80000.00'), 0, { dept: 'D10' }],
        ['520101', '客服部工资', Y('60000.00'), 0, { dept: 'D11' }],
        ['530101', '总经办工资', Y('96000.00'), 0, { dept: 'D01' }],
        ['530101', '财务部工资', Y('88000.00'), 0, { dept: 'D02' }],
        ['530101', '人力资源部工资', Y('64000.00'), 0, { dept: 'D03' }],
        ['530101', '行政部工资', Y('72000.00'), 0, { dept: 'D04' }],
        ['530101', '采购部工资', Y('78000.00'), 0, { dept: 'D05' }],
        ['530101', '仓储物流部工资', Y('124000.00'), 0, { dept: 'D06' }],
        ['530101', '信息技术部工资', Y('28000.00'), 0, { dept: 'D07' }],
        ['530101', '审计法务部工资', Y('22000.00'), 0, { dept: 'D12' }],
        ['221101', '计提 11 月应付工资', 0, Y('992000.00')]]],
      ['2026-11-30', '结转本月销售成本', '未审核', 1, [
        ['5001', '结转本月销售成本', Y('1155000.00'), 0],
        ['1405', '结转本月销售成本', 0, Y('1155000.00')]]]
    ];

    var vouchers = [], entries = [];
    defs.forEach(function (d, i) {
      var id = '记-2026-11-' + ('000' + (i + 1)).slice(-4);
      vouchers.push({
        id: id, date: d[0], period: '2026-11', summary: d[1], status: d[2],
        maker: MAKER, auditor: d[2] === '未审核' ? '' : AUDITOR, attachCount: d[3],
        createdAt: d[0] + 'T09:00:00.000Z'
      });
      d[4].forEach(function (l, j) {
        entries.push({
          id: id + '-' + (j + 1), voucherId: id, line: j + 1,
          accountCode: l[0], summary: l[1], debit: l[2], credit: l[3], aux: l[4] || {}
        });
      });
    });
    return { vouchers: vouchers, entries: entries };
  }

  function buildSeed() {
    var v = seedVouchers();
    var deptDefs = [['总经办', 4], ['财务部', 6], ['人力资源部', 4], ['行政部', 5], ['采购部', 6], ['仓储物流部', 14],
      ['信息技术部', 4], ['销售一部', 18], ['销售二部', 16], ['市场部', 8], ['客服部', 10], ['审计法务部', 5]];
    // chunk 5：员工月薪（元）与专项附加扣除，未配置的按职务默认（payroll.js 按职务名匹配）
    var salaryDefs = {
      '周建国': [35000, { children: 1, parents: 3000 }],
      '王丽': [8000, { mortgage: true, children: 1 }],
      '李强': [18000, { rent: 1500 }],
      '赵磊': [18000, { children: 2 }],
      '刘洋': [18000, { children: 1 }],
      '沈涛': [12000, { mortgage: true }]
    };
    var staffDefs = [['周建国', 'D01', '总经理'], ['吴敏', 'D01', '总经理助理'], ['李强', 'D02', '财务经理'], ['王丽', 'D02', '总账会计'],
      ['陈静', 'D02', '出纳'], ['刘洋', 'D03', '人力资源经理'], ['孙倩', 'D04', '行政主管'], ['赵磊', 'D08', '销售经理'],
      ['钱芳', 'D08', '销售代表'], ['郑浩', 'D09', '销售经理'], ['冯雪', 'D09', '销售代表'], ['褚卫东', 'D05', '采购经理'],
      ['蒋琳', 'D05', '采购专员'], ['沈涛', 'D06', '仓储主管'], ['韩梅', 'D06', '物流专员'], ['杨帆', 'D07', '信息主管'],
      ['朱婷', 'D10', '市场经理'], ['秦朗', 'D11', '客服主管'], ['许晴', 'D12', '法务专员'], ['何军', 'D12', '内审专员']];
    // 客户 / 供应商档案：[名称, 信用额度(元)]，编码 C001… / S001… 为辅助核算键（chunk 3）。
    // C001 南京瑞丰 / C002 上海华东电子 / C003 苏州明达 / C004 杭州云帆 / C005 合肥安达；
    // S001 华东电子 / S002 深圳科创 / S003 无锡精工 / S004 常州宏远 / S005 宁波海通。
    var custDefs = [['南京瑞丰科技有限公司', 2000000], ['上海华东电子有限公司', 1500000], ['苏州明达贸易有限公司', 800000],
      ['杭州云帆网络有限公司', 800000], ['合肥安达实业有限公司', 600000], ['无锡恒业机电有限公司', 500000],
      ['合肥智联信息技术有限公司', 500000], ['武汉江城百货有限公司', 600000], ['成都蜀韵商业连锁有限公司', 500000],
      ['广州粤海数码有限公司', 400000]];
    var supDefs = [['华东电子有限公司', 1500000], ['深圳科创电子有限公司', 1200000], ['无锡精工机械有限公司', 800000],
      ['常州宏远贸易有限公司', 600000], ['宁波海通物流有限公司', 400000], ['杭州云栖办公用品有限公司', 300000],
      ['北京中科软件有限公司', 500000], ['青岛海润包装材料有限公司', 300000], ['厦门鹭岛国际货运代理有限公司', 400000],
      ['上海浦江物业管理有限公司', 200000]];
    function party(prefix, base) {
      return function (def, i) {
        var n = ('00' + (i + 1)).slice(-3);
        return {
          id: prefix + n, name: def[0], taxNo: '9131' + base + n + '00' + ((i * 7 + 3) % 10) + 'X',
          contact: '', phone: '021-5' + base.slice(0, 3) + '0' + n,
          creditLimit: def[1] * 100, creditDays: 30 + (i % 3) * 15
        };
      };
    }
    return {
      company: {
        name: '演示科技有限公司', taxpayerType: 'general', taxpayerTypeName: '一般纳税人', industry: '商贸',
        staffCount: 100, location: 'urban', creditCode: '91310115MA1DEMO26X', legalPerson: '周建国',
        accountingStandard: '企业会计准则', startPeriod: '2026-11', openingDate: '2026-10-31', operator: '王丽'
      },
      periods: {
        current: '2026-11',
        list: [{ period: '2026-10', closed: true }, { period: '2026-11', closed: false }]
      },
      closedPeriods: [], // chunk 2：经 FMClosing 结账的期间列表（期初锁定、凭证锁定用）
      accounts: seedAccounts(),
      vouchers: v.vouchers,
      entries: v.entries,
      departments: deptDefs.map(function (d, i) { return { id: 'D' + ('0' + (i + 1)).slice(-2), name: d[0], headcount: d[1] }; }),
      staff: staffDefs.map(function (s, i) {
        var cfg = salaryDefs[s[0]] || [];
        return { id: 'E' + ('00' + (i + 1)).slice(-3), name: s[0], dept: s[1], title: s[2],
          salary: cfg[0] ? cfg[0] * 100 : 0, deductions: cfg[1] || {} };
      }),
      customers: custDefs.map(party('C', '0105')),
      suppliers: supDefs.map(party('S', '0206')),
      bankStatements: {
        // chunk 3：100201 的 11 月银行流水种子（与日记账部分勾对、部分未达）
        '100201': [
          { date: '2026-11-03', amount: 65000000, summary: '收到货款（华东电子）' },
          { date: '2026-11-04', amount: -48000000, summary: '支付货款' },
          { date: '2026-11-10', amount: -85240000, summary: '代发工资' },
          { date: '2026-11-12', amount: -23253000, summary: '扣缴税费' },
          { date: '2026-11-15', amount: -6540000, summary: '支付办公室租金' },
          { date: '2026-11-18', amount: -865040, summary: '支付差旅报销' },
          { date: '2026-11-20', amount: 50850000, summary: '收到货款（瑞丰科技）' },
          { date: '2026-11-25', amount: -30000, summary: '银行手续费' },
          { date: '2026-11-26', amount: 120000, summary: '存款利息' },
          { date: '2026-11-28', amount: -5000000, summary: '归还短期借款' },
          { date: '2026-11-29', amount: -1200000, summary: '支付水电费' },
          { date: '2026-11-30', amount: 20000000, summary: '收到保证金退回' }
        ]
      },
      taxRecords: [], assets: seedAssets(), payrolls: [], invoices: [], budgets: [], auditLog: []
    };
  }

  /* 全新种子数据（替换内存并保存）。load() 缺键补默认值时用 buildSeed()，不走这里。 */
  function seed() {
    state = buildSeed();
    save();
    return state;
  }

  /* ---------- 读写 ---------- */

  function save() {
    var raw = JSON.stringify(state);
    memory = raw;
    var ls = storage();
    if (ls) {
      try { ls.setItem(KEY, raw); } catch (e) { /* 配额满或被禁用：仅保留在内存 */ }
    }
    return true;
  }

  function load() {
    var raw = null, ls = storage();
    if (ls) {
      try { raw = ls.getItem(KEY); } catch (e) { raw = null; }
    }
    if (!raw) raw = memory;
    var parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.company || !Array.isArray(parsed.accounts)) return seed();
    state = parsed;
    /* 旧版迁移兼容：键缺失（undefined），或者值是空数组/空对象且新鲜种子里该键默认值非空
     * （旧版 load() 曾把缺键一律填 []，随保存写进了 localStorage），都从种子深拷贝补齐。
     * 种子默认值本身就空的键（taxRecords 等）不补；已有非空数据一字不动。 */
    var tpl = null;
    function seedDefaultNonEmpty(k) {
      tpl = tpl || buildSeed();
      var d = tpl[k];
      if (Array.isArray(d)) return d.length > 0;
      if (d && typeof d === 'object') return Object.keys(d).length > 0;
      return false;
    }
    var missing = TOP_KEYS.filter(function (k) {
      var v = state[k];
      if (v === undefined) return true;
      if (Array.isArray(v) && v.length === 0) return seedDefaultNonEmpty(k);
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return seedDefaultNonEmpty(k);
      return false;
    });
    if (missing.length) {
      tpl = tpl || buildSeed();
      missing.forEach(function (k) {
        state[k] = JSON.parse(JSON.stringify(tpl[k] === undefined ? [] : tpl[k]));
      });
      save();
    }
    return state;
  }

  function reset() {
    var ls = storage();
    if (ls) {
      try { ls.removeItem(KEY); } catch (e) { /* 忽略 */ }
    }
    memory = null;
    return seed();
  }

  function get(key) {
    if (!state) load();
    return key ? state[key] : state;
  }

  function set(key, value) {
    if (!state) load();
    state[key] = value;
    save();
    return value;
  }

  // 写一条操作日志（chunk 8 的审计日志页面读它）
  function log(action, target, detail) {
    if (!state) load();
    state.auditLog.push({
      time: new Date().toISOString(), user: (state.company && state.company.operator) || '',
      action: action, target: target || '', detail: detail || ''
    });
    if (state.auditLog.length > 5000) state.auditLog.splice(0, state.auditLog.length - 5000);
  }

  root.FMStore = {
    KEY: KEY, load: load, save: save, reset: reset, seed: seed, get: get, set: set, log: log,
    toCents: toCents, fmt: fmt, esc: esc
  };
})(typeof window !== 'undefined' ? window : globalThis);
