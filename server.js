const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const fsp = fs.promises;

const app = express();
const PORT = process.env.PORT || 3000;
const KIE_API_KEY = process.env.KIE_API_KEY;
const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || '10.00');

// bytedance/seedance-2-5, 480p, no reference-video input ("no video" rate).
// Reference IMAGES do not change the pricing tier — only reference VIDEOS do.
const KIE_MODEL = 'bytedance/seedance-2-5';
const RESOLUTION = '480p';
const COST_PER_SECOND_USD = 0.140;
const KIE_ROOT = 'https://api.kie.ai';
const KIE_API_BASE = `${KIE_ROOT}/api/v1`;
const LLM_MODEL = 'claude-sonnet-5';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SPEND_FILE = path.join(DATA_DIR, 'spend.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const GENERATED_DIR = process.env.GENERATED_DIR || path.join(__dirname, 'public', 'generated');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');

for (const dir of [DATA_DIR, GENERATED_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json());

// ---------- per-visitor client id (so each browser only sees its own gallery) ----------

const CLIENT_COOKIE = 'ugc_client_id';

function getClientId(req, res) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp(`${CLIENT_COOKIE}=([^;]+)`));
  if (match) return match[1];

  const id = uuidv4();
  res.setHeader(
    'Set-Cookie',
    `${CLIENT_COOKIE}=${id}; Path=/; Max-Age=${60 * 60 * 24 * 365}; HttpOnly; SameSite=Lax`
  );
  return id;
}

app.use((req, res, next) => {
  req.clientId = getClientId(req, res);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/generated', express.static(GENERATED_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  // Up to 5 character + 5 product reference photos.
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
});

// ---------- date / budget helpers (Asia/Singapore) ----------

function todayKeySGT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function getTodaySpend() {
  const spend = await readJson(SPEND_FILE, {});
  return spend[todayKeySGT()] || 0;
}

async function addSpend(amount) {
  const spend = await readJson(SPEND_FILE, {});
  const key = todayKeySGT();
  spend[key] = (spend[key] || 0) + amount;
  await writeJson(SPEND_FILE, spend);
  return spend[key];
}

async function appendHistory(entry) {
  const history = await readJson(HISTORY_FILE, []);
  history.unshift(entry);
  await writeJson(HISTORY_FILE, history.slice(0, 200));
  return history;
}

// ---------- kie.ai helpers ----------

// kie.ai's own infra returns transient 5xx/429s under load, on top of the usual network
// hiccups (TLS blips, DNS timeouts) — neither should kill an otherwise-good generation.
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(url, options, { retries = 4, delayMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, options);
      if (RETRYABLE_STATUS_CODES.has(res.status) && attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

async function kieCreateTask(input) {
  const res = await fetchWithRetry(`${KIE_API_BASE}/jobs/createTask`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: KIE_MODEL, input }),
  });
  const body = await res.json();
  if (!res.ok || body.code !== 200) {
    throw new Error(body?.msg || `kie.ai createTask failed (${res.status})`);
  }
  return body.data.taskId;
}

async function kiePollResult(taskId, { timeoutMs = 15 * 60 * 1000, intervalMs = 4000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetchWithRetry(`${KIE_API_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${KIE_API_KEY}` },
    });
    const body = await res.json();
    if (!res.ok || body.code !== 200) {
      throw new Error(body?.msg || `kie.ai recordInfo failed (${res.status})`);
    }
    const { state, resultJson, failMsg } = body.data;
    if (state === 'success') {
      const result = JSON.parse(resultJson);
      if (!result.resultUrls || !result.resultUrls[0]) {
        throw new Error('kie.ai task succeeded but returned no video URL.');
      }
      return result.resultUrls[0];
    }
    if (state === 'fail') {
      throw new Error(failMsg || 'kie.ai generation failed.');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('kie.ai generation timed out.');
}

async function downloadToFile(url, destPath) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`failed to download result video (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buf);
}

// ---------- LLM prompt expansion ----------

const LLM_DIRECTOR_INSTRUCTIONS = `You are an expert cinematic UGC ad director, prompt engineer, and screenwriter for the Seedance video model. Given a character, a product, a short scene idea, and a target duration, write ONE complete, fully engineered Seedance prompt using the exact structure below. Output ONLY the finished prompt text — no headings like "Prompt:", no explanations, no markdown formatting, no commentary, no multiple options.

STRUCTURE TO FOLLOW, IN ORDER:

1. REFERENCE IMAGE LOCKS — for each role that has uploaded reference image(s), you will be told exactly which @image numbers belong to it. Write a block like:
"@image1 @image2 — THE CHARACTER. Take their face, hair, skin tone, build and physical appearance ENTIRELY from the uploaded reference image(s). Reproduce them exactly as they appear there. Do not alter, stylise or reinterpret any part of their appearance at any point in the clip."
"@image3 — THE PRODUCT. Take its exact shape, colour, packaging, label/branding, texture, material, size and proportions ENTIRELY from the uploaded reference image(s). Reproduce it exactly. No substitutions, no redesigns, no alternate colourways."
Use the EXACT @image numbers given to you for each role — never invent or guess numbers. If a role has no uploaded photo, skip the @image tag for it and instead write a short, vivid description of it from what was provided, with the same "do not alter" lock language.

2. CONSISTENCY LOCK — one short paragraph stating the character's appearance/clothing and the product's appearance must remain identical in every frame, and the environment/setting must not change at any point in the clip.

3. SCENE SETTING — one vivid paragraph establishing a specific, believable everyday location, lighting, and mood. Hyper-realistic UGC phone-shot aesthetic — not a studio commercial, not stock footage.

4. TIMESTAMPED BEAT-BY-BEAT BREAKDOWN — break the FULL given duration into short timestamped segments (roughly 2-4 seconds each, covering start to finish with no gaps, e.g. "0:00–0:03 — ..."). For each beat describe: what happens visually, camera framing/movement (handheld, push-in, whip pan, etc as fits), physical action and body language, and any dialogue spoken in that beat. The beats must add up to exactly the given duration — do not pad or run short.

5. AUDIO — state "GENERATE NATIVE AUDIO WITH THE VIDEO." then, only if the scene idea implies speech, list every spoken line with its exact timestamp and speaker, instructing accurate lip-sync, e.g. "0:04 — SHE says, warmly: '...'". Keep lines natural, casual, human — never a scripted influencer read, never generic clichés like "game changer" or "obsessed" unless they genuinely fit. Then describe the sound design: ambient/diegetic sounds specific to this scene and to the product interaction only. Explicitly state: NO MUSIC SCORE AT ANY POINT, no off-screen voiceover narration, no on-screen text.

6. CAMERA PACKAGE — one short paragraph: shot in a natural handheld phone-camera style (unless the scene idea clearly calls for something more cinematic), realistic lens distortion, natural frame rate/motion, no artificial cinematic gloss or commercial polish.

7. PHOTOREAL — one short paragraph: real skin texture with visible pores and small imperfections, no airbrushing, no plastic-smooth or model-like skin, natural fabric and hair movement, authentic physics, natural motion blur, live-action photographic realism — not rendered, not stylised, no CGI look, no watermark or logo bugs.

HARD RULES:
- Never show the product being opened, unboxed, or unwrapped unless the user's scene idea explicitly implies that action — if it does, describe the opening explicitly in the beat where it happens.
- Never invent unrealistic product claims, medical/financial claims, or exaggerated transformations.
- Keep the whole prompt tightly scoped to the given duration.`;

async function expandPromptWithLLM({
  characterMode,
  characterDescription,
  productMode,
  productDescription,
  characterImageCount,
  productImageCount,
  scenePrompt,
  duration,
  aspectRatio,
}) {
  let nextImageIndex = 1;
  let characterImageNote = '(description only, no reference photo)';
  if (characterMode === 'upload') {
    const indices = Array.from({ length: characterImageCount }, () => nextImageIndex++);
    characterImageNote = `has reference photo(s) @image${indices.join(' @image')}`;
  }
  let productImageNote = '(description only, no reference photo)';
  if (productMode === 'upload') {
    const indices = Array.from({ length: productImageCount }, () => nextImageIndex++);
    productImageNote = `has reference photo(s) @image${indices.join(' @image')}`;
  }

  const userMessage =
    `${LLM_DIRECTOR_INSTRUCTIONS}\n\n` +
    `Character: ${characterMode === 'describe' ? characterDescription : characterImageNote}\n` +
    `Product: ${productMode === 'describe' ? productDescription : productImageNote}\n` +
    `Scene idea from user: "${scenePrompt}"\n` +
    `Video duration: ${duration} seconds (exactly)\n` +
    `Aspect ratio: ${aspectRatio}\n\n` +
    'Write the final Seedance prompt now, following the structure exactly.';

  const res = await fetchWithRetry(`${KIE_ROOT}/claude/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: userMessage }],
      stream: false,
      max_tokens: 3000,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error?.message || body?.msg || `kie.ai LLM call failed (${res.status})`);
  }
  const textBlock = (body.content || []).find((b) => b.type === 'text' && b.text);
  if (!textBlock) {
    throw new Error('LLM prompt expansion returned no text.');
  }
  return textBlock.text.trim();
}

// ---------- prompt building ----------

function buildPrompt({
  prompt,
  characterMode,
  characterDescription,
  productMode,
  productDescription,
  characterImageCount,
  productImageCount,
}) {
  const notes = [];
  let refIndex = 0;

  function describeRefs(count) {
    const indices = [];
    for (let i = 0; i < count; i += 1) {
      refIndex += 1;
      indices.push(refIndex);
    }
    return indices.length > 1
      ? { label: `Reference images ${indices.join(', ')} show`, plural: true }
      : { label: `Reference image ${indices[0]} shows`, plural: false };
  }

  if (characterMode === 'upload') {
    const { label } = describeRefs(characterImageCount);
    notes.push(
      `${label} the exact character/person to feature — preserve their identity, face, skin, hair, and ` +
      'appearance exactly. Use this reference for identity only, not for the location, pose, framing, or scene setup.'
    );
  } else {
    notes.push(`Character: ${characterDescription}.`);
  }

  if (productMode === 'upload') {
    const { label } = describeRefs(productImageCount);
    notes.push(
      `${label} the exact product to feature — preserve its exact shape, colour, packaging, label/branding, ` +
      'texture, material, size, proportions, logo, and visible text exactly as shown. Show the product exactly ' +
      'as it appears in the reference — closed/sealed/as-packaged — and do NOT show it being opened, unboxed, ' +
      'or unwrapped unless the scene description below explicitly describes that action.'
    );
  } else {
    notes.push(`Product: ${productDescription}.`);
  }

  const styleGuide =
    'Style: hyper-realistic UGC (user-generated content) product ad, filmed as if a real creator casually shot it ' +
    'on their phone — not a polished commercial, studio shoot, or stock video. Vertical/social-media framing, ' +
    'handheld camera movement, natural imperfect composition, believable everyday location, natural daylight or ' +
    'realistic indoor lighting, no studio lighting or cinematic commercial polish. ' +
    'Natural skin texture with visible pores and small imperfections, no airbrushing, no plastic-smooth or ' +
    'model-like skin, realistic hand movement and product interaction, no floating product shots, no warped ' +
    'labels or distorted packaging. ' +
    'If the scene calls for the character to speak, render it as natural, clearly lip-synced on-camera dialogue — ' +
    'casual and human, not a scripted influencer read, and not off-screen voiceover narration. ' +
    'Sound design: ambient room tone and product-specific sound effects only — no background music, no on-screen text. ' +
    'Avoid generic influencer clichés ("game changer", "obsessed", "this changed my life") and avoid exaggerated or ' +
    'unrealistic product claims/transformations.';

  return `${notes.join(' ')} ${prompt} ${styleGuide}`;
}

// ---------- routes ----------

app.get('/api/budget', async (req, res) => {
  const spent = await getTodaySpend();
  res.json({
    date: todayKeySGT(),
    dailyBudgetUsd: DAILY_BUDGET_USD,
    spentUsd: Number(spent.toFixed(4)),
    remainingUsd: Number(Math.max(0, DAILY_BUDGET_USD - spent).toFixed(4)),
    costPerSecondUsd: COST_PER_SECOND_USD,
  });
});

app.get('/api/history', async (req, res) => {
  const history = await readJson(HISTORY_FILE, []);
  res.json(history.filter((entry) => entry.clientId === req.clientId));
});

app.get('/api/status/:id', async (req, res) => {
  const history = await readJson(HISTORY_FILE, []);
  const entry = history.find((h) => h.id === req.params.id && h.clientId === req.clientId);
  if (!entry) {
    return res.status(404).json({ error: 'Generation not found.' });
  }
  res.json(entry);
});

async function updateHistoryEntry(id, patch) {
  const history = await readJson(HISTORY_FILE, []);
  const entry = history.find((h) => h.id === id);
  if (!entry) return;
  Object.assign(entry, patch);
  await writeJson(HISTORY_FILE, history);
}

// Runs after the HTTP response has already been sent — kie.ai's Seedance generation averages
// several minutes, far longer than Render's reverse-proxy request timeout would allow.
async function processGeneration({
  id,
  scenePrompt,
  characterMode,
  characterDescription,
  productMode,
  productDescription,
  characterImageCount,
  productImageCount,
  referenceImageUrls,
  aspectRatio,
  duration,
  estimatedCost,
  tempUploadPaths,
}) {
  try {
    let finalPrompt;
    try {
      finalPrompt = await expandPromptWithLLM({
        characterMode,
        characterDescription,
        productMode,
        productDescription,
        characterImageCount,
        productImageCount,
        scenePrompt,
        duration,
        aspectRatio,
      });
    } catch (err) {
      // Prompt expansion is an enhancement, not a requirement — fall back to the static wrapper.
      console.error('prompt expansion failed, using fallback prompt:', err.message);
      finalPrompt = buildPrompt({
        prompt: scenePrompt,
        characterMode,
        characterDescription,
        productMode,
        productDescription,
        characterImageCount,
        productImageCount,
      });
    }

    const input = {
      prompt: finalPrompt,
      // Dialogue is a core part of the Scene/Script/Dialogue field — audio must be on for it to be heard/lip-synced.
      generate_audio: true,
      resolution: RESOLUTION,
      aspect_ratio: aspectRatio,
      duration,
    };
    if (referenceImageUrls.length) {
      input.reference_image_urls = referenceImageUrls;
    }

    const taskId = await kieCreateTask(input);
    const resultVideoUrl = await kiePollResult(taskId);

    const destFile = `${id}.mp4`;
    await downloadToFile(resultVideoUrl, path.join(GENERATED_DIR, destFile));
    const newTotal = await addSpend(estimatedCost);

    await updateHistoryEntry(id, {
      status: 'success',
      resultUrl: `/generated/${destFile}`,
      spentTodayUsd: Number(newTotal.toFixed(4)),
      expandedPrompt: finalPrompt,
    });
  } catch (err) {
    console.error('generate error:', err);
    await updateHistoryEntry(id, {
      status: 'fail',
      error: err.message || 'Ad video generation failed.',
    });
  } finally {
    // Reference photos only need to exist long enough for kie.ai to fetch them.
    for (const p of tempUploadPaths) {
      fsp.unlink(p).catch(() => {});
    }
  }
}

app.post(
  '/api/generate',
  upload.fields([
    { name: 'characterPhoto', maxCount: 3 },
    { name: 'productPhoto', maxCount: 3 },
  ]),
  async (req, res) => {
    const tempUploadPaths = [];
    try {
      if (!KIE_API_KEY) {
        return res.status(500).json({ error: 'Server is missing KIE_API_KEY. Add it to your .env file and restart.' });
      }

      const characterMode = req.body.characterMode === 'describe' ? 'describe' : 'upload';
      const productMode = req.body.productMode === 'describe' ? 'describe' : 'upload';
      const characterDescription = (req.body.characterDescription || '').trim();
      const productDescription = (req.body.productDescription || '').trim();
      const prompt = (req.body.prompt || '').trim();
      const aspectRatio = req.body.aspectRatio || '9:16';
      const duration = Math.min(30, Math.max(4, parseInt(req.body.duration, 10) || 5));

      const validAspectRatios = ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9'];
      if (!validAspectRatios.includes(aspectRatio)) {
        return res.status(400).json({ error: 'Unknown aspect ratio.' });
      }
      if (!prompt) {
        return res.status(400).json({ error: 'Describe the scene/script for the ad.' });
      }

      const characterFiles = (req.files?.characterPhoto || []).slice(0, 3);
      const productFiles = (req.files?.productPhoto || []).slice(0, 3);

      if (characterMode === 'upload' && !characterFiles.length) {
        return res.status(400).json({ error: 'Upload a character photo, or switch to Describe.' });
      }
      if (characterMode === 'describe' && !characterDescription) {
        return res.status(400).json({ error: 'Describe the character, or switch to Upload.' });
      }
      if (productMode === 'upload' && !productFiles.length) {
        return res.status(400).json({ error: 'Upload a product photo, or switch to Describe.' });
      }
      if (productMode === 'describe' && !productDescription) {
        return res.status(400).json({ error: 'Describe the product, or switch to Upload.' });
      }

      // ---- budget check BEFORE spending anything ----
      const estimatedCost = duration * COST_PER_SECOND_USD;
      const spentToday = await getTodaySpend();
      if (spentToday + estimatedCost > DAILY_BUDGET_USD) {
        return res.status(429).json({
          error: `Daily budget of $${DAILY_BUDGET_USD.toFixed(2)} reached. ` +
            `Spent $${spentToday.toFixed(2)} today. Try again after midnight (Asia/Singapore).`,
        });
      }

      // ---- temporarily host uploaded reference photos at a public URL so kie.ai can fetch them ----
      const origin = `${req.protocol}://${req.get('host')}`;
      const referenceImageUrls = [];

      async function stageUpload(file) {
        const fileName = `${uuidv4()}.jpg`;
        const destPath = path.join(UPLOADS_DIR, fileName);
        await sharp(file.buffer)
          .rotate()
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 88 })
          .toFile(destPath);
        tempUploadPaths.push(destPath);
        return `${origin}/uploads/${fileName}`;
      }

      for (const characterFile of characterFiles) {
        referenceImageUrls.push(await stageUpload(characterFile));
      }
      for (const productFile of productFiles) {
        referenceImageUrls.push(await stageUpload(productFile));
      }

      const id = uuidv4();
      const entry = {
        id,
        clientId: req.clientId,
        createdAt: new Date().toISOString(),
        prompt,
        aspectRatio,
        duration,
        status: 'pending',
        costUsd: estimatedCost,
      };
      await appendHistory(entry);

      // Respond immediately — Seedance generation (plus prompt expansion) runs well past any
      // reverse-proxy timeout, so both happen in the background after this response is sent.
      res.json({ id, status: 'pending' });

      processGeneration({
        id,
        scenePrompt: prompt,
        characterMode,
        characterDescription,
        productMode,
        productDescription,
        characterImageCount: characterFiles.length,
        productImageCount: productFiles.length,
        referenceImageUrls,
        aspectRatio,
        duration,
        estimatedCost,
        tempUploadPaths,
      });
    } catch (err) {
      console.error('generate error:', err);
      for (const p of tempUploadPaths) {
        fsp.unlink(p).catch(() => {});
      }
      res.status(500).json({ error: err.message || 'Ad video generation failed.' });
    }
  }
);

// multer errors (e.g. too many files) land here instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error('unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`UGC Ad Creator app running at http://localhost:${PORT}`);
  if (!KIE_API_KEY) {
    console.warn('WARNING: KIE_API_KEY is not set. Copy .env.example to .env and add your kie.ai API key.');
  }
});
