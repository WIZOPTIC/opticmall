// V.KOOL 주문 규정 (초도 주문 최소 금액 / 재주문 최소 수량)
// 관리자 화면 > 설정에서 값 변경: settings/vkoolRule
// 거래처별 초도 완료 표시: users/{uid}.vkoolFirstDone
(function () {
  const PAID_STATUSES = ['paid', 'preparing', 'shipping', 'delivered'];
  const DEFAULT_RULE = { enabled: true, brandName: 'V.KOOL', firstMinAmount: 1000000, repeatMinQty: 2 };
  let _rule = null;
  let _firstCache = {};

  async function loadRule() {
    if (_rule) return _rule;
    try {
      const doc = await firebase.firestore().collection('settings').doc('vkoolRule').get();
      _rule = Object.assign({}, DEFAULT_RULE, doc.exists ? doc.data() : {});
    } catch (e) {
      console.error('V.KOOL 규정 조회 실패', e);
      _rule = Object.assign({}, DEFAULT_RULE);
    }
    _rule.firstMinAmount = Number(_rule.firstMinAmount) || 0;
    _rule.repeatMinQty = Number(_rule.repeatMinQty) || 0;
    return _rule;
  }

  function isVkool(brandName, rule) {
    return String(brandName || '').trim().toUpperCase() === String((rule || DEFAULT_RULE).brandName).trim().toUpperCase();
  }

  // 첫 V.KOOL 주문인지: 관리자 '초도 완료' 표시가 없고, 결제 완료된 V.KOOL 주문 이력도 없으면 첫 주문
  async function isFirstOrder(uid, userData) {
    if (userData && userData.vkoolFirstDone) return false;
    if (uid in _firstCache) return _firstCache[uid];
    const rule = await loadRule();
    let first = true;
    try {
      const snap = await firebase.firestore().collection('orders').where('userId', '==', uid).get();
      snap.forEach(d => {
        const o = d.data();
        if (!PAID_STATUSES.includes(o.status)) return;
        if ((o.items || []).some(it => isVkool(it.brandName, rule))) first = false;
      });
    } catch (e) {
      console.error('주문 이력 조회 실패', e);
    }
    _firstCache[uid] = first;
    return first;
  }

  // items: [{ brandName, qty, price }]  (price = 실제 결제 단가)
  // 반환: { applies, ok, first, amount, qty, message }
  async function check(items, uid, userData) {
    const rule = await loadRule();
    const vk = (items || []).filter(i => isVkool(i.brandName, rule));
    if (!rule.enabled || vk.length === 0) return { applies: false, ok: true };
    const amount = vk.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
    const qty = vk.reduce((s, i) => s + (Number(i.qty) || 0), 0);
    const first = await isFirstOrder(uid, userData);
    const won = n => Number(n).toLocaleString('ko-KR') + '원';
    if (first) {
      const ok = amount >= rule.firstMinAmount;
      return {
        applies: true, ok, first, amount, qty,
        message: ok ? '' : `V.KOOL 첫 주문은 ${won(rule.firstMinAmount)} 이상부터 가능합니다. (현재 V.KOOL ${won(amount)}, ${won(rule.firstMinAmount - amount)} 부족)`
      };
    }
    const ok = qty >= rule.repeatMinQty;
    return {
      applies: true, ok, first, amount, qty,
      message: ok ? '' : `V.KOOL은 모델 상관없이 ${rule.repeatMinQty}장 이상부터 주문 가능합니다. (현재 ${qty}장)`
    };
  }

  // 상품/목록 페이지 안내 문구
  async function noticeText() {
    const rule = await loadRule();
    if (!rule.enabled) return '';
    return 'V.KOOL은 초도구매가 있는 상품입니다.';
  }

  window.VkoolRule = { loadRule, isVkool, isFirstOrder, check, noticeText };
})();
