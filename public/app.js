const state = {
  characterMode: 'upload',
  productMode: 'upload',
  characterPhotos: [null, null, null],
  productPhotos: [null, null, null],
  currentVideoId: null,
};

const els = {
  characterPhotoInputs: [0, 1, 2].map((i) => document.getElementById(`character-photo-${i}`)),
  characterSlotWrap: document.getElementById('character-slot-wrap'),
  characterDescription: document.getElementById('character-description'),
  productPhotoInputs: [0, 1, 2].map((i) => document.getElementById(`product-photo-${i}`)),
  productSlotWrap: document.getElementById('product-slot-wrap'),
  productDescription: document.getElementById('product-description'),
  prompt: document.getElementById('prompt'),
  aspectRatio: document.getElementById('aspect-ratio'),
  duration: document.getElementById('duration'),
  durationReadout: document.getElementById('duration-readout'),
  generateBtn: document.getElementById('generate-btn'),
  generateBtnText: document.getElementById('generate-btn-text'),
  costBadge: document.getElementById('cost-badge'),
  errorText: document.getElementById('error-text'),
  previewPlaceholder: document.getElementById('preview-placeholder'),
  previewVideo: document.getElementById('preview-video'),
  previewLoading: document.getElementById('preview-loading'),
  progressText: document.getElementById('progress-text'),
  progressBarFill: document.getElementById('progress-bar-fill'),
  downloadBtn: document.getElementById('download-btn'),
  gallery: document.getElementById('gallery'),
  budgetPill: document.getElementById('budget-pill'),
  budgetText: document.getElementById('budget-text'),
};

// ---------- mode tabs (upload vs describe) ----------

document.querySelectorAll('.mode-tabs').forEach((tabs) => {
  const target = tabs.dataset.target;
  tabs.querySelectorAll('.mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      tabs.querySelectorAll('.mode-tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll(`.mode-panel[data-panel="${target}"]`).forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.mode !== mode);
      });
      if (target === 'character') state.characterMode = mode;
      if (target === 'product') state.productMode = mode;
    });
  });
});

// ---------- photo slots ----------

function setupPhotoSlot(input, onChange) {
  const slot = input.closest('.photo-slot');
  input.addEventListener('change', () => {
    const file = input.files?.[0] || null;
    onChange(file);
    renderSlot(slot, file);
  });
}

function renderSlot(slot, file) {
  const existingThumb = slot.querySelector('img.thumb');
  const existingRemove = slot.querySelector('.remove-btn');
  if (existingThumb) existingThumb.remove();
  if (existingRemove) existingRemove.remove();

  if (!file) {
    slot.classList.remove('filled');
    return;
  }

  slot.classList.add('filled');
  const img = document.createElement('img');
  img.className = 'thumb';
  img.src = URL.createObjectURL(file);
  slot.appendChild(img);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn';
  removeBtn.innerHTML = '&times;';
  removeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = slot.querySelector('input[type="file"]');
    input.value = '';
    input.dispatchEvent(new Event('change'));
  });
  slot.appendChild(removeBtn);
}

els.characterPhotoInputs.forEach((input, index) => {
  setupPhotoSlot(input, (file) => { state.characterPhotos[index] = file; });
});
els.productPhotoInputs.forEach((input, index) => {
  setupPhotoSlot(input, (file) => { state.productPhotos[index] = file; });
});

// ---------- duration readout ----------

// kie.ai Seedance 2.5, 480p, image-reference (no video input) rate.
const COST_PER_SECOND_USD = 0.140;

function updateCostBadge() {
  const cost = Number(els.duration.value) * COST_PER_SECOND_USD;
  els.costBadge.textContent = `~$${cost.toFixed(2)}`;
}

els.duration.addEventListener('input', () => {
  els.durationReadout.textContent = `${els.duration.value} seconds`;
  updateCostBadge();
});

updateCostBadge();

// ---------- budget ----------

async function refreshBudget() {
  try {
    const res = await fetch('/api/budget');
    const data = await res.json();
    els.budgetText.textContent = `$${data.remainingUsd.toFixed(2)} left of today's budget`;
    els.budgetPill.classList.toggle('low', data.remainingUsd < 1);
  } catch (err) {
    // non-fatal
  }
}

// ---------- prompt details ----------

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const promptDetailsEl = document.getElementById('prompt-details');

function renderInputs(inputs) {
  if (!inputs) return '';
  const card = (label, thumbUrl, description) =>
    '<div class="input-card">' +
      (thumbUrl
        ? '<img src="' + escapeHtml(thumbUrl) + '" alt="' + escapeHtml(label) + '" />'
        : '<div class="input-desc">' + escapeHtml(description || '') + '</div>') +
      '<span>' + escapeHtml(label) + (thumbUrl ? '' : ' (described)') + '</span>' +
    '</div>';
  const parts = [];
  if ((inputs.characterThumbs || []).length) {
    inputs.characterThumbs.forEach((u, i) => parts.push(card('Character ' + (i + 1), u)));
  } else if (inputs.characterDescription) {
    parts.push(card('Character', null, inputs.characterDescription));
  }
  if ((inputs.productThumbs || []).length) {
    inputs.productThumbs.forEach((u, i) => parts.push(card('Product ' + (i + 1), u)));
  } else if (inputs.productDescription) {
    parts.push(card('Product', null, inputs.productDescription));
  }
  if (!parts.length) return '';
  return '<h3>Used inputs</h3><div class="input-grid">' + parts.join('') + '</div>';
}

function renderPromptDetails(info) {
  const meta = [
    info.artStyle,
    info.aspectRatio,
    info.duration ? info.duration + 's' : '',
    info.createdAt ? new Date(info.createdAt).toLocaleString() : '',
  ].filter(Boolean).map(escapeHtml).join(' · ');
  const finalBlock = info.finalPrompt
    ? '<details><summary>Show the full written prompt</summary><pre>' + escapeHtml(info.finalPrompt) + '</pre>' +
      '<button type="button" class="copy-btn" id="copy-final-prompt">Copy written prompt</button></details>'
    : '';
  promptDetailsEl.innerHTML =
    '<h3>Prompt</h3><div class="prompt-meta">' + meta + '</div>' +
    '<p class="prompt-text">' + escapeHtml(info.promptText || '') + '</p>' + renderInputs(info.inputs) + finalBlock;
  promptDetailsEl.classList.remove('hidden');
  const copyBtn = document.getElementById('copy-final-prompt');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(info.finalPrompt).then(() => { copyBtn.textContent = 'Copied'; }).catch(() => {});
    });
  }
}

async function showPromptDetails(entry) {
  if (!promptDetailsEl) return;
  renderPromptDetails({
    promptText: entry.promptText || entry.prompt,
    finalPrompt: entry.finalPrompt || entry.expandedPrompt,
    artStyle: entry.artStyle,
    aspectRatio: entry.aspectRatio,
    duration: entry.duration,
    createdAt: entry.createdAt,
    inputs: entry.inputs,
  });
  if (entry.finalPrompt || entry.expandedPrompt) return;
  try {
    const res = await fetch('/api/history/' + entry.id);
    if (!res.ok) return;
    const full = await res.json();
    if (state.currentVideoId === entry.id) renderPromptDetails(full);
  } catch (err) {
    // non-fatal: the short prompt is already shown
  }
}

// ---------- history / gallery ----------

async function refreshHistory() {
  try {
    const res = await fetch('/api/history');
    const history = await res.json();
    renderGallery(history);
  } catch (err) {
    // non-fatal
  }
}

function renderGallery(history) {
  els.gallery.innerHTML = '';
  const done = history.filter((entry) => entry.status === 'success');
  if (!done.length) {
    els.gallery.innerHTML = '<p class="gallery-empty">No ads generated yet.</p>';
    return;
  }
  done.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.title = entry.promptText || '';
    item.innerHTML = `
      <video src="${entry.resultUrl}" muted loop playsinline></video>
      <div class="gallery-caption">${escapeHtml(entry.promptText || '')}</div>
      <a class="gallery-download" href="${entry.resultUrl}" download title="Download">&#8681;</a>
    `;
    const video = item.querySelector('video');
    item.addEventListener('mouseenter', () => video.play().catch(() => {}));
    item.addEventListener('mouseleave', () => { video.pause(); video.currentTime = 0; });
    item.addEventListener('click', (e) => {
      if (e.target.closest('.gallery-download')) return;
      showResult(entry);
    });
    els.gallery.appendChild(item);
  });
}

function showResult(entry) {
  els.previewPlaceholder.classList.add('hidden');
  els.previewVideo.src = entry.resultUrl;
  els.previewVideo.classList.remove('hidden');
  els.downloadBtn.classList.remove('hidden');
  els.downloadBtn.href = entry.resultUrl;
  state.currentVideoId = entry.id;
  showPromptDetails(entry);
}

// ---------- generate ----------

function showError(message) {
  els.errorText.textContent = message;
}

function setLoading(isLoading) {
  els.generateBtn.disabled = isLoading;
  els.generateBtnText.textContent = isLoading ? 'Generating…' : 'Generate Ad Video';
  els.previewLoading.classList.toggle('hidden', !isLoading);
  if (isLoading) {
    showError('');
    els.progressText.textContent = 'Starting…';
    els.progressBarFill.style.width = '0%';
  }
}

function updateProgress(entry) {
  if (entry.stage === 'writing prompt') {
    els.progressText.textContent = 'Writing the prompt…';
    els.progressBarFill.style.width = '15%';
  } else if (entry.stage === 'generating video') {
    els.progressText.textContent = 'Generating your ad…';
    els.progressBarFill.style.width = '55%';
  } else {
    els.progressText.textContent = 'Starting…';
    els.progressBarFill.style.width = '3%';
  }
}

els.generateBtn.addEventListener('click', async () => {
  showError('');

  if (state.characterMode === 'upload' && !state.characterPhotos[0]) {
    return showError('Upload a character photo, or switch to Describe.');
  }
  if (state.characterMode === 'describe' && !els.characterDescription.value.trim()) {
    return showError('Describe the character, or switch to Upload.');
  }
  if (state.productMode === 'upload' && !state.productPhotos[0]) {
    return showError('Upload a product photo, or switch to Describe.');
  }
  if (state.productMode === 'describe' && !els.productDescription.value.trim()) {
    return showError('Describe the product, or switch to Upload.');
  }
  if (!els.prompt.value.trim()) {
    return showError('Describe the scene/script for the ad.');
  }

  const formData = new FormData();
  formData.append('characterMode', state.characterMode);
  formData.append('productMode', state.productMode);
  if (state.characterMode === 'upload') {
    state.characterPhotos.filter(Boolean).forEach((file) => formData.append('characterPhoto', file));
  } else {
    formData.append('characterDescription', els.characterDescription.value.trim());
  }
  if (state.productMode === 'upload') {
    state.productPhotos.filter(Boolean).forEach((file) => formData.append('productPhoto', file));
  } else {
    formData.append('productDescription', els.productDescription.value.trim());
  }
  formData.append('prompt', els.prompt.value.trim());
  formData.append('aspectRatio', els.aspectRatio.value);
  formData.append('duration', els.duration.value);

  setLoading(true);

  try {
    const res = await fetch('/api/generate', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Generation failed.');
    }

    const entry = await pollForResult(data.id);

    els.previewPlaceholder.classList.add('hidden');
    els.previewVideo.src = `${entry.resultUrl}?t=${Date.now()}`;
    els.previewVideo.classList.remove('hidden');
    els.previewVideo.play().catch(() => {});
    state.currentVideoId = entry.id;
    showPromptDetails(entry);
    els.downloadBtn.classList.remove('hidden');
    els.downloadBtn.href = entry.resultUrl;

    await refreshBudget();
    await refreshHistory();
  } catch (err) {
    showError(err.message || 'Something went wrong.');
    if (els.previewVideo.classList.contains('hidden')) {
      els.previewPlaceholder.classList.remove('hidden');
    }
  } finally {
    setLoading(false);
  }
});

async function pollForResult(id, { intervalMs = 4000, timeoutMs = 16 * 60 * 1000 } = {}) {
  const started = Date.now();
  let transientFailures = 0;
  while (Date.now() - started < timeoutMs) {
    // The host can briefly return an HTML error page (e.g. during a redeploy or restart).
    // Treat that as a transient blip and keep polling instead of failing the whole generation.
    let res;
    let entry;
    try {
      res = await fetch(`/api/status/${id}`);
      entry = await res.json();
      transientFailures = 0;
    } catch (err) {
      transientFailures += 1;
      if (transientFailures > 45) {
        throw new Error('Lost connection to the server while generating. Check the gallery in a minute — your video may still finish.');
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    if (!res.ok) {
      throw new Error(entry.error || 'Could not check generation status.');
    }
    updateProgress(entry);
    if (entry.status === 'success') return entry;
    if (entry.status === 'fail') throw new Error(entry.error || 'Ad video generation failed.');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Generation timed out.');
}

// ---------- init ----------

refreshBudget();
refreshHistory();
