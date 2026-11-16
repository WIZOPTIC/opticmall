/* 메인 메뉴(하금테·뿔테·메탈·선글라스)에 마우스를 올리면 그 분류의 브랜드가 아래 영역에 펼쳐지는 기능
   - 모든 페이지에서 똑같이 동작하도록 이 파일 하나로 관리합니다 (페이지에는 <script src="nav-brands.js"> 한 줄만 있음)
   - 브랜드 목록은 승인된 상품에서 자동으로 만들고, 10분간 저장해 두어서 Firestore를 자주 읽지 않습니다 */
(function () {
  if (window.__navBrands) return;
  window.__navBrands = true;
  if (!window.matchMedia || !window.matchMedia('(hover:hover) and (min-width:769px)').matches) return;

  var CATS = ['하금테', '뿔테', '메탈', '선글라스'];
  var ORDER = ['SUOFEIA', 'ESSENTIAL', 'V.KOOL', 'ROUX PENN', 'COLOR7'];
  var CACHE_KEY = 'navBrandsV1', TTL = 10 * 60 * 1000;

  var css = document.createElement('style');
  css.textContent =
    '#navBrandPanel{position:absolute;left:0;right:0;top:100%;z-index:300;background:#F4F3F0;border-top:1px solid #E4DFD6;box-shadow:0 12px 24px rgba(42,36,32,.10);display:none;}' +
    '#navBrandPanel.on{display:block;}' +
    '#navBrandPanel .nbp-in{max-width:1440px;margin:0 auto;padding:24px 24px 28px;box-sizing:border-box;}' +
    '#navBrandPanel .nbp-row{display:inline-flex;align-items:baseline;gap:38px;white-space:nowrap;}' +
    '#navBrandPanel a{font-family:inherit;font-size:17px;font-weight:500;color:#4A423B;text-decoration:none;text-transform:uppercase;letter-spacing:.04em;transition:color .15s;}' +
    '#navBrandPanel a:hover{color:#FF7A1A;}' +
    '#navBrandPanel a em{font-style:normal;font-size:12px;font-weight:500;color:#9A8F82;margin-left:6px;letter-spacing:0;}' +
    '.gnb-item.nbp-on{color:#FF7A1A!important;}';
  document.head.appendChild(css);

  var panel = null, hideT = null, curItem = null, data = null, loading = null;

  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function effCat(p) { return String(p.brandName || '').trim().toUpperCase() === 'V.KOOL' ? '선글라스' : p.category; }
  function rank(n) { var i = ORDER.indexOf(String(n).toUpperCase()); return i === -1 ? 99 : i; }

  function loadData() {
    if (data) return Promise.resolve(data);
    try {
      var c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (c && Date.now() - c.t < TTL) { data = c.d; return Promise.resolve(data); }
    } catch (e) {}
    if (loading) return loading;
    loading = firebase.firestore().collection('products').where('status', '==', 'approved').get().then(function (snap) {
      var by = {};
      CATS.forEach(function (c) { by[c] = {}; });
      snap.forEach(function (d) {
        var p = d.data(), cat = effCat(p);
        if (!by[cat] || !p.brandName) return;
        var k = String(p.brandName).trim().toUpperCase();
        var e = by[cat][k] || (by[cat][k] = { name: String(p.brandName).trim(), n: 0 });
        e.n++;
      });
      var out = {};
      CATS.forEach(function (c) {
        out[c] = Object.keys(by[c]).map(function (k) { return by[c][k]; })
          .sort(function (a, b) { return rank(a.name) - rank(b.name) || b.n - a.n; });
      });
      data = out;
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), d: out })); } catch (e) {}
      return out;
    }).catch(function () { loading = null; return null; });
    return loading;
  }

  function ensurePanel() {
    if (panel) return panel;
    var host = document.querySelector('header');
    if (!host) return null;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    panel = document.createElement('div');
    panel.id = 'navBrandPanel';
    panel.addEventListener('mouseenter', function () { clearTimeout(hideT); });
    panel.addEventListener('mouseleave', scheduleHide);
    host.appendChild(panel);
    return panel;
  }

  function hide() {
    if (panel) panel.classList.remove('on');
    if (curItem) curItem.classList.remove('nbp-on');
    curItem = null;
  }
  function scheduleHide() { clearTimeout(hideT); hideT = setTimeout(hide, 160); }

  function show(cat, item) {
    clearTimeout(hideT);
    loadData().then(function (d) {
      if (!d || !panel && !ensurePanel()) return;
      if (curItem !== null && curItem !== item) curItem.classList.remove('nbp-on');
      // 마우스가 이미 다른 곳으로 가버렸으면 열지 않음
      if (!item.matches(':hover') && !(panel && panel.matches(':hover'))) return;
      var list = d[cat] || [];
      if (!list.length) { hide(); return; }
      var total = list.reduce(function (s, b) { return s + b.n; }, 0);
      var base = 'list.html?cat=' + encodeURIComponent(cat);
      var html = '<div class="nbp-in"><div class="nbp-row" id="nbpRow">' +
        '<a href="' + base + '">전체<em>' + total + '</em></a>' +
        list.map(function (b) { return '<a href="' + base + '&bt=' + encodeURIComponent(b.name) + '">' + esc(b.name) + '<em>' + b.n + '</em></a>'; }).join('') +
        '</div></div>';
      panel.innerHTML = html;
      panel.classList.add('on');
      item.classList.add('nbp-on');
      curItem = item;
      // 마우스를 올린 메뉴 글자의 왼쪽 선에 맞춰서 펼침 (화면 밖으로 나가지 않게 보정)
      var row = document.getElementById('nbpRow'), inner = panel.firstChild;
      var innerLeft = inner.getBoundingClientRect().left + 24;
      var want = item.getBoundingClientRect().left - innerLeft;
      var max = Math.max(0, inner.clientWidth - 48 - row.offsetWidth);
      row.style.marginLeft = Math.max(0, Math.min(want, max)) + 'px';
    });
  }

  function bind() {
    var items = document.querySelectorAll('.gnb-item');
    if (!items.length) return;
    items.forEach(function (it) {
      var label = (it.textContent || '').trim();
      var isCat = CATS.indexOf(label) !== -1;
      it.addEventListener('mouseenter', function () {
        if (isCat) show(label, it); else { clearTimeout(hideT); hide(); }
      });
      it.addEventListener('mouseleave', scheduleHide);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
