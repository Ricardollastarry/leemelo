/* Motor de la voz «Elena» (modelo Supertonic 3 de Supertone, licencia OpenRAIL-M).
   Funciona dentro del navegador con ONNX Runtime Web. El modelo (~385 MB) se descarga una sola vez
   desde Hugging Face (página oficial de Supertone) y queda guardado en este dispositivo.
   El texto NO sale del dispositivo: la voz se genera aquí mismo. */
'use strict';

const Elena = (() => {
  const ORT_VER = '1.23.0';
  const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;
  const HF = 'https://huggingface.co/Supertone/supertonic-3/resolve/main/';
  const FILES = {
    cfg: 'onnx/tts.json', indexer: 'onnx/unicode_indexer.json',
    dp: 'onnx/duration_predictor.onnx', enc: 'onnx/text_encoder.onnx',
    vec: 'onnx/vector_estimator.onnx', voc: 'onnx/vocoder.onnx',
  };
  const VOICES = { F1: 'Elena', F2: 'Marta', F3: 'Carmen', F4: 'Irene', F5: 'Sofía' };
  const CACHE = 'leemelo-elena-v1';
  const TOTAL_BYTES = 398e6; // aproximado, para la barra de progreso
  const STEPS = 6;           // pasos de calidad (el motor admite 1-100; 5-8 es lo habitual)

  let S = null;          // sesiones cargadas
  let loading = null;
  let backend = '';
  const styles = {};

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = () => rej(new Error('No se ha podido descargar el motor de voz. Revisa la conexión.'));
      document.head.append(s);
    });
  }

  async function isDownloaded() {
    try { const c = await caches.open(CACHE); return !!(await c.match(HF + FILES.vec)); } catch (e) { return false; }
  }

  // Descarga con progreso y lo guarda en el dispositivo
  async function getFile(path, onBytes) {
    const url = HF + path;
    let cache = null;
    try { cache = await caches.open(CACHE); const hit = await cache.match(url); if (hit) { const b = await hit.arrayBuffer(); onBytes(b.byteLength); return b; } } catch (e) {}
    const r = await fetch(url);
    if (!r.ok) throw new Error('No se ha podido descargar la voz Elena (' + r.status + ').');
    // Se guarda directamente en el dispositivo y luego se lee una sola vez (menos memoria)
    if (cache) {
      try {
        const saving = cache.put(url, r.clone());
        const reader = r.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; onBytes(value.length); }
        await saving;
        const hit = await cache.match(url); if (hit) return await hit.arrayBuffer();
      } catch (e) { /* sin espacio: se descarga de nuevo sin guardar */ }
      const r2 = await fetch(url); return await r2.arrayBuffer();
    }
    return await r.arrayBuffer();
  }

  async function load(onProgress) {
    if (S) return S;
    if (loading) return loading;
    loading = (async () => {
      if (!window.ort) await loadScript(ORT_BASE + 'ort.webgpu.min.js');
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      let got = 0; const tick = (b) => { got += b; onProgress && onProgress(Math.min(99, Math.round(got / TOTAL_BYTES * 100))); };
      const dec = new TextDecoder();
      const cfg = JSON.parse(dec.decode(await getFile(FILES.cfg, tick)));
      const indexer = JSON.parse(dec.decode(await getFile(FILES.indexer, tick)));
      const bufs = {};
      for (const k of ['dp', 'enc', 'voc', 'vec']) bufs[k] = await getFile(FILES[k], tick);
      onProgress && onProgress(100, 'Preparando la voz…');
      const mkSess = (k, ep) => ort.InferenceSession.create(bufs[k], { executionProviders: [ep], graphOptimizationLevel: 'all' });
      const tryCreate = async (ep) => {
        // la duración siempre en CPU: es pequeña y así es exacta en cualquier ordenador
        const out = { dp: await mkSess('dp', 'wasm') };
        for (const k of ['enc', 'vec', 'voc']) out[k] = await mkSess(k, ep);
        return out;
      };
      let sess;
      if ('gpu' in navigator) {
        try { sess = await tryCreate('webgpu'); backend = 'webgpu'; } catch (e) { console.warn('WebGPU no disponible, uso CPU', e); }
      }
      if (!sess) { sess = await tryCreate('wasm'); backend = 'wasm'; }
      S = { cfg, indexer, ...sess,
        sr: cfg.ae.sample_rate, chunk: cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor,
        ldim: cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor };
      // Autocomprobación: la tarjeta gráfica debe dar los mismos números que el programa original.
      // Si no coinciden (fallo de la tarjeta o del navegador), se usa el modo exacto por CPU.
      if (backend === 'webgpu') {
        let ok = false;
        try { ok = await selfCheck(); } catch (e) { console.warn('Autocomprobación con error', e); }
        if (!ok) {
          console.warn('La tarjeta gráfica no da resultados correctos: uso el procesador (más lento).');
          for (const k of ['enc', 'vec', 'voc']) { try { await S[k].release(); } catch (e) {} S[k] = await mkSess(k, 'wasm'); }
          backend = 'wasm';
        }
      }
      return S;
    })();
    try { return await loading; } catch (e) { loading = null; S = null; throw e; }
  }

  // Valores calculados con el programa original (Python) para la frase y el ruido de prueba
  const CHECK = { text: 'Hola, esto es una prueba.', dur: 2.3179, lat: 16,
    xt: [-0.01022, -0.82303, 0.39208, 0.58593, -0.69381, -0.28395, 0.83053, -0.15808, -0.79844, 0.43675, 0.61236, -0.76975,
      -0.28959, 0.8377, -0.28153, -0.75771, 0.53675, 0.53393, -0.72611, -0.20683, 0.85723, -0.25433, -0.75125, 0.40128] };
  async function selfCheck() {
    const st = await getStyle('F1');
    const ids = toIds(CHECK.text); const L = ids.length;
    const tIds = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, L]);
    const tMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);
    const dur = (await S.dp.run({ text_ids: tIds, style_dp: st.dp, text_mask: tMask }))[S.dp.outputNames[0]].data[0];
    const emb = (await S.enc.run({ text_ids: tIds, style_ttl: st.ttl, text_mask: tMask }))[S.enc.outputNames[0]];
    const n = S.ldim * CHECK.lat; const noise = new Float32Array(n);
    for (let i = 0; i < n; i++) noise[i] = Math.sin(i * 0.37);
    const out = await S.vec.run({ noisy_latent: new ort.Tensor('float32', noise, [1, S.ldim, CHECK.lat]), text_emb: emb, style_ttl: st.ttl,
      text_mask: tMask, latent_mask: new ort.Tensor('float32', new Float32Array(CHECK.lat).fill(1), [1, 1, CHECK.lat]),
      current_step: new ort.Tensor('float32', new Float32Array([0]), [1]), total_step: new ort.Tensor('float32', new Float32Array([6]), [1]) });
    const xt = out[S.vec.outputNames[0]].data;
    let maxErr = 0; CHECK.xt.forEach((v, k) => { maxErr = Math.max(maxErr, Math.abs(v - xt[k * 97])); });
    lastCheck = { dur, maxErr };
    return Math.abs(dur - CHECK.dur) < 0.02 && maxErr < 0.01;
  }
  let lastCheck = null;

  function toIds(text) {
    const ids = [];
    for (const ch of preprocess(text)) { const idx = S.indexer[ch.codePointAt(0)]; if (idx != null && idx >= 0) ids.push(idx); }
    return ids;
  }

  async function getStyle(id) {
    if (styles[id]) return styles[id];
    const j = JSON.parse(new TextDecoder().decode(await getFile('voice_styles/' + id + '.json', () => {})));
    const mk = (o) => new ort.Tensor('float32', Float32Array.from(o.data.flat(Infinity)), o.dims);
    return (styles[id] = { ttl: mk(j.style_ttl), dp: mk(j.style_dp) });
  }

  // Limpieza de texto igual que el original (Supertonic UnicodeProcessor)
  const REPL = { '–': '-', '‑': '-', '—': '-', '¯': ' ', '_': ' ', '“': '"', '”': '"',
    '‘': "'", '’': "'", '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ',
    '«': '"', '»': '"' };
  function preprocess(t) {
    t = t.normalize('NFKD');
    t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, '');
    for (const [a, b] of Object.entries(REPL)) t = t.split(a).join(b);
    t = t.replace(/[♥☆♡©\\]/g, '').replace(/@/g, ' arroba ');
    t = t.replace(/ ([,.!?;:'])/g, '$1').replace(/(["'`])\1+/g, '$1').replace(/\s+/g, ' ').trim();
    if (!/[.!?;:,'"')\]}…»]$/.test(t)) t += '.';
    return '<es>' + t + '</es>';
  }

  function randn(n) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i += 2) {
      const u = 1 - Math.random(), v = Math.random(), r = Math.sqrt(-2 * Math.log(u));
      a[i] = r * Math.cos(2 * Math.PI * v); if (i + 1 < n) a[i + 1] = r * Math.sin(2 * Math.PI * v);
    }
    return a;
  }

  // Genera el audio de una frase. Devuelve { samples: Float32Array, sr }
  async function synth(text, voice = 'F1', rate = 1, dbg = null) {
    if (!S) throw new Error('La voz Elena no está cargada.');
    const st = await getStyle(voice);
    const ids = toIds(text);
    const L = ids.length;
    const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, L]);
    const textMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);
    const speed = Math.min(2, Math.max(0.7, 1.05 * rate));

    const dpOut = await S.dp.run({ text_ids: textIds, style_dp: st.dp, text_mask: textMask });
    const dur = dpOut[S.dp.outputNames[0]].data[0] / speed;
    const encOut = await S.enc.run({ text_ids: textIds, style_ttl: st.ttl, text_mask: textMask });
    const textEmb = encOut[S.enc.outputNames[0]];

    const wavLen = Math.floor(dur * S.sr);
    const latLen = Math.max(1, Math.ceil(wavLen / S.chunk));
    let xt = new ort.Tensor('float32', (dbg && dbg.noise) || randn(S.ldim * latLen), [1, S.ldim, latLen]);
    const latentMask = new ort.Tensor('float32', new Float32Array(latLen).fill(1), [1, 1, latLen]);
    const total = new ort.Tensor('float32', new Float32Array([STEPS]), [1]);
    for (let s = 0; s < STEPS; s++) {
      const out = await S.vec.run({ noisy_latent: xt, text_emb: textEmb, style_ttl: st.ttl, text_mask: textMask,
        latent_mask: latentMask, current_step: new ort.Tensor('float32', new Float32Array([s]), [1]), total_step: total });
      xt = out[S.vec.outputNames[0]];
    }
    const vo = await S.voc.run({ latent: xt });
    const wav = vo[S.voc.outputNames[0]].data;
    if (dbg) Object.assign(dbg, { ids, dur, latLen, xt: xt.data, wav });
    return { samples: wav.slice(0, Math.min(wav.length, wavLen + Math.round(S.sr * 0.05))), sr: S.sr };
  }

  async function forget() { try { await caches.delete(CACHE); } catch (e) {} S = null; loading = null; }

  return { load, synth, isDownloaded, forget, VOICES, get ready() { return !!S; }, get backend() { return backend; }, get lastCheck() { return lastCheck; } };
})();
