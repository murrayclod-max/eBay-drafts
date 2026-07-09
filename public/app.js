// ─── State ────────────────────────────────────────────────────────────────────
let currentListing = null;   // the generated/edited listing extras (category, shipping, etc.)
let previewUrls = [];        // photo URLs for the gallery (data: for new, /uploads/ for saved)
let mainPhotoIndex = 0;
let editingDraftId = null;   // set when editing an existing saved draft
let pendingPublish = null;   // draft object queued in the publish modal

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkEbayStatus();
  checkUrlParams();
  bindEvents();
  refreshDraftCount();
});

function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('ebay') === 'connected') showBanner('eBay connected!', 'success');
  if (params.get('ebay') === 'error') showBanner('eBay connection failed. Try again.', 'error');
  window.history.replaceState({}, '', '/app');
}

async function checkEbayStatus() {
  try {
    const res = await fetch('/ebay/status');
    const { connected } = await res.json();
    if (!connected) {
      showBanner('eBay not connected — you can still generate and save drafts. Publishing live needs eBay.', 'warn', true);
    }
  } catch {}
}

function showBanner(text, type, showConnect = false) {
  const banner = document.getElementById('ebay-banner');
  document.getElementById('ebay-banner-text').textContent = text;
  document.getElementById('ebay-connect-link').style.display = showConnect ? 'inline-block' : 'none';
  banner.className = `ebay-banner banner-${type}`;
  banner.style.display = 'flex';
  if (type === 'success') setTimeout(() => banner.style.display = 'none', 3000);
}

// ─── Events ───────────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('photo-input').addEventListener('change', handlePhotoSelect);
  document.getElementById('add-photo-input').addEventListener('change', handleAddPhotos);
  document.getElementById('generate-btn').addEventListener('click', generateListing);

  document.getElementById('r-title').addEventListener('input', function () {
    document.getElementById('title-count').textContent = `${this.value.length}/80`;
  });

  document.getElementById('save-btn').addEventListener('click', saveDraft);
  document.getElementById('start-over-btn').addEventListener('click', resetToUpload);
  document.getElementById('list-another-btn').addEventListener('click', resetToUpload);
  document.getElementById('view-drafts-btn').addEventListener('click', () => switchView('drafts'));
  document.getElementById('published-drafts-btn').addEventListener('click', () => switchView('drafts'));

  // Nav tabs
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.addEventListener('click', () => switchView(t.dataset.view)));

  // Local/eBay draft-store toggle (eBay side disabled until Listing API approval)
  document.querySelectorAll('.mode-opt').forEach(b => b.addEventListener('click', () => {
    if (b.disabled) return;
    document.querySelectorAll('.mode-opt').forEach(x => x.classList.toggle('active', x === b));
  }));

  // Publish modal
  document.getElementById('publish-cancel').addEventListener('click', closePublishModal);
  document.getElementById('publish-confirm').addEventListener('click', doPublish);

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST' });
    window.location.href = '/';
  });
}

// ─── View / tab switching ──────────────────────────────────────────────────────
function switchView(view) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'drafts') { loadDrafts(); showStep('drafts'); }
  else { showStep('upload'); }
}

// ─── Photo Handling ───────────────────────────────────────────────────────────
function handlePhotoSelect(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  previewUrls = new Array(files.length);
  mainPhotoIndex = 0;

  const placeholder = document.getElementById('photo-placeholder');
  const preview = document.getElementById('photo-preview');
  preview.innerHTML = '';
  placeholder.style.display = 'none';
  preview.style.display = 'grid';

  files.forEach((file, i) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      previewUrls[i] = ev.target.result;
      const img = document.createElement('img');
      img.src = ev.target.result;
      img.className = 'preview-thumb';
      preview.appendChild(img);
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('generate-btn').disabled = false;
}

// ─── Gallery (with add / remove) ────────────────────────────────────────────────
function buildGallery() {
  const mainImg = document.getElementById('gallery-main');
  const thumbsEl = document.getElementById('gallery-thumbs');
  const noHint = document.getElementById('no-photo-hint');
  const galHint = document.getElementById('gallery-hint');
  thumbsEl.innerHTML = '';

  if (!previewUrls.length) {
    mainImg.src = ''; mainImg.style.display = 'none';
    noHint.style.display = 'flex'; galHint.style.display = 'none';
    return;
  }
  if (mainPhotoIndex >= previewUrls.length) mainPhotoIndex = 0;
  mainImg.style.display = 'block';
  noHint.style.display = 'none'; galHint.style.display = 'block';
  mainImg.src = previewUrls[mainPhotoIndex];

  previewUrls.forEach((url, i) => {
    const div = document.createElement('div');
    div.className = 'g-thumb' + (i === mainPhotoIndex ? ' g-thumb-active' : '');
    div.innerHTML = `<img src="${url}" alt="Photo ${i + 1}"><span class="g-main-tag">MAIN</span><button class="g-remove" title="Remove photo">✕</button>`;
    div.querySelector('img').addEventListener('click', () => { mainPhotoIndex = i; buildGallery(); });
    div.querySelector('.g-remove').addEventListener('click', (e) => { e.stopPropagation(); removePhoto(i); });
    thumbsEl.appendChild(div);
  });
}

// Add photos to the current listing/draft (uploads to the volume, then appends)
async function handleAddPhotos(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  const status = document.getElementById('add-photo-status');
  status.textContent = `Uploading ${files.length} photo${files.length > 1 ? 's' : ''}…`;
  status.style.display = 'block';
  const fd = new FormData();
  files.forEach(f => fd.append('photos', f));
  try {
    const res = await fetch('/upload-photos', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    if (!currentListing) currentListing = {};
    if (!Array.isArray(currentListing.photoFiles)) currentListing.photoFiles = [];
    data.files.forEach(f => { currentListing.photoFiles.push(f); previewUrls.push(`/uploads/${f}`); });
    buildGallery();
    status.style.display = 'none';
  } catch (err) {
    status.textContent = err.message;
  } finally {
    e.target.value = '';
  }
}

function removePhoto(i) {
  previewUrls.splice(i, 1);
  if (currentListing && Array.isArray(currentListing.photoFiles)) currentListing.photoFiles.splice(i, 1);
  if (mainPhotoIndex >= previewUrls.length) mainPhotoIndex = Math.max(0, previewUrls.length - 1);
  buildGallery();
}

// ─── Generate Listing ─────────────────────────────────────────────────────────
async function generateListing() {
  const btn = document.getElementById('generate-btn');
  const errEl = document.getElementById('generate-error');
  const photos = document.getElementById('photo-input').files;

  errEl.style.display = 'none';
  btn.textContent = 'Analyzing…';
  btn.disabled = true;

  const formData = new FormData();
  Array.from(photos).forEach(f => formData.append('photos', f));
  formData.append('description', document.getElementById('description').value);
  formData.append('weight', document.getElementById('item-weight').value);
  formData.append('size', document.getElementById('item-size').value);

  try {
    const res = await fetch('/generate', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');
    editingDraftId = null;
    currentListing = data;
    populateReview(data);
    showStep('review');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
    btn.textContent = 'Generate Listing';
    btn.disabled = false;
  }
}

function populateReview(listing) {
  mainPhotoIndex = 0;
  document.getElementById('r-title').value = listing.title || '';
  document.getElementById('title-count').textContent = `${(listing.title || '').length}/80`;
  document.getElementById('r-condition').value = listing.condition || 'USED_GOOD';
  document.getElementById('r-condition-note').value = listing.conditionNote || '';
  document.getElementById('r-price').value = listing.price || '';
  document.getElementById('r-description').value = listing.description || '';
  document.getElementById('r-category').textContent = listing.categoryName || '—';
  document.getElementById('r-shipping').textContent = listing.shippingNote || '—';

  if (listing.weightEstimate) document.getElementById('item-weight').value = listing.weightEstimate;
  if (listing.sizeEstimate) document.getElementById('item-size').value = listing.sizeEstimate;
  const dim = document.getElementById('dimensions-note');
  if (listing.dimensionsNote) { dim.textContent = '📐 ' + listing.dimensionsNote; dim.style.display = 'block'; }
  else dim.style.display = 'none';

  const flatCard = document.getElementById('flat-rate-card');
  if (listing.flatRateOption) {
    document.getElementById('flat-rate-name').textContent = listing.flatRateOption;
    document.getElementById('flat-rate-price').textContent = `$${Number(listing.flatRatePrice || 0).toFixed(2)} flat`;
    document.getElementById('flat-rate-reason').textContent = listing.flatRateReason || '';
    document.getElementById('flat-rate-badge').style.display = listing.flatRateRecommended ? 'inline-block' : 'none';
    flatCard.className = 'flat-rate-card' + (listing.flatRateRecommended ? ' flat-rate-recommended' : '');
    flatCard.style.display = 'block';
  } else flatCard.style.display = 'none';

  buildGallery();
}

// ─── Save to My Drafts (local, on the volume) ──────────────────────────────────
function collectListing() {
  const photoFiles = [...(currentListing?.photoFiles || [])];
  if (mainPhotoIndex > 0 && mainPhotoIndex < photoFiles.length) {
    const [main] = photoFiles.splice(mainPhotoIndex, 1);
    photoFiles.unshift(main);
  }
  return {
    ...(currentListing || {}),
    title: document.getElementById('r-title').value,
    condition: document.getElementById('r-condition').value,
    conditionNote: document.getElementById('r-condition-note').value,
    price: document.getElementById('r-price').value,
    description: document.getElementById('r-description').value,
    photoFiles,
  };
}

async function saveDraft() {
  const btn = document.getElementById('save-btn');
  const errEl = document.getElementById('save-error');
  errEl.style.display = 'none';
  btn.textContent = 'Saving…';
  btn.disabled = true;

  const payload = collectListing();
  try {
    const url = editingDraftId ? `/drafts/${editingDraftId}` : '/drafts';
    const res = await fetch(url, {
      method: editingDraftId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Save failed');
    refreshDraftCount();
    showStep('success');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.textContent = '💾 Save to My Drafts';
    btn.disabled = false;
  }
}

// ─── My Drafts list ─────────────────────────────────────────────────────────────
async function loadDrafts() {
  const listEl = document.getElementById('drafts-list');
  const emptyEl = document.getElementById('drafts-empty');
  listEl.innerHTML = '<p class="drafts-loading">Loading…</p>';
  let drafts = [];
  try { drafts = await (await fetch('/drafts')).json(); } catch {}
  updateDraftCount(drafts.length);
  listEl.innerHTML = '';
  emptyEl.style.display = drafts.length ? 'none' : 'block';

  drafts.forEach(d => {
    const thumb = (d.photoFiles && d.photoFiles[0]) ? `/uploads/${d.photoFiles[0]}` : '';
    const card = document.createElement('div');
    card.className = 'draft-card';
    card.innerHTML = `
      <div class="draft-thumb">${thumb ? `<img src="${thumb}" alt="">` : '📦'}</div>
      <div class="draft-info">
        <div class="draft-title">${escapeHtml(d.title || 'Untitled')}</div>
        <div class="draft-meta">$${Number(d.price || 0).toFixed(2)} · ${escapeHtml(d.categoryName || '—')}</div>
      </div>
      <div class="draft-actions">
        <button class="btn-mini" data-act="edit">Edit</button>
        <button class="btn-mini btn-mini-primary" data-act="publish">List on eBay</button>
        <button class="btn-mini btn-mini-danger" data-act="delete">✕</button>
      </div>`;
    card.querySelector('[data-act=edit]').addEventListener('click', () => openDraft(d));
    card.querySelector('[data-act=publish]').addEventListener('click', () => openPublishModal(d));
    card.querySelector('[data-act=delete]').addEventListener('click', () => deleteDraft(d.id));
    listEl.appendChild(card);
  });
}

function openDraft(d) {
  editingDraftId = d.id;
  currentListing = { ...d };
  previewUrls = (d.photoFiles || []).map(f => `/uploads/${f}`);
  populateReview(d);
  showStep('review');
}

async function deleteDraft(id) {
  if (!confirm('Delete this draft?')) return;
  await fetch(`/drafts/${id}`, { method: 'DELETE' });
  loadDrafts();
  refreshDraftCount();
}

// ─── Publish (live) ─────────────────────────────────────────────────────────────
function openPublishModal(draft) {
  pendingPublish = draft;
  document.getElementById('publish-modal-title').textContent = draft.title || '';
  document.getElementById('publish-modal-error').style.display = 'none';
  const btn = document.getElementById('publish-confirm');
  btn.textContent = 'List it live';
  btn.disabled = false;
  document.getElementById('publish-modal').style.display = 'flex';
}
function closePublishModal() {
  document.getElementById('publish-modal').style.display = 'none';
  pendingPublish = null;
}
async function doPublish() {
  if (!pendingPublish) return;
  const btn = document.getElementById('publish-confirm');
  const errEl = document.getElementById('publish-modal-error');
  errEl.style.display = 'none';
  btn.textContent = 'Listing…';
  btn.disabled = true;
  try {
    const res = await fetch('/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingPublish),
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.needsConnect) { closePublishModal(); showBanner('Connect your eBay account first.', 'warn', true); return; }
      throw new Error(data.error || 'Publish failed');
    }
    // mark the draft published, then show success
    await fetch(`/drafts/${pendingPublish.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published', listingId: data.listingId }),
    });
    closePublishModal();
    document.getElementById('published-link').href = data.url;
    showStep('published');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
    btn.textContent = 'List it live';
    btn.disabled = false;
  }
}

// ─── Draft count badge ──────────────────────────────────────────────────────────
async function refreshDraftCount() {
  try { updateDraftCount((await (await fetch('/drafts')).json()).length); } catch {}
}
function updateDraftCount(n) {
  const badge = document.getElementById('drafts-count');
  badge.textContent = n;
  badge.style.display = n > 0 ? 'inline-block' : 'none';
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function showStep(step) {
  ['upload', 'review', 'success', 'published', 'drafts'].forEach(s => {
    const el = document.getElementById('step-' + s);
    if (el) el.style.display = s === step ? 'block' : 'none';
  });
  window.scrollTo(0, 0);
}

function resetToUpload() {
  currentListing = null;
  previewUrls = [];
  mainPhotoIndex = 0;
  editingDraftId = null;
  document.getElementById('photo-input').value = '';
  document.getElementById('photo-preview').innerHTML = '';
  document.getElementById('photo-preview').style.display = 'none';
  document.getElementById('photo-placeholder').style.display = 'flex';
  document.getElementById('description').value = '';
  document.getElementById('generate-btn').disabled = true;
  document.getElementById('generate-btn').textContent = 'Generate Listing';
  document.getElementById('generate-error').style.display = 'none';
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'upload'));
  showStep('upload');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
