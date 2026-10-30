// Applies the saved language before the page renders, so English visitors don't get a right-to-left flash.
(function () {
  try {
    if (localStorage.getItem('avatar.lang') === 'en') {
      document.documentElement.lang = 'en';
      document.documentElement.dir = 'ltr';
    }
  } catch (e) { /* storage unavailable */ }
})();
