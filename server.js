const express = require('express');
const os = require('os');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL_BASE = process.env.MODEL || 'qwen2.5:3b';
const MAX_THREADS = parseInt(process.env.MAX_THREADS) || 4;

const MODEL_TAG = MODEL_BASE;

const NUM_CTX = 8192;
const NUM_BATCH = 512;

const activeRequests = new Map();

function logRamUsage() {
  const free = os.freemem();
  const total = os.totalmem();
  const used = total - free;
  const percent = ((used / total) * 100).toFixed(1);
  console.log(`[RAM] ${(used / 1024 / 1024 / 1024).toFixed(1)} GB / ${(total / 1024 / 1024 / 1024).toFixed(1)} GB (${percent}%)`);
}

function ramStats() {
  const free = os.freemem();
  const total = os.totalmem();
  return {
    free: Math.floor(free / 1024 / 1024),
    total: Math.floor(total / 1024 / 1024),
    used: Math.floor((total - free) / 1024 / 1024),
    percent: Number(((total - free) / total * 100).toFixed(1)),
    cores: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || 'Unknown'
  };
}

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
  } catch (err) {
    return false;
  }
}

app.get('/api/stats', (req, res) => {
  res.json(ramStats());
});


const PROMPT_TEMPLATE = `Напиши 3 хокку на тему: {user_message}

Отвечай ТОЛЬКО на русском языке. Без пояснений и комментариев.

Формат ответа — ровно так, как показано below (каждая строка хокку идёт с нового абзаца):

первая строка хокку
вторая строка хокku
третья строка хокку

первая строка второго хокку
вторая строка второго хокku
третья строка второго хокku

первая строка третьего хокку
вторая строка третьего хокku
третья строка третьего хокku`;

function buildPrompt(userMessage) {
  return PROMPT_TEMPLATE.replace('{user_message}', userMessage);
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
    return res.status(503).json({
      error: 'Ollama не запущен',
      instructions: [
        'Установите Ollama: https://ollama.com/download',
        'Запустите в терминале: ollama serve',
        'Убедитесь, что сервер доступен на http://localhost:11434',
        'Затем перезагрузите эту страницу'
      ]
    });
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
    sseJson(res, { type: 'error', text: 'Не удалось подготовить модель' });
    activeRequests.delete(requestId);
    res.end();
    return;
  }

  const startTime = Date.now();
  const safeTemp = Math.max(0, Math.min(2, parseFloat(temperature) || 0.8));
  const safeTokens = Math.max(64, Math.min(1024, parseInt(maxTokens) || 384));
  const prompt = buildPrompt(message);

  sseJson(res, { type: 'status', text: `Модель: ${MODEL_TAG} | temp=${safeTemp} | tokens=${safeTokens} | ctx=${NUM_CTX}` });

  try {
    const ollamaRes = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_TAG,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        options: {
          num_gpu: 0,
          num_thread: MAX_THREADS,
          num_batch: NUM_BATCH,
          temperature: safeTemp,
          top_p: 0.9,
          num_ctx: NUM_CTX,
          num_predict: safeTokens,
          keep_alive: -1
        }
      }),
      signal: abortController.signal
    });

    if (!ollamaRes.ok) {
      sseJson(res, { type: 'error', text: 'Ошибка модели. Попробуйте ещё раз' });
      activeRequests.delete(requestId);
      res.end();
      return;
    }

    sseJson(res, { type: 'status', text: 'Генерация...' });

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';

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
          if (parsed.message && parsed.message.content) {
            fullResponse += parsed.message.content;
            sseJson(res, { type: 'token', content: parsed.message.content });
          }
          if (parsed.done) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const tokens = parsed.eval_count || 0;
            const cleaned = fullResponse
              .replace(/\\\n/g, '\n')
              .replace(/\\n/g, '\n')
              .replace(/([а-яё])([А-ЯЁ])/g, '$1 $2')
              .replace(/([.!?])([А-ЯЁ])/g, '$1\n\n$2')
              .replace(/,([А-ЯЁ])/g, ',\n$1')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            sseJson(res, { type: 'done', elapsed, tokens, fullResponse: cleaned });
          }
        } catch {}
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      sseJson(res, { type: 'status', text: 'Генерация отменена' });
    } else {
      sseJson(res, { type: 'error', text: 'Ошибка при генерации' });
    }
  }

  activeRequests.delete(requestId);
  sseJson(res, { type: 'status', text: 'Готово' });
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
    console.log(`[INFO] Preloading model ${MODEL_TAG}...`);
    const start = Date.now();
    await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL_TAG, messages: [{ role: 'user', content: 'hi' }], keep_alive: -1, options: { num_ctx: NUM_CTX, num_predict: 1 } })
    });
    console.log(`[INFO] Model loaded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch {}
}

async function start() {
  console.log(`[INFO] Проверка Ollama...`);
  const ollamaOk = await checkOllama();
  if (!ollamaOk) {
    console.log(`[WARN] Ollama не обнаружен на ${OLLAMA_HOST}`);
    console.log(`[WARN] Запустите: ollama serve`);
  } else {
    console.log(`[INFO] Ollama доступен на ${OLLAMA_HOST}`);
    await preloadModel();
  }

  const stats = ramStats();
  app.listen(PORT, () => {
    console.log(`[INFO] Сервер запущен на http://localhost:${PORT}`);
    console.log(`[INFO] CPU: ${stats.cpuModel} (${stats.cores} cores)`);
    console.log(`[INFO] RAM: ${(stats.total / 1024).toFixed(1)} GB`);
    logRamUsage();
  });
}

start();
