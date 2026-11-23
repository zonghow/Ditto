function updateAuth() {
  const cookie = document.cookie.split(';').some(item => item.trim() === 'ditto_demo=connected');
  const storage = localStorage.getItem('ditto_demo_name');
  document.querySelector('#auth-status').textContent = cookie && storage
    ? `演示已登录：${storage} · Cookie + localStorage 均已恢复`
    : `等待导入演示登录态 · Cookie ${cookie ? '✓' : '—'} / localStorage ${storage ? '✓' : '—'}`;
}
document.querySelector('#seed').addEventListener('click', () => {
  document.cookie = 'ditto_demo=connected; Path=/; SameSite=Lax; Max-Age=3600';
  localStorage.setItem('ditto_demo_name', 'Macbook demo');
  updateAuth();
});
document.querySelector('#hello').addEventListener('click', () => {
  const name = document.querySelector('#demo-name').value || 'Chromium';
  document.querySelector('#greeting').textContent = `你好，${name}！远端页面刚刚被更新了。`;
});
updateAuth();
const canvas = document.querySelector('#demo-canvas');
const context = canvas.getContext('2d');
function draw(time) {
  context.fillStyle = '#17273d';
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 36; i++) {
    const height = 30 + 90 * (Math.sin(time / 850 + i / 3) + 1) / 2;
    context.fillStyle = i % 3 === 0 ? '#b8d4ff' : i % 3 === 1 ? '#729acd' : '#395c8a';
    context.beginPath();
    context.roundRect(20 + i * 21, canvas.height / 2 - height / 2, 12, height, 6);
    context.fill();
  }
  document.querySelector('#clock').textContent = new Date().toLocaleTimeString();
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
