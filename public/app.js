const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const cancelBtn = document.getElementById('cancel-btn');
const clearBtn = document.getElementById('clear-btn');
const messagesEl = document.getElementById('messages');
const statusText = document.getElementById('status-text');
const timerEl = document.getElementById('timer');
const tokensEl = document.getElementById('tokens-stat');
const ramInfo = document.getElementById('ram-info');
const errorContainer = document.getElementById('error-container');
const errorContent = document.getElementById('error-content');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');

const tempSlider = document.getElementById('temp-slider');
const tempValue = document.getElementById('temp-value');
const tempHint = document.getElementById('temp-hint');
const tokensSlider = document.getElementById('tokens-slider');
const tokensValue = document.getElementById('tokens-value');
const hwInfoText = document.getElementById('hw-info-text');

const inputTokensEl = document.getElementById('input-tokens');
const ctxUsedEl = document.getElementById('ctx-used');
const ctxMaxEl = document.getElementById('ctx-max');
const ctxProgressFill = document.getElementById('ctx-progress-fill');

const NUM_CTX = 8192;
const PROMPT_TEMPLATE_OVERHEAD = 350;

let timerInterval = null;
let startTime = 0;

const STORAGE_KEY = 'rizzgpt-settings';

const defaultSettings = {
  temperature: 0.8,
  maxTokens: 384
};

function loadSettings() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...defaultSettings, ...parsed };
    }
  } catch {}
  return { ...defaultSettings };
}

function saveSettings() {
  const settings = {
    temperature: parseFloat(tempValue.value),
    maxTokens: parseInt(tokensValue.value)
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function applySettings(settings) {
  tempSlider.value = settings.temperature;
  tempValue.value = settings.temperature;
  tokensSlider.value = settings.maxTokens;
  tokensValue.value = settings.maxTokens;
  updateTempHint(settings.temperature);
}

function updateTempHint(temp) {
  if (temp > 1.2) {
    tempHint.textContent = 'Высокая температура — модель может галлюцинировать';
    tempHint.classList.add('warning');
  } else if (temp >= 0.7) {
    tempHint.textContent = '0.3–0.5: сценарии | 0.7–1.0: креатив | 1.2+: хаос';
    tempHint.classList.remove('warning');
  } else {
    tempHint.textContent = 'Низкая температура — стабильные шаблоны, меньше креатива';
    tempHint.classList.remove('warning');
  }
}

// Settings panel toggle
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.add('open');
  settingsOverlay.classList.remove('hidden');
});

function closeSettings() {
  settingsPanel.classList.remove('open');
  settingsOverlay.classList.add('hidden');
  saveSettings();
}

settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// Slider sync
tempSlider.addEventListener('input', () => {
  tempValue.value = tempSlider.value;
  updateTempHint(parseFloat(tempSlider.value));
  saveSettings();
});

tempValue.addEventListener('input', () => {
  let v = parseFloat(tempValue.value);
  if (isNaN(v)) v = 0.8;
  v = Math.max(0, Math.min(2, v));
  tempSlider.value = v;
  updateTempHint(v);
  saveSettings();
});

tokensSlider.addEventListener('input', () => {
  tokensValue.value = tokensSlider.value;
  saveSettings();
});

tokensValue.addEventListener('input', () => {
  let v = parseInt(tokensValue.value);
  if (isNaN(v)) v = 384;
  v = Math.max(64, Math.min(1024, v));
  tokensSlider.value = v;
  saveSettings();
});


// Token estimation
function estimateTokens(text) {
  if (!text) return 0;
  const CyrillicChars = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const asciiChars = text.length - CyrillicChars;
  return Math.ceil(CyrillicChars / 1.5) + Math.ceil(asciiChars / 4);
}

function updateInputTokenCount() {
  const text = messageInput.value;
  const tokens = estimateTokens(text);
  inputTokensEl.textContent = tokens;
}

function updateContextBar(usedTokens) {
  ctxUsedEl.textContent = usedTokens;
  ctxMaxEl.textContent = NUM_CTX;
  const pct = Math.min(100, (usedTokens / NUM_CTX) * 100);
  ctxProgressFill.style.width = pct + '%';
  ctxProgressFill.className = '';
  if (pct > 80) ctxProgressFill.classList.add('danger');
  else if (pct > 60) ctxProgressFill.classList.add('warn');
}

messageInput.addEventListener('input', updateInputTokenCount);

// Initial context bar
updateContextBar(PROMPT_TEMPLATE_OVERHEAD);

// RAM stats
function updateRam() {
  fetch('/api/stats')
    .then(r => r.json())
    .then(d => {
      ramInfo.textContent = `RAM: ${d.used} MB / ${d.total} MB (${d.percent}%)`;
      hwInfoText.textContent = '';
      const lines = [
        `CPU: ${d.cpuModel}`,
        `Ядер: ${d.cores}`,
        `RAM: ${(d.total / 1024).toFixed(1)} GB`,
        `Свободно: ${(d.free / 1024).toFixed(1)} GB`,
        '',
        'Рекомендации:',
        '- Квантование: Q4_K_M',
        '- Max tokens: до 1024',
        '- CPU-only режим'
      ];
      hwInfoText.textContent = lines.join('\n');
    })
    .catch(() => {});
}

setInterval(updateRam, 5000);
updateRam();

// Status helpers
function setStatus(text) {
  statusText.textContent = text;
}

function showTimer(show) {
  timerEl.classList.toggle('hidden', !show);
}

function showTokens(show) {
  tokensEl.classList.toggle('hidden', !show);
}

function startTimer() {
  startTime = Date.now();
  showTimer(true);
  timerInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    timerEl.textContent = `${elapsed} с`;
  }, 100);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderMarkdown(text) {
  let html = escapeHtml(text);

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code}</code></pre>`;
  });

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  html = html.replace(/^---+$/gm, '<hr>');

  html = html.replace(/^\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  const lines = html.split('\n');
  const result = [];
  let inOl = false;
  let inUl = false;

  for (const line of lines) {
    const olMatch = line.match(/^(\d+)\.\s+(.*)$/);
    const ulMatch = line.match(/^[-*]\s+(.*)$/);

    if (olMatch) {
      if (!inOl) { if (inUl) { result.push('</ul>'); inUl = false; } result.push('<ol>'); inOl = true; }
      result.push(`<li>${olMatch[2]}</li>`);
    } else if (ulMatch) {
      if (!inUl) { if (inOl) { result.push('</ol>'); inOl = false; } result.push('<ul>'); inUl = true; }
      result.push(`<li>${ulMatch[1]}</li>`);
    } else {
      if (inOl) { result.push('</ol>'); inOl = false; }
      if (inUl) { result.push('</ul>'); inUl = false; }
      result.push(line);
    }
  }
  if (inOl) result.push('</ol>');
  if (inUl) result.push('</ul>');

  html = result.join('\n');

  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<br>(<h[123]>)/g, '$1');
  html = html.replace(/(<\/h[123]>)<br>/g, '$1');
  html = html.replace(/<br>(<pre>)/g, '$1');
  html = html.replace(/(<\/pre>)<br>/g, '$1');
  html = html.replace(/<br>(<ol>)/g, '$1');
  html = html.replace(/(<\/ol>)<br>/g, '$1');
  html = html.replace(/<br>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<br>/g, '$1');
  html = html.replace(/<br>(<blockquote>)/g, '$1');
  html = html.replace(/(<\/blockquote>)<br>/g, '$1');
  html = html.replace(/<br>(<hr>)/g, '$1');
  html = html.replace(/(<hr>)<br>/g, '$1');

  return html;
}

function addMessage(text, type) {
  const div = document.createElement('div');
  div.className = `message ${type}`;
  div.innerHTML = type === 'llm' ? renderMarkdown(text) : escapeHtml(text);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function showError(title, details) {
  errorContainer.classList.remove('hidden');
  let html = `<h3>${escapeHtml(title)}</h3>`;
  if (Array.isArray(details)) {
    html += '<ol>';
    details.forEach(d => { html += `<li>${escapeHtml(d)}</li>`; });
    html += '</ol>';
  } else {
    html += `<p>${escapeHtml(String(details))}</p>`;
  }
  errorContent.innerHTML = html;
}

function hideError() {
  errorContainer.classList.add('hidden');
}

function setLoading(loading) {
  sendBtn.disabled = loading;
  messageInput.disabled = loading;
}

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;

  hideError();
  addMessage(text, 'user');
  messageInput.value = '';
  setLoading(true);
  cancelBtn.classList.remove('hidden');
  setStatus('Отправка...');
  startTimer();

  const settings = {
    temperature: parseFloat(tempValue.value) || 0.8,
    maxTokens: parseInt(tokensValue.value) || 384
  };

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, ...settings })
  }).then(async (response) => {
    if (response.status === 429) {
      const err = await response.json();
      setStatus(err.error);
      setLoading(false);
      cancelBtn.classList.add('hidden');
      stopTimer();
      showTimer(false);
      return;
    }

    if (response.status === 503) {
      const err = await response.json();
      showError(err.error, err.instructions);
      setStatus('Ошибка');
      setLoading(false);
      cancelBtn.classList.add('hidden');
      stopTimer();
      showTimer(false);
      return;
    }

    if (!response.ok) {
      setStatus('Ошибка');
      setLoading(false);
      cancelBtn.classList.add('hidden');
      stopTimer();
      showTimer(false);
      return;
    }

    let llmMessage = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        if (part.startsWith('data: ')) {
          const jsonStr = part.slice(6);
          if (!jsonStr) continue;
          try {
            const event = JSON.parse(jsonStr);
            switch (event.type) {
              case 'token':
                if (!llmMessage) {
                  llmMessage = addMessage('', 'llm');
                }
                llmMessage.textContent += event.content;
                llmMessage.innerHTML = renderMarkdown(llmMessage.textContent);
                messagesEl.scrollTop = messagesEl.scrollHeight;
                break;
              case 'status':
                setStatus(event.text);
                break;
              case 'done':
                stopTimer();
                showTimer(false);
                showTokens(true);
                tokensEl.textContent = `${event.tokens} токенов за ${event.elapsed} с`;
                updateContextBar(PROMPT_TEMPLATE_OVERHEAD + estimateTokens(text) + event.tokens);
                break;
              case 'error':
                showError('Ошибка', event.text);
                setStatus('Ошибка');
                break;
            }
          } catch (e) {
            console.warn('Parse error:', e);
          }
        }
      }
    }

    setLoading(false);
    cancelBtn.classList.add('hidden');
  }).catch((err) => {
    showError('Ошибка соединения', err.message);
    setStatus('Ошибка');
    setLoading(false);
    cancelBtn.classList.add('hidden');
    stopTimer();
    showTimer(false);
  });
}

function cancelGeneration() {
  fetch('/api/cancel', { method: 'POST' }).catch(() => {});
  setStatus('Генерация отменена');
  setLoading(false);
  cancelBtn.classList.add('hidden');
  stopTimer();
  showTimer(false);
}

// Init
const savedSettings = loadSettings();
applySettings(savedSettings);

sendBtn.addEventListener('click', sendMessage);
cancelBtn.addEventListener('click', cancelGeneration);
clearBtn.addEventListener('click', () => {
  messagesEl.innerHTML = `
    <div class="message llm welcome-msg">
      Привет! Я RizzGPT — генератор юмористических подкатов. Опиши ситуацию или девушку, а я предложу 3 дерзких варианта с рейтингом.
    </div>
  `;
  hideError();
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
