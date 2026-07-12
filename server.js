const express = require('express');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL_BASE = process.env.MODEL || 'qwen2.5:3b';
const MAX_THREADS = parseInt(process.env.MAX_THREADS) || 4;
const MODEL_TAG = MODEL_BASE;
const NUM_CTX = 8192;
const NUM_BATCH = 512;

const activeRequests = new Map();

async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

function sseJson(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function ensureModel(res, modelTag) {
  try {
    const listRes = await fetch(`${OLLAMA_HOST}/api/tags`);
    const list = await listRes.json();
    const hasModel = (list.models || []).some(m => m.name === modelTag || m.name.startsWith(modelTag + ':'));
    if (hasModel) return true;
    sseJson(res, { type: 'error', text: `Модель ${modelTag} не найдена на сервере` });
    return false;
  } catch {
    return false;
  }
}

function buildPrompt(userMessage) {
  return `Напиши 3 хокку на тему "${userMessage}". Только русские слова. Без пояснений.

Хокку 1:
строка 1
строка 2
строка 3

Хокку 2:
строка 1
строка 2
строка 3

Хокку 3:
строка 1
строка 2
строка 3

Ответ:`;
}

app.post('/api/chat', async (req, res) => {
  const { message, temperature, maxTokens } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Сообщение не может быть пустым' });
  }
  if (message.length > 5000) {
    return res.status(400).json({ error: 'Сообщение слишком длинное (макс. 5000 символов)' });
  }

  const ollamaOk = await checkOllama();
  if (!ollamaOk) {
    return res.status(503).json({ error: 'Ollama не запущен' });
  }

  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const abortController = new AbortController();
  activeRequests.set(requestId, abortController);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  sseJson(res, { type: 'requestId', id: requestId });

  const modelReady = await ensureModel(res, MODEL_TAG);
  if (!modelReady) {
    activeRequests.delete(requestId);
    res.end();
    return;
  }

  const startTime = Date.now();
  const safeTemp = Math.max(0, Math.min(2, parseFloat(temperature) || 0.8));
  const safeTokens = Math.max(64, Math.min(1024, parseInt(maxTokens) || 384));
  const prompt = buildPrompt(message);

  try {
    const ollamaRes = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_TAG,
        prompt: prompt,
        stream: true,
        options: {
          num_gpu: 0,
          num_thread: MAX_THREADS,
          num_batch: NUM_BATCH,
          temperature: safeTemp,
          top_p: 0.9,
          num_ctx: NUM_CTX,
          num_predict: safeTokens,
          keep_alive: -1,
          stop: ['Ответ:', '---']
        }
      }),
      signal: abortController.signal
    });

    if (!ollamaRes.ok) {
      sseJson(res, { type: 'error', text: 'Ошибка модели' });
      activeRequests.delete(requestId);
      res.end();
      return;
    }

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.response) {
            sseJson(res, { type: 'token', content: parsed.response });
          }
          if (parsed.done) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const tokens = parsed.eval_count || 0;
            sseJson(res, { type: 'done', elapsed, tokens });
          }
        } catch {}
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      sseJson(res, { type: 'error', text: 'Ошибка при генерации' });
    }
  }

  activeRequests.delete(requestId);
  res.end();
});

app.post('/api/cancel', (req, res) => {
  const { requestId } = req.body;
  const controller = activeRequests.get(requestId);
  if (controller) {
    controller.abort();
    activeRequests.delete(requestId);
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

async function preloadModel() {
  try {
    console.log(`[INFO] Preloading ${MODEL_TAG}...`);
    const start = Date.now();
    await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_TAG, prompt: 'hi', stream: false, keep_alive: -1, options: { num_ctx: NUM_CTX, num_predict: 1 } })
    });
    console.log(`[INFO] Model loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch {}
}

async function start() {
  const ollamaOk = await checkOllama();
  if (ollamaOk) {
    await preloadModel();
  } else {
    console.log(`[WARN] Ollama not found on ${OLLAMA_HOST}`);
  }
  app.listen(PORT, () => console.log(`[INFO] Server on port ${PORT}`));
}

start();
