(function () {
	if (window.Capacitor && window.location.pathname === '/') {
		window.history.replaceState(null, '', '/app');
	}
	var isAppRoute = window.location.pathname === '/app' || window.location.pathname.startsWith('/app/');
	document.documentElement.setAttribute('data-xln-route-mode', isAppRoute ? 'app' : 'default');
})();
