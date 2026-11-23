(() => {
  try {
    const saved = localStorage.getItem('ditto_theme');
    document.documentElement.dataset.theme = saved === 'light' || saved === 'system' ? saved : 'dark';
  } catch {
    document.documentElement.dataset.theme = 'dark';
  }
})();
