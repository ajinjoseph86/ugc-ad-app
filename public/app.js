const state = {
  characterMode: 'upload',
  productMode: 'upload',
  characterPhotos: [null, null, null, null, null],
  productPhotos: [null, null, null, null, null],
  currentVideoId: null,
};

const els = {
  characterPhotoInputs: [0, 1, 2, 3, 4].map((i) => document.getElementById(`character-photo-${i}`)),
  characterSlotWrap: document.getElementById('character-slot-wrap'),
  characterDescription: document.getElementById('character-description'),
  productPhotoInputs: [0, 1, 2, 3, 4].map((i) => document.getElementById(`product-photo-${i}`)),
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

// kie.ai Seedance 2 Fast, 480p, image-reference (no video input) rate.
const COST_PER_SECOND_USD = 0.0775;

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
    item.innerHTML = `
      <video src="${entry.resultUrl}" muted loop playsinline></video>
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
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`/api/status/${id}`);
    const entry = await res.json();
    if (!res.ok) {
      throw new Error(entry.error || 'Could not check generation status.');
    }
    if (entry.status === 'success') return entry;
    if (entry.status === 'fail') throw new Error(entry.error || 'Ad video generation failed.');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Generation timed out.');
}

// ---------- init ----------

refreshBudget();
refreshHistory();
