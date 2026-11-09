/* OPTICMALL 사이트 알림 (배송 알림 종 아이콘) - 모든 고객 페이지 공용 */
(function () {
  if (window.__opticNotify) return; window.__opticNotify = true;
  var css = '' +
  '.nt-bell{position:relative}' +
  '.nt-badge{position:absolute;top:2px;right:2px;min-width:15px;height:15px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:#FF7A1A;color:#fff;font-size:9px;font-weight:700;display:none;align-items:center;justify-content:center;line-height:1}' +
  '#ntPanel{position:fixed;z-index:9999;width:340px;max-width:calc(100vw - 24px);background:#fff;border:1px solid #E6E1D8;box-shadow:0 10px 30px rgba(42,36,32,.18);display:none;font-family:inherit;color:#2A2420}' +
  '#ntPanel .nt-h{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid #EFEAE2;font-size:14px;font-weight:700}' +
  '#ntPanel .nt-h button{border:none;background:none;font-size:12px;color:#8A7F73;cursor:pointer;font-family:inherit;padding:0}' +
  '#ntPanel .nt-list{max-height:380px;overflow-y:auto}' +
  '#ntPanel .nt-i{display:block;width:100%;text-align:left;border:none;background:#fff;padding:13px 16px;border-bottom:1px solid #F4F1EC;cursor:pointer;font-family:inherit;position:relative}' +
  '#ntPanel .nt-i:hover{background:#FAF8F4}' +
  '#ntPanel .nt-i.un{background:#FFF8F1}' +
  '#ntPanel .nt-i.un:before{content:"";position:absolute;left:6px;top:20px;width:5px;height:5px;border-radius:50%;background:#FF7A1A}' +
  '#ntPanel .nt-t{font-size:13px;font-weight:700;margin-bottom:3px}' +
  '#ntPanel .nt-b{font-size:12.5px;color:#5C5249;line-height:1.5;word-break:keep-all}' +
  '#ntPanel .nt-d{font-size:11px;color:#A59A8D;margin-top:4px}' +
  '#ntPanel .nt-e{padding:34px 16px;text-align:center;font-size:13px;color:#A59A8D}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var items = [], bell, badge, panel, unsub = null;

  function ago(ms) {
    var d = (Date.now() - ms) / 1000;
    if (d < 60) return '방금 전';
    if (d < 3600) return Math.floor(d / 60) + '분 전';
    if (d < 86400) return Math.floor(d / 3600) + '시간 전';
    var t = new Date(ms); return (t.getMonth() + 1) + '월 ' + t.getDate() + '일';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function build() {
    var cb = document.getElementById('cartCountBadge');
    var cartBtn = cb && cb.closest('button');
    if (!cartBtn || document.getElementById('ntBell')) return !!document.getElementById('ntBell');
    bell = document.createElement('button');
    bell.id = 'ntBell'; bell.className = 'icon-btn nt-bell'; bell.type = 'button'; bell.style.display = 'none';
    bell.setAttribute('aria-label', '알림');
    bell.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg><span class="nt-badge" id="ntBadge">0</span>';
    cartBtn.parentNode.insertBefore(bell, cartBtn);
    badge = bell.querySelector('#ntBadge');
    panel = document.createElement('div'); panel.id = 'ntPanel';
    document.body.appendChild(panel);
    bell.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    document.addEventListener('click', function (e) { if (panel && !panel.contains(e.target)) panel.style.display = 'none'; });
    return true;
  }

  function place() {
    var r = bell.getBoundingClientRect();
    var w = Math.min(340, window.innerWidth - 24);
    var left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12));
    panel.style.left = left + 'px'; panel.style.top = (r.bottom + 8) + 'px';
  }

  function render() {
    var un = items.filter(function (n) { return !n.read; }).length;
    badge.textContent = un > 9 ? '9+' : un; badge.style.display = un ? 'flex' : 'none';
    var h = '<div class="nt-h"><span>알림</span>' + (un ? '<button type="button" id="ntAll">모두 읽음</button>' : '') + '</div><div class="nt-list">';
    if (!items.length) h += '<div class="nt-e">새로운 알림이 없습니다.</div>';
    items.forEach(function (n, i) {
      h += '<button type="button" class="nt-i' + (n.read ? '' : ' un') + '" data-i="' + i + '"><div class="nt-t">' + esc(n.title) + '</div><div class="nt-b">' + esc(n.body) + '</div><div class="nt-d">' + ago(n.ms) + '</div></button>';
    });
    panel.innerHTML = h + '</div>';
    var all = panel.querySelector('#ntAll');
    if (all) all.onclick = function () { items.forEach(function (n) { if (!n.read) mark(n); }); };
    panel.querySelectorAll('.nt-i').forEach(function (b) {
      b.onclick = function () { var n = items[+b.dataset.i]; if (!n.read) mark(n); location.href = 'mypage.html'; };
    });
  }

  function mark(n) {
    try { firebase.firestore().collection('notifications').doc(n.id).update({ read: true }); } catch (e) {}
  }
  function toggle() {
    if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
    render(); place(); panel.style.display = 'block';
  }

  function start(uid) {
    if (unsub) { unsub(); unsub = null; }
    unsub = firebase.firestore().collection('notifications').where('userId', '==', uid).onSnapshot(function (snap) {
      items = snap.docs.map(function (d) {
        var x = d.data(); var t = x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : Date.now();
        return { id: d.id, title: x.title, body: x.body, read: !!x.read, ms: t };
      }).sort(function (a, b) { return b.ms - a.ms; }).slice(0, 30);
      bell.style.display = ''; render();
    }, function () { /* 권한/네트워크 오류 시 조용히 무시 */ });
  }

  function init() {
    if (!window.firebase || !firebase.apps || !firebase.apps.length || !build()) return;
    firebase.auth().onAuthStateChanged(function (u) {
      if (u) start(u.uid);
      else { if (unsub) { unsub(); unsub = null; } items = []; if (bell) bell.style.display = 'none'; if (panel) panel.style.display = 'none'; }
    });
    window.addEventListener('resize', function () { if (panel && panel.style.display === 'block') place(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
