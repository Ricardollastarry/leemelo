/* Léemelo — lector en voz alta de documentos y fotos.
   Todo se procesa en el dispositivo: no se envía nada a ningún servidor. */
'use strict';

const $ = (id) => document.getElementById(id);
const synth = window.speechSynthesis;

/* ---------- Ajustes (se guardan en este dispositivo) ---------- */
const DEF = { voiceURI: '', rate: 1, pitch: 1, onlySpanish: true, ocrLang: 'spa', keepAwake: true, autoScroll: true };
let settings = { ...DEF };
try { Object.assign(settings, JSON.parse(localStorage.getItem('leemelo-settings') || '{}')); } catch (e) {}
const saveSettings = () => { try { localStorage.setItem('leemelo-settings', JSON.stringify(settings)); } catch (e) {} };

/* ---------- Biblioteca en IndexedDB ---------- */
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('leemelo', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('docs', mode); const st = t.objectStore('docs');
      const out = fn(st);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  get(id) { return this.tx('readonly', (s) => s.get(id)); },
  put(doc) { return this.tx('readwrite', (s) => s.put(doc)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
};

/* ---------- Utilidades de interfaz ---------- */
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function busy(on, text, pct) {
  $('busy').hidden = !on;
  if (text) $('busyText').textContent = text;
  const bar = $('busyBar');
  if (pct == null) bar.removeAttribute('value'); else bar.value = pct;
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- Extracción de texto ---------- */
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

function cleanText(t) {
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '')                       // guiones invisibles
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')       // pala-\nbra -> palabra
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* Une líneas sueltas (típico de PDF y OCR) en párrafos */
function joinLines(t) {
  const lines = cleanText(t).split('\n');
  const out = []; let cur = '';
  for (const line of lines) {
    if (!line.trim()) { if (cur) out.push(cur); cur = ''; continue; }
    if (!cur) { cur = line; continue; }
    const endsSentence = /[.!?…:»"”)]$/.test(cur);
    const shortLine = cur.length < 45;
    if (endsSentence && (shortLine || /^[\p{Lu}¿¡•\-–—\d]/u.test(line))) { out.push(cur); cur = line; }
    else if (/^[•\-–—]\s/.test(line)) { out.push(cur); cur = line; }
    else cur += ' ' + line;
  }
  if (cur) out.push(cur);
  return out.join('\n\n');
}

async function ocrImages(sources, label) {
  return (await ocrImagesList(sources, label)).join('\n\n');
}
/* Devuelve un texto por imagen, en el mismo orden */
async function ocrImagesList(sources, label) {
  if (!window.Tesseract) throw new Error('No se ha podido cargar el lector de fotos. Comprueba la conexión a internet la primera vez.');
  const lang = settings.ocrLang || 'spa';
  let current = 0;
  busy(true, 'Preparando el lector de fotos (la primera vez tarda un poco)…', null);
  const worker = await Tesseract.createWorker(lang, 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        const pct = Math.round(((current + m.progress) / sources.length) * 100);
        busy(true, `${label} ${current + 1} de ${sources.length}: leyendo el texto…`, pct);
      }
    },
  });
  const texts = [];
  try {
    for (current = 0; current < sources.length; current++) {
      busy(true, `${label} ${current + 1} de ${sources.length}: leyendo el texto…`, Math.round((current / sources.length) * 100));
      const { data } = await worker.recognize(sources[current]);
      texts.push(joinLines(data.text || ''));
    }
  } finally { await worker.terminate(); }
  return texts;
}

async function extractPDF(file) {
  if (!window.pdfjsLib) throw new Error('No se ha podido cargar el lector de PDF. Comprueba la conexión a internet.');
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = []; const needOCR = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    busy(true, `Leyendo página ${p} de ${pdf.numPages}…`, Math.round((p / pdf.numPages) * 100));
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    let s = '';
    for (const it of tc.items) { s += it.str; if (it.hasEOL) s += '\n'; else if (it.str && !/\s$/.test(it.str)) s += ''; }
    s = joinLines(s);
    pages.push(s);
    if (s.replace(/\s/g, '').length < 25) needOCR.push(p);
  }
  // Páginas escaneadas (sin texto): se leen como foto
  if (needOCR.length) {
    const ok = needOCR.length === pdf.numPages ||
      confirm(`${needOCR.length} página(s) parecen escaneadas (son una imagen). ¿Quieres que intente leerlas como foto? Puede tardar.`);
    if (ok) {
      const canvases = [];
      for (const p of needOCR) {
        busy(true, `Preparando página escaneada ${p}…`, null);
        const page = await pdf.getPage(p);
        const vp = page.getViewport({ scale: 2 });
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        canvases.push(c);
      }
      const ocrTexts = await ocrImagesList(canvases, 'Página escaneada');
      needOCR.forEach((p, i) => { pages[p - 1] = ocrTexts[i]; });
    }
  }
  return pages.filter(Boolean).join('\n\n');
}

async function extractDOCX(file) {
  if (!window.mammoth) throw new Error('No se ha podido cargar el lector de Word.');
  const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return cleanText(r.value);
}

function htmlToText(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
  d.querySelectorAll('p,div,br,li,h1,h2,h3,h4,h5,h6,tr,section,article').forEach((n) => n.append('\n\n'));
  return cleanText(d.body ? d.body.textContent : '');
}

async function extractEPUB(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const container = await zip.file('META-INF/container.xml').async('text');
  const opfPath = /full-path="([^"]+)"/.exec(container)[1];
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = new DOMParser().parseFromString(await zip.file(opfPath).async('text'), 'application/xml');
  const items = {}; opf.querySelectorAll('manifest > item').forEach((i) => (items[i.getAttribute('id')] = i.getAttribute('href')));
  const parts = [];
  const spine = [...opf.querySelectorAll('spine > itemref')];
  for (let k = 0; k < spine.length; k++) {
    busy(true, `Leyendo capítulo ${k + 1} de ${spine.length}…`, Math.round(((k + 1) / spine.length) * 100));
    const href = items[spine[k].getAttribute('idref')]; if (!href) continue;
    const f = zip.file(base + decodeURIComponent(href)); if (!f) continue;
    parts.push(htmlToText(await f.async('text')));
  }
  return parts.join('\n\n');
}

async function extractODT(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = new DOMParser().parseFromString(await zip.file('content.xml').async('text'), 'application/xml');
  const paras = [...xml.getElementsByTagName('*')].filter((n) => /^text:(p|h)$/.test(n.nodeName));
  return cleanText(paras.map((p) => p.textContent).join('\n\n'));
}

function rtfToText(rtf) {
  return cleanText(rtf
    .replace(/\\par[d]?/g, '\n').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(n < 0 ? 65536 + +n : +n))
    .replace(/\{\\\*[^{}]*\}/g, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, ''));
}

async function extractFile(file) {
  const name = file.name.toLowerCase();
  const ext = name.split('.').pop();
  if (file.type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic'].includes(ext)) {
    return ocrImages([file], 'Imagen');
  }
  switch (ext) {
    case 'pdf': return extractPDF(file);
    case 'docx': return extractDOCX(file);
    case 'doc': throw new Error('Los archivos .doc antiguos no se pueden abrir. Ábrelo en Word y guárdalo como .docx o PDF.');
    case 'epub': return extractEPUB(file);
    case 'odt': return extractODT(file);
    case 'rtf': return rtfToText(await file.text());
    case 'html': case 'htm': return htmlToText(await file.text());
    case 'pages': throw new Error('Los archivos de Pages no se pueden abrir. Expórtalo como PDF o Word.');
    default: return cleanText(await file.text());
  }
}

/* ---------- Trocear en frases ---------- */
function toParagraphs(text) {
  const paras = text.split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  const re = /[^.!?…]+(?:[.!?…]+["'»”)\]]*|$)\s*/g;
  return paras.map((p) => {
    const out = [];
    for (const m of p.match(re) || [p]) {
      let s = m.trim(); if (!s) continue;
      // frases muy largas: partir por comas o espacios (los navegadores cortan las muy largas)
      while (s.length > 220) {
        let cut = s.lastIndexOf(', ', 200); if (cut < 80) cut = s.lastIndexOf(' ', 200); if (cut < 40) cut = 200;
        out.push(s.slice(0, cut + 1).trim()); s = s.slice(cut + 1).trim();
      }
      if (s) out.push(s);
    }
    return out;
  }).filter((a) => a.length);
}

/* ---------- Estado del lector ---------- */
const R = { doc: null, sentences: [], paraStart: [], idx: 0, playing: false, token: 0, wake: null, spans: [] };

function renderDoc(doc) {
  const paras = toParagraphs(doc.text);
  R.sentences = []; R.paraStart = []; R.paraOf = [];
  const html = [];
  paras.forEach((p, pi) => {
    R.paraStart.push(R.sentences.length);
    html.push('<p>' + p.map((s) => {
      const i = R.sentences.length; R.sentences.push(s); R.paraOf.push(pi);
      return `<span class="s" data-i="${i}">${esc(s)} </span>`;
    }).join('') + '</p>');
  });
  $('docText').innerHTML = html.join('');
  R.spans = [...$('docText').querySelectorAll('.s')];
  $('seek').max = Math.max(0, R.sentences.length - 1);
  R.idx = Math.min(doc.pos || 0, Math.max(0, R.sentences.length - 1));
  mark(R.idx, true);
}

function mark(i, scroll) {
  R.spans.forEach((sp, k) => { sp.classList.toggle('cur', k === i); sp.classList.toggle('done', k < i); });
  $('seek').value = i;
  const pct = R.sentences.length ? Math.round((i / R.sentences.length) * 100) : 0;
  $('posLabel').textContent = `${pct} %`;
  const remChars = R.sentences.slice(i).reduce((a, s) => a + s.length, 0);
  const mins = Math.round(remChars / (14 * 60 * (settings.rate || 1)));   // ~14 caracteres por segundo
  $('timeLabel').textContent = mins >= 1 ? `quedan ~${mins} min` : 'casi al final';
  if (scroll && settings.autoScroll && R.spans[i]) R.spans[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------- Voces ---------- */
let voices = [];
function loadVoices() {
  voices = synth ? synth.getVoices() : [];
  const sel = $('voiceSel');
  const list = voices
    .filter((v) => !settings.onlySpanish || /^(es|ca)/i.test(v.lang))
    .sort((a, b) => (b.lang.startsWith('es-ES') - a.lang.startsWith('es-ES')) || a.name.localeCompare(b.name));
  sel.innerHTML = '';
  if (!list.length) sel.innerHTML = '<option value="">Voz por defecto del sistema</option>';
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    // localService=false: la voz se genera en internet (el texto sale del dispositivo)
    o.textContent = `${v.name} (${v.lang}) · ${v.localService ? 'en tu dispositivo' : '🌐 envía el texto a internet'}`;
    sel.append(o);
  }
  if (settings.voiceURI && list.some((v) => v.voiceURI === settings.voiceURI)) sel.value = settings.voiceURI;
  else if (list.length) {
    // Por defecto, siempre una voz local (privada)
    const local = list.filter((v) => v.localService);
    const best = local.find((v) => /^es-ES/i.test(v.lang)) || local.find((v) => /^es/i.test(v.lang)) || local[0] || list[0];
    sel.value = best.voiceURI;
  }
}
const currentVoice = () => voices.find((v) => v.voiceURI === $('voiceSel').value) || null;

/* ---------- Lectura en voz alta ---------- */
function speakFrom(i) {
  if (!synth) { toast('Este navegador no puede leer en voz alta. Prueba con Chrome, Edge o Safari.'); return; }
  if (i >= R.sentences.length) { stopPlaying(); R.idx = 0; mark(0, false); savePos(); toast('Fin del documento 🎉'); return; }
  R.idx = i; mark(i, true);
  const token = ++R.token;
  const wasSpeaking = synth.speaking || synth.pending;
  if (wasSpeaking) synth.cancel();
  const u = new SpeechSynthesisUtterance(R.sentences[i]);
  const v = currentVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'es-ES';
  u.rate = settings.rate; u.pitch = settings.pitch;
  u.onend = () => { if (R.playing && token === R.token) { if (i % 5 === 0) savePos(); speakFrom(i + 1); } };
  u.onerror = (e) => {
    if (token !== R.token || e.error === 'interrupted' || e.error === 'canceled') return;
    if (R.playing) setTimeout(() => token === R.token && speakFrom(i + 1), 50);
  };
  // Si no estaba hablando, se habla al instante (iPhone exige que salga del toque del usuario).
  // Si estaba hablando, un pequeño retraso tras cancel() evita que Chrome se "trague" la frase.
  if (!wasSpeaking) synth.speak(u);
  else setTimeout(() => { if (token === R.token) synth.speak(u); }, 30);
}

function startPlaying() {
  if (!R.sentences.length) return;
  R.playing = true; $('btnPlay').textContent = '⏸'; $('btnPlay').setAttribute('aria-label', 'Pausa');
  speakFrom(R.idx);   // primero la voz, sin esperas (requisito de Safari en iPhone)
  if (settings.keepAwake && 'wakeLock' in navigator) {
    navigator.wakeLock.request('screen').then((w) => { R.wake = w; }).catch(() => {});
  }
  setMediaSession('playing');
}
function stopPlaying() {
  R.playing = false; R.token++; if (synth) synth.cancel();
  $('btnPlay').textContent = '▶'; $('btnPlay').setAttribute('aria-label', 'Reproducir');
  if (R.wake) { R.wake.release().catch(() => {}); R.wake = null; }
  setMediaSession('paused');
  savePos();
}
const togglePlay = () => (R.playing ? stopPlaying() : startPlaying());
function jump(i) {
  i = Math.max(0, Math.min(R.sentences.length - 1, i));
  if (R.playing) speakFrom(i); else { R.idx = i; mark(i, true); savePos(); }
}
function jumpPara(dir) {
  const p = R.paraOf[R.idx];
  let target;
  if (dir < 0) target = R.idx > R.paraStart[p] ? R.paraStart[p] : R.paraStart[Math.max(0, p - 1)];
  else target = R.paraStart[p + 1] ?? R.sentences.length - 1;
  jump(target);
}

function setMediaSession(state) {
  if (!('mediaSession' in navigator) || !R.doc) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: R.doc.name, artist: 'Léemelo', artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
    navigator.mediaSession.playbackState = state;
    navigator.mediaSession.setActionHandler('play', startPlaying);
    navigator.mediaSession.setActionHandler('pause', stopPlaying);
    navigator.mediaSession.setActionHandler('previoustrack', () => jump(R.idx - 1));
    navigator.mediaSession.setActionHandler('nexttrack', () => jump(R.idx + 1));
  } catch (e) {}
}

async function savePos() {
  if (!R.doc) return;
  R.doc.pos = R.idx; R.doc.total = R.sentences.length; R.doc.opened = Date.now();
  try { await DB.put(R.doc); } catch (e) {}
}

/* ---------- Navegación entre pantallas ---------- */
async function openDoc(doc) {
  R.doc = doc;
  $('title').textContent = doc.name;
  $('viewHome').hidden = true; $('viewReader').hidden = false; $('player').hidden = false; $('btnHome').hidden = false;
  document.body.classList.add('reading');
  window.scrollTo(0, 0);
  renderDoc(doc);
  if (!history.state || history.state.view !== 'reader') history.pushState({ view: 'reader' }, '');
}
function goHome(fromPop) {
  stopPlaying();
  R.doc = null;
  $('title').textContent = '🎧 Léemelo';
  $('viewHome').hidden = false; $('viewReader').hidden = true; $('player').hidden = true; $('btnHome').hidden = true;
  document.body.classList.remove('reading');
  if (!fromPop && history.state && history.state.view === 'reader') history.back();
  renderLibrary();
}
window.addEventListener('popstate', () => { if (R.doc) goHome(true); });

async function renderLibrary() {
  let docs = [];
  try { docs = await DB.all(); } catch (e) {}
  docs.sort((a, b) => (b.opened || 0) - (a.opened || 0));
  $('libEmpty').hidden = docs.length > 0;
  $('libList').innerHTML = docs.map((d) => {
    const pct = d.total ? Math.round((d.pos / d.total) * 100) : 0;
    const date = new Date(d.opened || d.created).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    return `<li><button class="open" data-id="${d.id}"><span class="name">${esc(d.name)}</span>
      <span class="meta">${date} · ${pct} % escuchado</span><span class="bar"><i style="width:${pct}%"></i></span></button>
      <button class="del" data-del="${d.id}" aria-label="Borrar ${esc(d.name)}">🗑️</button></li>`;
  }).join('');
}
$('libList').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-id]'); const del = e.target.closest('[data-del]');
  if (del) { if (confirm('¿Quitar este documento de tus lecturas?')) { await DB.del(del.dataset.del); renderLibrary(); } return; }
  if (open) { const d = await DB.get(open.dataset.id); if (d) openDoc(d); }
});

/* ---------- Añadir documentos ---------- */
async function addText(name, text) {
  text = (text || '').trim();
  if (text.replace(/\s/g, '').length < 2) { toast('No he encontrado texto que leer en este archivo 😕'); return; }
  const doc = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, text, pos: 0, created: Date.now(), opened: Date.now() };
  try { await DB.put(doc); } catch (e) { toast('No se ha podido guardar en la biblioteca, pero puedes escucharlo igual.'); }
  openDoc(doc);
}

async function handleFiles(files) {
  files = [...files]; if (!files.length) return;
  try {
    const images = files.filter((f) => f.type.startsWith('image/'));
    let text, name;
    if (images.length === files.length && images.length > 1) {
      text = await ocrImages(images, 'Imagen'); name = `Fotos (${images.length}) · ${new Date().toLocaleDateString('es-ES')}`;
    } else {
      const f = files[0];
      busy(true, `Abriendo «${f.name}»…`, null);
      text = await extractFile(f);
      name = f.type.startsWith('image/') ? `Foto · ${new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}` : f.name.replace(/\.[^.]+$/, '');
    }
    busy(false);
    await addText(name, text);
  } catch (err) {
    busy(false);
    console.error(err);
    toast(err && err.message ? err.message : 'No se ha podido abrir el archivo.', 6000);
  }
}

$('fileDoc').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
$('fileImg').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
$('btnPaste').addEventListener('click', async () => {
  $('pasteBox').hidden = false; $('pasteText').focus();
  try { if (navigator.clipboard && navigator.clipboard.readText) { const t = await navigator.clipboard.readText(); if (t && !$('pasteText').value) $('pasteText').value = t; } } catch (e) {}
});
$('pasteCancel').addEventListener('click', () => { $('pasteBox').hidden = true; $('pasteText').value = ''; });
$('pasteOk').addEventListener('click', () => {
  const t = $('pasteText').value; const first = t.trim().split('\n')[0].slice(0, 50) || 'Texto pegado';
  $('pasteBox').hidden = true; $('pasteText').value = '';
  addText(first, cleanText(t));
});
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === drop) drop.classList.remove('over'); }));
document.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

/* ---------- Controles ---------- */
$('btnPlay').addEventListener('click', togglePlay);
$('btnBack').addEventListener('click', () => jump(R.idx - 1));
$('btnFwd').addEventListener('click', () => jump(R.idx + 1));
$('btnBackP').addEventListener('click', () => jumpPara(-1));
$('btnFwdP').addEventListener('click', () => jumpPara(1));
$('btnHome').addEventListener('click', () => goHome(false));
$('seek').addEventListener('input', (e) => mark(+e.target.value, true));
$('seek').addEventListener('change', (e) => jump(+e.target.value));
$('docText').addEventListener('click', (e) => { const s = e.target.closest('.s'); if (s) jump(+s.dataset.i); });
document.addEventListener('keydown', (e) => {
  if (!R.doc || e.target.matches('input,textarea,select')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight') jump(R.idx + 1);
  else if (e.code === 'ArrowLeft') jump(R.idx - 1);
});

/* ---------- Ajustes ---------- */
function applySettingsUI() {
  $('rate').value = settings.rate; $('rateVal').textContent = settings.rate;
  $('rateQuick').value = String(settings.rate);
  if ($('rateQuick').value !== String(settings.rate)) {
    const o = document.createElement('option'); o.textContent = String(settings.rate); $('rateQuick').append(o); $('rateQuick').value = String(settings.rate);
  }
  $('pitch').value = settings.pitch; $('pitchVal').textContent = settings.pitch;
  $('onlySpanish').checked = settings.onlySpanish; $('ocrLang').value = settings.ocrLang;
  $('keepAwake').checked = settings.keepAwake; $('autoScroll').checked = settings.autoScroll;
}
function setRate(r) { settings.rate = +r; saveSettings(); applySettingsUI(); if (R.playing) speakFrom(R.idx); else if (R.doc) mark(R.idx, false); }
$('btnSettings').addEventListener('click', () => { loadVoices(); $('dlgSettings').showModal(); });
$('rate').addEventListener('change', (e) => setRate(e.target.value));
$('rate').addEventListener('input', (e) => ($('rateVal').textContent = e.target.value));
$('rateQuick').addEventListener('change', (e) => setRate(e.target.value));
$('pitch').addEventListener('input', (e) => { settings.pitch = +e.target.value; $('pitchVal').textContent = settings.pitch; saveSettings(); });
$('voiceSel').addEventListener('change', (e) => { settings.voiceURI = e.target.value; saveSettings(); if (R.playing) speakFrom(R.idx); });
$('onlySpanish').addEventListener('change', (e) => { settings.onlySpanish = e.target.checked; saveSettings(); loadVoices(); });
$('ocrLang').addEventListener('change', (e) => { settings.ocrLang = e.target.value; saveSettings(); });
$('keepAwake').addEventListener('change', (e) => { settings.keepAwake = e.target.checked; saveSettings(); });
$('autoScroll').addEventListener('change', (e) => { settings.autoScroll = e.target.checked; saveSettings(); });
$('btnTest').addEventListener('click', () => {
  if (!synth) return toast('Este navegador no puede leer en voz alta.');
  synth.cancel();
  const u = new SpeechSynthesisUtterance('Hola. Así sonará la lectura de tus documentos.');
  const v = currentVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'es-ES';
  u.rate = settings.rate; u.pitch = settings.pitch; synth.speak(u);
});

// Al volver a la app tras bloquear la pantalla, recuperar el bloqueo de pantalla
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && R.playing && settings.keepAwake && 'wakeLock' in navigator && !R.wake) {
    try { R.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  if (document.visibilityState === 'hidden') savePos();
});

/* ---------- Arranque ---------- */
applySettingsUI();
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }
renderLibrary();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
