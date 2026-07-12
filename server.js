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

const CONTEXT_STRATEGIES = {
  'unload': '0',
  '5min': '5m',
  '10min': '10m'
};

const NUM_CTX = 4096;

let isGenerating = false;
let cancelRequested = false;
let currentAbortController = null;

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


const PROMPT_TEMPLATE = `Ты — эксперт по флирту и юмористическим подкатам. Генерируешь умные, смешные и дерзкие подкаты.

Ситуация пользователя:
---
{user_message}
---

Сгенерируй ровно 3 варианта подката. Формат:
1. [текст подката] — рейтинг: X/10
2. [текст подката] — рейтинг: X/10
3. [текст подката] — рейтинг: X/10

Правила:
- Будь дерзким и вульгарным, если просит пользователь
- Используй игру слов, иронию, абсурд
- Каждый подкат должен быть уникальным по стилю
- Не используй markdown-разметку
- Используй форматирование
- Кратко поясни выбор рейтинга в одну строку после каждого`;

function buildPrompt(userMessage) {
  return PROMPT_TEMPLATE.replace('{user_message}', userMessage);
}

app.post('/api/chat', async (req, res) => {
  if (isGenerating) {
    return res.status(429).json({ error: 'Модель занята, подождите завершения текущего запроса' });
  }

  const { message, temperature, maxTokens, contextStrategy } = req.body;
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

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const modelReady = await ensureModel(res, MODEL_TAG);
  if (!modelReady) {
    sseJson(res, { type: 'error', text: 'Не удалось подготовить модель' });
    res.end();
    return;
  }

  isGenerating = true;
  cancelRequested = false;
  currentAbortController = new AbortController();

  sseJson(res, { type: 'status', text: 'Загрузка модели в RAM...' });
  logRamUsage();

  const startTime = Date.now();
  const safeTemp = Math.max(0, Math.min(2, parseFloat(temperature) || 0.8));
  const safeTokens = Math.max(64, Math.min(1024, parseInt(maxTokens) || 384));
  const keepAlive = CONTEXT_STRATEGIES[contextStrategy] || '0';
  const prompt = buildPrompt(message);

  sseJson(res, { type: 'status', text: `Модель: ${MODEL_TAG} | temp=${safeTemp} | tokens=${safeTokens} | ctx=${NUM_CTX} | keep_alive=${keepAlive}` });

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
          temperature: safeTemp,
          top_p: 0.9,
          num_ctx: NUM_CTX,
          num_predict: safeTokens,
          keep_alive: keepAlive
        }
      }),
      signal: currentAbortController.signal
    });

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text();
      sseJson(res, { type: 'error', text: 'Ошибка модели. Попробуйте ещё раз' });
      isGenerating = false;
      currentAbortController = null;
      res.end();
      return;
    }

    sseJson(res, { type: 'status', text: 'Генерация...' });

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';

    while (true) {
      if (cancelRequested) {
        reader.cancel();
        break;
      }

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
            fullResponse += parsed.response;
            sseJson(res, { type: 'token', content: parsed.response });
          }
          if (parsed.done) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const tokens = parsed.eval_count || 0;
            sseJson(res, { type: 'done', elapsed, tokens, fullResponse });
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      sseJson(res, { type: 'status', text: 'Генерация отменена' });
    } else {
      sseJson(res, { type: 'error', text: 'Ошибка при генерации' });
    }
  }

  isGenerating = false;
  currentAbortController = null;

  sseJson(res, { type: 'status', text: 'Выгрузка модели из RAM...' });
  logRamUsage();
  sseJson(res, { type: 'status', text: 'Готово' });
  res.end();
});

app.post('/api/cancel', (req, res) => {
  if (currentAbortController) {
    cancelRequested = true;
    currentAbortController.abort();
    currentAbortController = null;
  }
  isGenerating = false;
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

async function start() {
  console.log(`[INFO] Проверка Ollama...`);
  const ollamaOk = await checkOllama();
  if (!ollamaOk) {
    console.log(`[WARN] Ollama не обнаружен на ${OLLAMA_HOST}`);
    console.log(`[WARN] Запустите: ollama serve`);
  } else {
    console.log(`[INFO] Ollama доступен на ${OLLAMA_HOST}`);
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
