// Login link auto-fill: <app-url>/#u=<username>&p=<password> (both encodeURIComponent-encoded).
// The values live only in the URL fragment, which browsers never send to a server. They are removed from the
// address bar at once, put into the login form (never submitted automatically) and then forgotten.
// Classic script loaded before js/app.js, so the hash router never sees "u=...&p=...".
(function () {
  if (!/^#(?!\/)/.test(location.hash)) return; // no hash, or a route like #/dashboard
  var params = new URLSearchParams(location.hash.replace(/^#/, ''));
  var u = params.get('u'), p = params.get('p');
  params = null;
  if (u === null || p === null) return;
  history.replaceState(null, '', location.pathname + location.search);

  var visible = function (id) { var el = document.getElementById(id); return el && !el.classList.contains('d-none'); };
  var tries = 0;
  (function fill() {
    // The form is always in the page; wait until the login screen is shown. If the app opens instead
    // (already signed in), do nothing.
    if (visible('view-app')) { u = p = null; return; }
    var user = document.getElementById('login-username'), pass = document.getElementById('login-password');
    if (!visible('view-login') || !user || !pass) {
      if (++tries < 100) setTimeout(fill, 100); else u = p = null;
      return;
    }
    if (!user.getAttribute('autocomplete')) user.setAttribute('autocomplete', 'username');
    if (!pass.getAttribute('autocomplete')) pass.setAttribute('autocomplete', 'current-password');
    user.value = u; pass.value = p;
    user.dispatchEvent(new Event('input', { bubbles: true }));
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    u = p = null;

    var btn = document.getElementById('login-btn');
    if (btn && !document.getElementById('autofill-hint')) {
      var hint = document.createElement('div');
      hint.id = 'autofill-hint';
      hint.className = 'autofill-hint';
      hint.lang = 'ur'; hint.dir = 'rtl';
      hint.textContent = 'یوزر نیم اور پاس ورڈ خود بخود بھر دیے گئے ہیں۔ بس لاگ ان دبائیں';
      btn.parentNode.insertBefore(hint, btn);
      btn.classList.add('autofill-ready');
      btn.addEventListener('click', function () { btn.classList.remove('autofill-ready'); }, { once: true });
    }
  })();
})();
