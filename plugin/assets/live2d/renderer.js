/* USTC overlay renderer: local model, transparent canvas, bounded motion. */
(async () => {
  const urls = [];
  let app, model, observer, pause;
  const state = window.__ustcLive2d = { ready: false, frames: 0, action: 'Idle', error: null };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const blob = (data, type) => { const url = URL.createObjectURL(new Blob([data], { type })); urls.push(url); return url; };
  const notice = type => parent.postMessage({ type: `ustc-live2d-${type}` }, '*');
  function dispose() {
    observer?.disconnect();
    document.removeEventListener('visibilitychange', pause);
    if (pause) reduced.removeEventListener('change', pause);
    try { app?.destroy({ removeView: true }, { children: true }); } catch {}
    urls.forEach(url => URL.revokeObjectURL(url));
  }
  addEventListener('pagehide', dispose, { once: true });
  try {
    const mapping = {};
    for (const [path, encoded] of Object.entries(ASSETS)) {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      mapping[path] = path.endsWith('.png') ? `data:image/png;base64,${encoded}` : blob(bytes, path.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    }
    const refs = MODEL.FileReferences;
    refs.Moc = mapping[refs.Moc]; refs.Textures = refs.Textures.map(path => mapping[path]);
    refs.Physics = mapping[refs.Physics]; refs.DisplayInfo = mapping[refs.DisplayInfo];
    for (const list of Object.values(refs.Motions)) for (const item of list) item.File = mapping[item.File];
    for (const item of refs.Expressions) item.File = mapping[item.File];
    const vendor = globalThis.__dshLive2dPetVendor;
    vendor.extensions.add(vendor.Live2DPlugin);
    vendor.configureCubismSDK({ memorySizeMB: 64 });
    app = new vendor.Application();
    await app.init({ width: innerWidth || 100, height: innerHeight || 140, backgroundAlpha: 0, antialias: true, resolution: Math.min(2, devicePixelRatio || 1), preference: 'webgl', preserveDrawingBuffer: true });
    app.ticker.maxFPS = 30;
    document.querySelector('#stage').appendChild(app.canvas);
    model = await vendor.Live2DModel.from(blob(JSON.stringify(MODEL), 'application/json'), { autoUpdate: false, autoFocus: false, eyeBlink: true, textureOptions: { lod: 'full' } });
    app.stage.addChild(model);
    const width = model.internalModel.originalWidth || model.width;
    const height = model.internalModel.originalHeight || model.height;
    function layout() {
      app.ticker.maxFPS = innerWidth < 60 ? 15 : 30;
      app.renderer.resize(Math.max(1, innerWidth), Math.max(1, innerHeight));
      model.anchor.set(.5, .5);
      model.scale.set(Math.min(innerWidth / width, innerHeight / height) * .95);
      model.position.set(innerWidth / 2, innerHeight / 2);
    }
    layout(); observer = new ResizeObserver(layout); observer.observe(document.body);
    model.automator.autoUpdate = true;
    // Idle drives the eye parameters, so apply blink after motions and physics.
    model.internalModel.on('beforeModelUpdate', () => {
      if (reduced.matches) return;
      const phase = performance.now() % 4700;
      const blink = phase < 160 ? Math.abs(phase - 80) / 80 : 1;
      if (phase < 160) {
        model.internalModel.coreModel.setParameterValueById('ParamEyeLOpen', blink);
        model.internalModel.coreModel.setParameterValueById('ParamEyeROpen', blink);
      }
    });
    await model.motion('Idle', 0, vendor.MotionPriority.IDLE, { loop: true });
    let lastAction = -Infinity;
    addEventListener('pointermove', event => {
      if (!reduced.matches) model.internalModel.focusController.focus((event.clientX / innerWidth - .5) * 1.4, (.5 - event.clientY / innerHeight) * 1.2);
    });
    addEventListener('pointerleave', () => model.internalModel.focusController.focus(0, 0));
    addEventListener('click', async () => {
      if (reduced.matches || performance.now() - lastAction < 3000) return;
      lastAction = performance.now(); state.action = 'SelfieQuick';
      document.body.dataset.action = state.action;
      try { await model.motion('SelfieQuick', 0, vendor.MotionPriority.FORCE, { loop: false }); }
      catch (error) { document.body.dataset.actionError = String(error?.message || error); }
    });
    app.ticker.add(() => { state.frames++; if (state.frames % 30 === 0) document.body.dataset.frames = state.frames; });
    pause = () => { if (!app?.ticker) return; if (document.hidden || reduced.matches) app.ticker.stop(); else app.ticker.start(); };
    document.addEventListener('visibilitychange', pause); reduced.addEventListener('change', pause);
    // Paint at least one complete frame before pausing for reduced motion.
    app.renderer.render(app.stage);
    state.ready = true; document.body.dataset.ready = 'true'; notice('ready'); pause();
  } catch (error) {
    state.error = String(error?.message || error); document.body.dataset.error = state.error; console.error(error); notice('error'); dispose();
  }
})();
