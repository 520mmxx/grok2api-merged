// Proxy Management JS
const API = '/api/v1/admin/proxies';
let _proxyApiKey = null;

function proxyAuthHeaders() {
  return _proxyApiKey ? { 'Authorization': _proxyApiKey, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

async function initProxy() {
  _proxyApiKey = await ensureApiKey();
  if (_proxyApiKey === null) return;
  loadProxies();
}

// Load proxy data
async function loadProxies() {
  const loading = document.getElementById('loading');
  const emptyState = document.getElementById('empty-state');
  const tbody = document.getElementById('proxy-table-body');
  loading.classList.remove('hidden');
  emptyState.classList.add('hidden');

  try {
    const res = await fetch(API, { headers: proxyAuthHeaders() });
    if (!res.ok) {
      if (res.status === 401) { logout(); return; }
      throw new Error('加载失败: ' + res.status);
    }
    const json = await res.json();
    if (!json.success) throw new Error(json.error || '未知错误');

    const d = json.data;
    document.getElementById('stat-total').textContent = d.total;
    document.getElementById('stat-healthy').textContent = d.healthy;
    document.getElementById('stat-unhealthy').textContent = d.unhealthy;
    document.getElementById('stat-bindings').textContent = Object.keys(d.sso_assignments || {}).length;

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
      // Proxy URL
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
        span.className = 'rate-bar ' + (p.success_rate >= 90 ? 'rate-high' : p.success_rate >= 50 ? 'rate-mid' : 'rate-low');
        span.textContent = p.success_rate + '%';
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
      if (p.assigned_sso && p.assigned_sso.length > 0) {
        for (const sso of p.assigned_sso) {
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
      tdActions.innerHTML = '<div class="flex items-center justify-center gap-1">' +
        '<button class="geist-button-outline text-xs px-2 py-1" onclick="openBindModal(\'' + escapeHtml(p.url) + '\')" title="绑定SSO">绑定</button>' +
        '<button class="geist-button-outline text-xs px-2 py-1" onclick="testProxy(\'' + escapeHtml(p.url) + '\')" title="测试">测试</button>' +
        '<button class="geist-button-danger text-xs px-2 py-1" onclick="deleteProxy(\'' + escapeHtml(p.url) + '\')" title="删除">删除</button>' +
        '</div>';
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  } catch (e) {
    loading.textContent = '加载失败: ' + e.message;
    if (typeof showToast === 'function') showToast(e.message, 'error');
  }
}

function escapeHtml(s) {
  return s.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Add proxy
function openAddModal() {
  document.getElementById('add-proxy-urls').value = '';
  document.getElementById('add-modal').classList.remove('hidden');
}
function closeAddModal() {
  document.getElementById('add-modal').classList.add('hidden');
}

async function submitAddProxy() {
  const raw = document.getElementById('add-proxy-urls').value.trim();
  if (!raw) { if (typeof showToast === 'function') showToast('请输入代理 URL', 'error'); return; }

  const urls = raw.split('\n').map(s => s.trim()).filter(Boolean);
  if (!urls.length) return;

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: proxyAuthHeaders(),
      body: JSON.stringify({ urls })
    });
    const json = await res.json();
    if (json.success) {
      if (typeof showToast === 'function') showToast(json.message || '添加成功', 'success');
      closeAddModal();
      loadProxies();
    } else {
      if (typeof showToast === 'function') showToast(json.message || json.error || '添加失败', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('请求失败: ' + e.message, 'error');
  }
}

// Delete proxy
function deleteProxy(url) {
  showConfirm('确定删除代理 ' + url + ' ？绑定的 SSO 将被解绑。', async () => {
    try {
      const res = await fetch(API, {
        method: 'DELETE',
        headers: proxyAuthHeaders(),
        body: JSON.stringify({ url })
      });
      const json = await res.json();
      if (json.success) {
        if (typeof showToast === 'function') showToast('删除成功', 'success');
        loadProxies();
      } else {
        if (typeof showToast === 'function') showToast(json.error || '删除失败', 'error');
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('请求失败', 'error');
    }
  });
}

// Bind SSO
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
  if (!sso) { if (typeof showToast === 'function') showToast('请输入 SSO Token', 'error'); return; }

  try {
    const res = await fetch(API + '/assign', {
      method: 'POST',
      headers: proxyAuthHeaders(),
      body: JSON.stringify({ sso, proxy_url: proxyUrl })
    });
    const json = await res.json();
    if (json.success) {
      if (typeof showToast === 'function') showToast(json.message || '绑定成功', 'success');
      closeBindModal();
      loadProxies();
    } else {
      if (typeof showToast === 'function') showToast(json.error || '绑定失败', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('请求失败', 'error');
  }
}

// Unbind SSO
function unbindSso(sso) {
  showConfirm('确定解绑 SSO ...' + sso.slice(-6) + ' ？', async () => {
    try {
      const res = await fetch(API + '/unassign', {
        method: 'POST',
        headers: proxyAuthHeaders(),
        body: JSON.stringify({ sso })
      });
      const json = await res.json();
      if (json.success) {
        if (typeof showToast === 'function') showToast('解绑成功', 'success');
        loadProxies();
      } else {
        if (typeof showToast === 'function') showToast(json.error || '解绑失败', 'error');
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('请求失败', 'error');
    }
  });
}

// Test proxy
async function testProxy(url) {
  if (typeof showToast === 'function') showToast('正在测试代理...', 'info');
  try {
    const res = await fetch(API + '/test', {
      method: 'POST',
      headers: proxyAuthHeaders(),
      body: JSON.stringify({ url })
    });
    const json = await res.json();
    if (json.success) {
      if (typeof showToast === 'function') showToast(json.message || '代理可用', 'success');
    } else {
      if (typeof showToast === 'function') showToast(json.message || '代理不可用', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('测试失败', 'error');
  }
}

// Reset health
async function resetHealth() {
  showConfirm('确定重置所有代理的健康状态？', async () => {
    try {
      const res = await fetch(API + '/health/reset', {
        method: 'POST',
        headers: proxyAuthHeaders()
      });
      const json = await res.json();
      if (json.success) {
        if (typeof showToast === 'function') showToast('健康状态已重置', 'success');
        loadProxies();
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('重置失败', 'error');
    }
  });
}

// Confirm dialog
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

// Init
window.onload = initProxy;
