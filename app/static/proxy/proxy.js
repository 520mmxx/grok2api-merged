// Proxy Management JS - 独立认证，不依赖 admin-auth.js 缓存问题
const API = '/api/v1/admin/proxies';
let _bearerToken = '';

// 独立登录获取 token
async function proxyLogin() {
  try {
    // 从 localStorage 读取凭据
    const stored = localStorage.getItem('grok2api_app_key') || '';
    let username = 'admin', password = '';
    
    if (stored) {
      try {
        // 尝试解密
        if (stored.startsWith('enc:xor:')) {
          const plain = xorDecryptSafe(stored);
          const obj = JSON.parse(plain);
          username = obj.username || 'admin';
          password = obj.password || '';
        } else if (stored.startsWith('enc:v1:')) {
          // AES 加密 - 尝试用 ensureApiKey
          if (typeof ensureApiKey === 'function') {
            const key = await ensureApiKey();
            if (key) { _bearerToken = key; return true; }
          }
          return false;
        } else {
          // 明文 JSON
          try {
            const obj = JSON.parse(stored);
            username = obj.username || 'admin';
            password = obj.password || stored;
          } catch {
            password = stored;
          }
        }
      } catch { /* ignore */ }
    }
    
    if (!password) {
      window.location.href = '/login';
      return false;
    }
    
    // 直接调用登录 API
    const res = await fetch('/api/v1/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    if (!res.ok) {
      // 凭据无效，清除并跳转登录
      localStorage.removeItem('grok2api_app_key');
      window.location.href = '/login';
      return false;
    }
    
    const data = await res.json();
    const apiKey = data.api_key || '';
    if (!apiKey) {
      window.location.href = '/login';
      return false;
    }
    
    _bearerToken = `Bearer ${apiKey}`;
    return true;
  } catch (e) {
    window.location.href = '/login';
    return false;
  }
}

// XOR 解密（简化版）
function xorDecryptSafe(stored) {
  const prefix = 'enc:xor:';
  if (!stored.startsWith(prefix)) return stored;
  const payload = stored.slice(prefix.length);
  try {
    const binary = atob(payload);
    const key = 'grok2api-admin-key';
    let result = '';
    for (let i = 0; i < binary.length; i++) {
      result += String.fromCharCode(binary.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
  } catch {
    return stored;
  }
}

function authHeaders() {
  return _bearerToken ? { 'Authorization': _bearerToken, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

// ========== Load Proxies ==========
async function loadProxies() {
  const loading = document.getElementById('loading');
  const emptyState = document.getElementById('empty-state');
  const tbody = document.getElementById('proxy-table-body');
  loading.classList.remove('hidden');
  emptyState.classList.add('hidden');

  try {
    const res = await fetch(API, { headers: authHeaders() });
    if (res.status === 401) {
      // Token 过期，重新登录
      if (await proxyLogin()) return loadProxies();
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || json.message || '未知错误');

    const d = json.data;
    // Stats
    const healthy = d.proxies.filter(p => p.healthy).length;
    const unhealthy = d.proxies.filter(p => !p.healthy).length;
    document.getElementById('stat-total').textContent = d.total;
    document.getElementById('stat-healthy').textContent = healthy;
    document.getElementById('stat-unhealthy').textContent = unhealthy;
    document.getElementById('stat-bindings').textContent = Object.keys(d.assignments || {}).length;

    if (!d.proxies || d.proxies.length === 0) {
      loading.classList.add('hidden');
      emptyState.classList.remove('hidden');
      tbody.innerHTML = '';
      return;
    }

    loading.classList.add('hidden');
    tbody.innerHTML = '';

    for (const p of d.proxies) {
      const tr = document.createElement('tr');
      
      // URL
      const tdUrl = document.createElement('td');
      tdUrl.className = 'proxy-url-cell';
      tdUrl.title = p.url;
      tdUrl.textContent = p.url;
      tr.appendChild(tdUrl);

      // Status
      const tdStatus = document.createElement('td');
      tdStatus.style.textAlign = 'center';
      const dot = document.createElement('span');
      dot.className = 'health-dot ' + (p.healthy ? 'healthy' : 'unhealthy');
      tdStatus.appendChild(dot);
      tdStatus.appendChild(document.createTextNode(p.healthy ? '正常' : '异常'));
      tr.appendChild(tdStatus);

      // Fail count
      const tdFail = document.createElement('td');
      tdFail.style.textAlign = 'center';
      tdFail.textContent = p.fail_count;
      if (p.fail_count >= 3) tdFail.className = 'text-red-600 font-semibold';
      tr.appendChild(tdFail);

      // Success rate
      const tdRate = document.createElement('td');
      tdRate.style.textAlign = 'center';
      if (p.total_requests > 0) {
        const span = document.createElement('span');
        const rate = p.success_rate || 0;
        span.className = 'rate-bar ' + (rate >= 90 ? 'rate-high' : rate >= 50 ? 'rate-mid' : 'rate-low');
        span.textContent = rate + '%';
        tdRate.appendChild(span);
      } else {
        tdRate.textContent = '-';
      }
      tr.appendChild(tdRate);

      // Total requests
      const tdTotal = document.createElement('td');
      tdTotal.style.textAlign = 'center';
      tdTotal.textContent = p.total_requests;
      tr.appendChild(tdTotal);

      // Bound SSOs
      const tdSso = document.createElement('td');
      const assignments = d.assignments || {};
      const boundSsos = Object.entries(assignments).filter(([sso, url]) => url === p.url);
      if (boundSsos.length > 0) {
        for (const [sso] of boundSsos) {
          const badge = document.createElement('span');
          badge.className = 'sso-badge';
          badge.innerHTML = '...' + sso.slice(-6) + '<span class="unbind-btn" onclick="unbindSso(\'' + sso + '\')" title="解绑">&times;</span>';
          tdSso.appendChild(badge);
        }
      } else {
        tdSso.innerHTML = '<span class="text-xs text-[var(--accents-4)]">无</span>';
      }
      tr.appendChild(tdSso);

      // Actions
      const tdActions = document.createElement('td');
      tdActions.style.textAlign = 'center';
      const esc = p.url.replace(/'/g, "\\'");
      tdActions.innerHTML = '<div class="flex items-center justify-center gap-1">' +
        '<button class="geist-button-outline text-xs px-2 py-1" onclick="openBindModal(\'' + esc + '\')">绑定</button>' +
        '<button class="geist-button-outline text-xs px-2 py-1" onclick="testProxy(\'' + esc + '\')">测试</button>' +
        '<button class="geist-button-danger text-xs px-2 py-1" onclick="deleteProxy(\'' + esc + '\')">删除</button>' +
        '</div>';
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  } catch (e) {
    loading.textContent = '加载失败: ' + e.message;
    showToast('加载失败: ' + e.message, 'error');
  }
}

// ========== Add Proxy ==========
function openAddModal() {
  document.getElementById('add-proxy-urls').value = '';
  document.getElementById('add-modal').classList.remove('hidden');
}
function closeAddModal() {
  document.getElementById('add-modal').classList.add('hidden');
}

async function submitAddProxy() {
  const raw = document.getElementById('add-proxy-urls').value.trim();
  if (!raw) { showToast('请输入代理 URL', 'error'); return; }
  const urls = raw.split('\n').map(s => s.trim()).filter(Boolean);
  if (!urls.length) return;

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ urls })
    });
    if (res.status === 401) { if (await proxyLogin()) return submitAddProxy(); return; }
    const json = await res.json();
    if (json.success) {
      showToast(json.message || '添加成功', 'success');
      closeAddModal();
      loadProxies();
    } else {
      showToast(json.message || json.error || '添加失败', 'error');
    }
  } catch (e) {
    showToast('请求失败: ' + e.message, 'error');
  }
}

// ========== Delete Proxy ==========
function deleteProxy(url) {
  showConfirm('确定删除代理？绑定的 SSO 将被解绑。', async () => {
    try {
      const res = await fetch(API, {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ url })
      });
      if (res.status === 401) { if (await proxyLogin()) return deleteProxy(url); return; }
      const json = await res.json();
      if (json.success) { showToast('删除成功', 'success'); loadProxies(); }
      else { showToast(json.message || '删除失败', 'error'); }
    } catch (e) { showToast('请求失败', 'error'); }
  });
}

// ========== Bind SSO ==========
function openBindModal(url) {
  document.getElementById('bind-proxy-url').value = url;
  document.getElementById('bind-sso-token').value = '';
  document.getElementById('bind-modal').classList.remove('hidden');
}
function closeBindModal() {
  document.getElementById('bind-modal').classList.add('hidden');
}

async function submitBindSso() {
  const proxyUrl = document.getElementById('bind-proxy-url').value;
  const sso = document.getElementById('bind-sso-token').value.trim();
  if (!sso) { showToast('请输入 SSO Token', 'error'); return; }

  try {
    const res = await fetch(API + '/assign', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ proxy_url: proxyUrl, sso })
    });
    if (res.status === 401) { if (await proxyLogin()) return submitBindSso(); return; }
    const json = await res.json();
    if (json.success) { showToast('绑定成功', 'success'); closeBindModal(); loadProxies(); }
    else { showToast(json.message || '绑定失败', 'error'); }
  } catch (e) { showToast('请求失败', 'error'); }
}

// ========== Unbind SSO ==========
function unbindSso(sso) {
  showConfirm('确定解绑 SSO ...' + sso.slice(-6) + ' ？', async () => {
    try {
      const res = await fetch(API + '/unassign', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ sso })
      });
      if (res.status === 401) { if (await proxyLogin()) return unbindSso(sso); return; }
      const json = await res.json();
      if (json.success) { showToast('解绑成功', 'success'); loadProxies(); }
      else { showToast(json.message || '解绑失败', 'error'); }
    } catch (e) { showToast('请求失败', 'error'); }
  });
}

// ========== Test Proxy ==========
async function testProxy(url) {
  showToast('正在测试代理...', 'info');
  try {
    const res = await fetch(API + '/test', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ url })
    });
    if (res.status === 401) { if (await proxyLogin()) return testProxy(url); return; }
    const json = await res.json();
    const msg = json.message || (json.success ? '代理可用' : '代理不可用');
    showToast(msg, json.success ? 'success' : 'error');
  } catch (e) { showToast('测试失败', 'error'); }
}

// ========== Reset Health ==========
async function resetHealth() {
  showConfirm('确定重置所有代理的健康状态？', async () => {
    try {
      const res = await fetch(API + '/health/reset', {
        method: 'POST',
        headers: authHeaders()
      });
      if (res.status === 401) { if (await proxyLogin()) return resetHealth(); return; }
      const json = await res.json();
      if (json.success) { showToast('健康状态已重置', 'success'); loadProxies(); }
      else { showToast(json.message || '重置失败', 'error'); }
    } catch (e) { showToast('重置失败', 'error'); }
  });
}

// ========== Confirm Dialog ==========
function showConfirm(msg, onOk) {
  const dialog = document.getElementById('confirm-dialog');
  document.getElementById('confirm-message').textContent = msg;
  dialog.classList.remove('hidden');
  const okBtn = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');
  const close = () => dialog.classList.add('hidden');
  cancelBtn.onclick = close;
  okBtn.onclick = () => { close(); onOk(); };
}

// ========== Init ==========
document.addEventListener('DOMContentLoaded', async () => {
  const ok = await proxyLogin();
  if (ok) loadProxies();
});
