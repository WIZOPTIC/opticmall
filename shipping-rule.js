// 출고처(브랜드 묶음)별 무료배송 기준
// 관리자 > 설정 > 배송비 규정 에서 변경: settings/shipping
//   groups: [{ name, brands:[브랜드명...], type:'amount'|'qty', threshold, fee }]
//   defaultThreshold / defaultFee : 규정에 없는 브랜드 (브랜드별로 따로 계산)
//   jejuFee : 제주/도서산간 추가비 (주문당 1회)
// ※ functions/index.js 의 calcShippingByRule 과 계산 방식이 같아야 함
(function () {
  const DEFAULT = {
    defaultThreshold: 100000, defaultFee: 3500, jejuFee: 3000,
    groups: [
      { name: 'SUOFEIA · ESSENTIAL', brands: ['SUOFEIA', 'ESSENTIAL'], type: 'amount', threshold: 70000, fee: 3500 },
      { name: 'COLOR7', brands: ['COLOR7'], type: 'amount', threshold: 50000, fee: 3500 },
      { name: 'V.KOOL', brands: ['V.KOOL'], type: 'qty', threshold: 2, fee: 3500 }
    ]
  };
  const REMOTE = ['제주', '울릉', '독도', '가거도', '거문도', '고흥', '신안', '완도', '진도', '홍도'];
  let rule = DEFAULT;
  let loaded = null;
  const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, '');

  function load() {
    if (loaded) return loaded;
    loaded = firebase.firestore().collection('settings').doc('shipping').get()
      .then(d => { if (d.exists) rule = Object.assign({}, DEFAULT, d.data()); return rule; })
      .catch(e => { console.error('배송비 규정 조회 실패', e); return rule; });
    return loaded;
  }
  function isRemote(addr) { return REMOTE.some(k => String(addr || '').includes(k)); }

  // items: [{ brandName, qty, amount }]  (amount = 실제 판매가 × 수량)
  function calc(items, addr1) {
    const groups = {};
    (items || []).forEach(it => {
      const b = norm(it.brandName);
      const g = (rule.groups || []).find(x => (x.brands || []).some(n => norm(n) === b));
      const key = g ? 'g:' + g.name : 'b:' + b;
      if (!groups[key]) groups[key] = g
        ? { name: g.name, type: g.type === 'qty' ? 'qty' : 'amount', threshold: Number(g.threshold) || 0, fee: Number(g.fee) || 0, amount: 0, qty: 0 }
        : { name: it.brandName || '기타', type: 'amount', threshold: Number(rule.defaultThreshold) || 0, fee: Number(rule.defaultFee) || 0, amount: 0, qty: 0 };
      groups[key].amount += Number(it.amount) || 0;
      groups[key].qty += Number(it.qty) || 0;
    });
    let total = 0;
    const list = Object.values(groups).map(g => {
      const have = g.type === 'qty' ? g.qty : g.amount;
      const free = have >= g.threshold;
      const fee = free ? 0 : g.fee;
      total += fee;
      return Object.assign(g, { free, shippingFee: fee, remain: free ? 0 : g.threshold - have });
    });
    const remote = list.length > 0 && isRemote(addr1);
    if (remote) total += Number(rule.jejuFee) || 0;
    return { total, groups: list, remote };
  }
  // 안내 문구: "COLOR7 45,000원 더 담으면 무료배송"
  function hintText(g) {
    if (g.free) return `${g.name} 무료배송`;
    return g.type === 'qty'
      ? `${g.name} ${g.remain}장 더 담으면 무료배송 (배송비 ₩${g.fee.toLocaleString()})`
      : `${g.name} ₩${g.remain.toLocaleString()} 더 담으면 무료배송 (배송비 ₩${g.fee.toLocaleString()})`;
  }
  // 상품 페이지용: 이 브랜드의 무료배송 기준 문구
  function ruleFor(brandName) {
    const b = norm(brandName);
    const g = (rule.groups || []).find(x => (x.brands || []).some(n => norm(n) === b));
    const type = g ? (g.type === 'qty' ? 'qty' : 'amount') : 'amount';
    const threshold = Number(g ? g.threshold : rule.defaultThreshold) || 0;
    const fee = Number(g ? g.fee : rule.defaultFee) || 0;
    const man = threshold >= 10000 && threshold % 10000 === 0 ? (threshold / 10000) + '만원' : threshold.toLocaleString() + '원';
    return { name: g ? g.name : brandName, free: type === 'qty' ? `${threshold}장 이상 무료배송` : `${man} 이상 무료배송`, fee };
  }
  function getRule() { return rule; }
  window.ShippingRule = { load, calc, hintText, isRemote, getRule, ruleFor, DEFAULT };
})();
