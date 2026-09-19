// Photo slideshow engine.
//
// Two full-screen canvases crossfade. Each photo is decoded once, then drawn
// cover-cropped onto a viewport-sized canvas — so decoded memory is bounded by
// the display resolution no matter how large the source file is (a 100MP scan
// costs ~viewport pixels, not ~source pixels). At most two photos are held in
// memory at any time; references are dropped after each transition.

const FADE_MS = 2300; // must stay >= the CSS .slide transition duration

export function initSlideshow(cfg) {
  const slides = [...document.querySelectorAll('#slideshow .slide')];
  if (slides.length < 2) return;
  let [front, back] = slides;

  const intervalMs = Math.max(5, Number(cfg.photoIntervalSeconds) || 300) * 1000;

  let photos = [];
  let index = -1;
  let currentImg = null; // last successfully decoded image (kept for resize redraws)
  let busy = false;
  let lastListFetch = 0;

  function sizeCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
  }

  function drawCover(canvas, img) {
    const ctx = canvas.getContext('2d');
    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }

  function loadPhoto(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`photo failed to decode: ${url}`));
      img.src = url;
    });
  }

  async function refreshList() {
    try {
      const res = await fetch('/api/photos');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Only replace the list when we actually got photos: an empty response
      // (directory temporarily unavailable) must not blank out the slideshow.
      if (Array.isArray(data.photos) && data.photos.length > 0) {
        photos = data.photos;
        lastListFetch = Date.now();
      }
    } catch (err) {
      console.warn('[photos] list refresh failed, keeping current:', err.message);
    }
  }

  /**
   * Try to load any decodable photo, in random order, excluding excludeIndex.
   * Returns { img, index } or null when nothing loads (e.g. every file is
   * corrupt) — the caller keeps showing whatever is already on screen.
   */
  async function loadAnyPhoto(excludeIndex = -1) {
    const candidates = [];
    for (let i = 0; i < photos.length; i++) if (i !== excludeIndex) candidates.push(i);
    // Fisher-Yates shuffle so we don't always start at the same file.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    for (const i of candidates) {
      try {
        return { img: await loadPhoto(`/photos/${encodeURIComponent(photos[i])}`), index: i };
      } catch (err) {
        console.warn('[photos] skipping photo:', err.message);
      }
    }
    return null;
  }

  async function showNext() {
    if (busy || photos.length < 2) return; // nothing to rotate to
    busy = true;
    try {
      const loaded = await loadAnyPhoto(index); // never immediately repeat the current photo
      if (!loaded) return; // every candidate failed: keep showing the current one
      const img = loaded.img;
      index = loaded.index;

      sizeCanvas(back);
      drawCover(back, img);
      back.classList.add('active');
      await new Promise((r) => setTimeout(r, FADE_MS));
      [front, back] = [back, front];
      back.classList.remove('active');
      currentImg = img; // old image becomes garbage here (canvas holds the pixels)
    } finally {
      busy = false;
    }
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      sizeCanvas(front);
      sizeCanvas(back);
      if (currentImg) drawCover(front, currentImg);
    }, 400);
  });

  async function start() {
    sizeCanvas(front);
    sizeCanvas(back);
    await refreshList();
    if (photos.length > 0) {
      const loaded = await loadAnyPhoto(); // skips corrupt files on first paint too
      if (loaded) {
        index = loaded.index;
        currentImg = loaded.img;
        drawCover(front, loaded.img);
        front.classList.add('active');
      } else {
        console.warn('[photos] no decodable photos found yet — waiting for the directory to populate');
      }
    } else {
      console.warn('[photos] no photos found yet — waiting for the directory to populate');
    }
    setInterval(async () => {
      if (Date.now() - lastListFetch > 5 * 60_000) await refreshList();
      await showNext();
    }, intervalMs);
  }

  start().catch((err) => console.error('[photos] slideshow failed to start:', err));
}
