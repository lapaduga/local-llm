const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const cancelBtn = document.getElementById('cancel-btn');
const clearBtn = document.getElementById('clear-btn');
const messagesEl = document.getElementById('messages');
const statusText = document.getElementById('status-text');
const timerEl = document.getElementById('timer');
const tokensEl = document.getElementById('tokens-stat');
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

const STORAGE_KEY = 'haiku-settings';

let timerInterval = null;
let startTime = 0;

function loadSettings() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return { temperature: 0.8, maxTokens: 384, ...JSON.parse(saved) };
  } catch {}
  return { temperature: 0.8, maxTokens: 384 };
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    temperature: parseFloat(tempValue.value),
    maxTokens: parseInt(tokensValue.value)
  }));
}

function applySettings(s) {
  tempSlider.value = s.temperature;
  tempValue.value = s.temperature;
  tokensSlider.value = s.maxTokens;
  tokensValue.value = s.maxTokens;
}

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.add('open');
  settingsOverlay.classList.remove('hidden');
});

settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

function closeSettings() {
  settingsPanel.classList.remove('open');
  settingsOverlay.classList.add('hidden');
  saveSettings();
}

tempSlider.addEventListener('input', () => { tempValue.value = tempSlider.value; saveSettings(); });
tempValue.addEventListener('input', () => { tempSlider.value = tempValue.value; saveSettings(); });
tokensSlider.addEventListener('input', () => { tokensValue.value = tokensSlider.value; saveSettings(); });
tokensValue.addEventListener('input', () => { tokensSlider.value = tokensValue.value; saveSettings(); });

function setStatus(text) { statusText.textContent = text; }
function showTimer(show) { timerEl.classList.toggle('hidden', !show); }
function showTokens(show) { tokensEl.classList.toggle('hidden', !show); }

function startTimer() {
  startTime = Date.now();
  showTimer(true);
  timerInterval = setInterval(() => {
    timerEl.textContent = `${((Date.now() - startTime) / 1000).toFixed(1)} с`;
  }, 100);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderMarkdown(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function addMessage(text, type) {
  const div = document.createElement('div');
  div.className = `message ${type}`;
  div.innerHTML = type === 'llm' ? renderMarkdown(text) : escapeHtml(text);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function showError(text) {
  errorContainer.classList.remove('hidden');
  errorContent.innerHTML = `<p>${escapeHtml(text)}</p>`;
}

function hideError() { errorContainer.classList.add('hidden'); }
function setLoading(loading) { sendBtn.disabled = loading; messageInput.disabled = loading; }

let currentRequestId = null;

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

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, temperature: parseFloat(tempValue.value), maxTokens: parseInt(tokensValue.value) })
  }).then(async (response) => {
    if (response.status === 503) {
      showError('Ollama не запущен');
      finish();
      return;
    }
    if (!response.ok) {
      showError('Ошибка сервера');
      finish();
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
        if (!part.startsWith('data: ')) continue;
        try {
          const e = JSON.parse(part.slice(6));
          if (e.type === 'requestId') currentRequestId = e.id;
          if (e.type === 'token') {
            if (!llmMessage) llmMessage = addMessage('', 'llm');
            llmMessage.textContent += e.content;
            llmMessage.innerHTML = renderMarkdown(llmMessage.textContent);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
          if (e.type === 'status') setStatus(e.text);
          if (e.type === 'done') {
            showTokens(true);
            tokensEl.textContent = `${e.tokens} токенов за ${e.elapsed} с`;
          }
          if (e.type === 'error') showError(e.text);
        } catch {}
      }
    }

    currentRequestId = null;
    setLoading(false);
    cancelBtn.classList.add('hidden');
    stopTimer();
    showTimer(false);
  }).catch(() => {
    showError('Ошибка соединения');
    finish();
  });
}

function finish() {
  setLoading(false);
  cancelBtn.classList.add('hidden');
  stopTimer();
  showTimer(false);
  setStatus('Ошибка');
}

function cancelGeneration() {
  if (currentRequestId) {
    fetch('/api/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: currentRequestId })
    }).catch(() => {});
  }
  currentRequestId = null;
  finish();
}

applySettings(loadSettings());
sendBtn.addEventListener('click', sendMessage);
cancelBtn.addEventListener('click', cancelGeneration);
clearBtn.addEventListener('click', () => {
  messagesEl.innerHTML = `<div class="message llm welcome-msg">Привет! Напиши тему — получишь 3 хокку.</div>`;
  hideError();
});
messageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
