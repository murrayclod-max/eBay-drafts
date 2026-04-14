// ─── State ────────────────────────────────────────────────────────────────────
let currentListing = null;
let previewUrls = [];
let mainPhotoIndex = 0;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkEbayStatus();
  checkUrlParams();
  bindEvents();
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
      showBanner('eBay not connected — you can still generate listings, but saving to drafts requires eBay.', 'warn', true);
    }
  } catch {}
}

function showBanner(text, type, showConnect = false) {
  const banner = document.getElementById('ebay-banner');
  const bannerText = document.getElementById('ebay-banner-text');
  const connectLink = document.getElementById('ebay-connect-link');
  bannerText.textContent = text;
  banner.className = `ebay-banner banner-${type}`;
  banner.style.display = 'flex';
  connectLink.style.display = showConnect ? 'inline-block' : 'none';
  if (type === 'success') setTimeout(() => banner.style.display = 'none', 3000);
}

// ─── Events ───────────────────────────────────────────────────────────────────
function bindEvents() {
  // Photo input — label wraps input, so clicking label naturally opens picker
  const photoInput = document.getElementById('photo-input');
  photoInput.addEventListener('change', handlePhotoSelect);

  // Generate
  document.getElementById('generate-btn').addEventListener('click', generateListing);

  // Review fields
  document.getElementById('r-title').addEventListener('input', function () {
    document.getElementById('title-count').textContent = `${this.value.length}/80`;
  });

  // Save draft
  document.getElementById('save-btn').addEventListener('click', saveDraft);

  // Navigation
  document.getElementById('start-over-btn').addEventListener('click', resetToUpload);
  document.getElementById('list-another-btn').addEventListener('click', resetToUpload);

  // Logout
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST' });
    window.location.href = '/';
  });
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

  let loaded = 0;
  files.forEach((file, i) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      previewUrls[i] = ev.target.result;
      const img = document.createElement('img');
      img.src = ev.target.result;
      img.className = 'preview-thumb';
      preview.appendChild(img);
      loaded++;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('generate-btn').disabled = false;
}

// ─── Gallery ──────────────────────────────────────────────────────────────────
function buildGallery() {
  mainPhotoIndex = 0;
  const mainImg = document.getElementById('gallery-main');
  const thumbsEl = document.getElementById('gallery-thumbs');
  thumbsEl.innerHTML = '';

  if (!previewUrls.length) return;
  mainImg.src = previewUrls[0];

  previewUrls.forEach((url, i) => {
    const div = document.createElement('div');
    div.className = 'g-thumb' + (i === 0 ? ' g-thumb-active' : '');
    div.innerHTML = `<img src="${url}" alt="Photo ${i+1}"><span class="g-main-tag">MAIN</span>`;
    div.addEventListener('click', () => {
      mainPhotoIndex = i;
      mainImg.src = url;
      document.querySelectorAll('.g-thumb').forEach((t, j) => {
        t.classList.toggle('g-thumb-active', j === i);
      });
    });
    thumbsEl.appendChild(div);
  });
}

// ─── Generate Listing ─────────────────────────────────────────────────────────
async function generateListing() {
  const btn = document.getElementById('generate-btn');
  const errEl = document.getElementById('generate-error');
  const photos = document.getElementById('photo-input').files;
  const description = document.getElementById('description').value;

  errEl.style.display = 'none';
  btn.textContent = 'Analyzing photos...';
  btn.disabled = true;

  const weight = document.getElementById('item-weight').value;
  const size = document.getElementById('item-size').value;

  const formData = new FormData();
  Array.from(photos).forEach(f => formData.append('photos', f));
  formData.append('description', description);
  formData.append('weight', weight);
  formData.append('size', size);

  try {
    const res = await fetch('/generate', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Generation failed');

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
  document.getElementById('r-title').value = listing.title || '';
  document.getElementById('title-count').textContent = `${(listing.title || '').length}/80`;
  document.getElementById('r-condition').value = listing.condition || 'USED_GOOD';
  document.getElementById('r-condition-note').value = listing.conditionNote || '';
  document.getElementById('r-price').value = listing.price || '';
  document.getElementById('r-description').value = listing.description || '';
  document.getElementById('r-category').textContent = listing.categoryName || '—';
  document.getElementById('r-shipping').textContent = listing.shippingNote || '—';

  // Auto-fill weight & size dropdowns from Claude's estimates
  if (listing.weightEstimate) document.getElementById('item-weight').value = listing.weightEstimate;
  if (listing.sizeEstimate) document.getElementById('item-size').value = listing.sizeEstimate;
  if (listing.dimensionsNote) {
    document.getElementById('dimensions-note').textContent = '📐 ' + listing.dimensionsNote;
    document.getElementById('dimensions-note').style.display = 'block';
  }

  // Flat rate recommendation
  const flatCard = document.getElementById('flat-rate-card');
  if (listing.flatRateOption) {
    document.getElementById('flat-rate-name').textContent = listing.flatRateOption;
    document.getElementById('flat-rate-price').textContent = `$${listing.flatRatePrice?.toFixed(2)} flat`;
    document.getElementById('flat-rate-reason').textContent = listing.flatRateReason || '';
    const badge = document.getElementById('flat-rate-badge');
    badge.style.display = listing.flatRateRecommended ? 'inline-block' : 'none';
    flatCard.className = 'flat-rate-card' + (listing.flatRateRecommended ? ' flat-rate-recommended' : '');
    flatCard.style.display = 'block';
  } else {
    flatCard.style.display = 'none';
  }

  buildGallery();
}

// ─── Save Draft ───────────────────────────────────────────────────────────────
async function saveDraft() {
  const btn = document.getElementById('save-btn');
  const errEl = document.getElementById('save-error');

  errEl.style.display = 'none';
  btn.textContent = 'Saving to eBay...';
  btn.disabled = true;

  // Reorder so selected main photo is first
  const photoFiles = [...(currentListing?.photoFiles || [])];
  if (mainPhotoIndex > 0 && mainPhotoIndex < photoFiles.length) {
    const [main] = photoFiles.splice(mainPhotoIndex, 1);
    photoFiles.unshift(main);
  }

  const payload = {
    title: document.getElementById('r-title').value,
    condition: document.getElementById('r-condition').value,
    conditionNote: document.getElementById('r-condition-note').value,
    price: document.getElementById('r-price').value,
    description: document.getElementById('r-description').value,
    photoFiles,
  };

  try {
    const res = await fetch('/save-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (!res.ok) {
      if (data.needsConnect) {
        showBanner('Connect your eBay account first.', 'warn', true);
        btn.textContent = 'Save to eBay Drafts';
        btn.disabled = false;
        return;
      }
      throw new Error(data.error || 'Save failed');
    }

    showStep('success');

  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
    btn.textContent = 'Save to eBay Drafts';
    btn.disabled = false;
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function showStep(step) {
  document.getElementById('step-upload').style.display = step === 'upload' ? 'block' : 'none';
  document.getElementById('step-review').style.display = step === 'review' ? 'block' : 'none';
  document.getElementById('step-success').style.display = step === 'success' ? 'block' : 'none';
  window.scrollTo(0, 0);
}

function resetToUpload() {
  currentListing = null;
  previewUrls = [];
  mainPhotoIndex = 0;
  document.getElementById('photo-input').value = '';
  document.getElementById('photo-preview').innerHTML = '';
  document.getElementById('photo-preview').style.display = 'none';
  document.getElementById('photo-placeholder').style.display = 'flex';
  document.getElementById('description').value = '';
  document.getElementById('generate-btn').disabled = true;
  document.getElementById('generate-btn').textContent = 'Generate Listing';
  document.getElementById('generate-error').style.display = 'none';
  showStep('upload');
}
