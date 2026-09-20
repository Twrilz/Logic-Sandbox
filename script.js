/* ============================= three.js PCB-trace backdrop ============================= */
(function(){
  const canvas = document.getElementById('bg-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true });
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 100);
  camera.position.set(0,0,11);

  function resize(){
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
  }
  resize();
  addEventListener('resize', resize);

  const COUNT = 90;
  const positions = new Float32Array(COUNT*3);
  const velocities = [];
  for(let i=0;i<COUNT;i++){
    positions[i*3]   = (Math.random()-0.5)*20;
    positions[i*3+1] = (Math.random()-0.5)*12;
    positions[i*3+2] = (Math.random()-0.5)*6;
    velocities.push([(Math.random()-0.5)*0.004, (Math.random()-0.5)*0.004, 0]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  const mat = new THREE.PointsMaterial({ color:0xe8c86a, size:0.06, transparent:true, opacity:0.85 });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  const lineGeo = new THREE.BufferGeometry();
  const lineMat = new THREE.LineBasicMaterial({ color:0x9c988a, transparent:true, opacity:0.22 });
  const lineMesh = new THREE.LineSegments(lineGeo, lineMat);
  scene.add(lineMesh);

  const MAXD = 3.4;
  function updateLines(){
    const verts = [];
    for(let i=0;i<COUNT;i++){
      for(let j=i+1;j<COUNT;j++){
        const dx=positions[i*3]-positions[j*3], dy=positions[i*3+1]-positions[j*3+1], dz=positions[i*3+2]-positions[j*3+2];
        const d = Math.sqrt(dx*dx+dy*dy+dz*dz);
        if(d<MAXD){
          verts.push(positions[i*3],positions[i*3+1],positions[i*3+2]);
          verts.push(positions[j*3],positions[j*3+1],positions[j*3+2]);
        }
      }
    }
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts),3));
  }
  let frame=0;
  function tick(){
    for(let i=0;i<COUNT;i++){
      positions[i*3]   += velocities[i][0];
      positions[i*3+1] += velocities[i][1];
      if(Math.abs(positions[i*3])>10) velocities[i][0]*=-1;
      if(Math.abs(positions[i*3+1])>6) velocities[i][1]*=-1;
    }
    geo.attributes.position.needsUpdate = true;
    if(frame%4===0) updateLines();
    points.rotation.y += 0.0006;
    lineMesh.rotation.y += 0.0006;
    frame++;
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();
})();

/* ============================= circuit simulator ============================= */
(function(){
    const INPUT_COUNT = { 
    INPUT: 0, BUTTON: 0, CLOCK: 0, OSCLOCK: 1, OUTPUT: 1, SPEAKER: 1, LCD: 4, SEVEN: 7, FOURTEEN: 18, 
    NOT: 1, AND: 2, OR: 2, OR3: 3, OR3IN: 3, OR2OUT: 2, NAND: 2, NOR: 2, XOR: 2, XNOR: 2, MEMORY: 2,
    DELAY: 1, CALCULATOR: 2, GREATER: 2, XAND: 2, JOYSTICK: 0, DIPSWITCH: 0, LABEL: 0
  };

  const LABELS = { 
    INPUT: 'SW', BUTTON: 'BTN', CLOCK: 'CLK', OSCLOCK: 'OS CLK', OUTPUT: 'LAMP', SPEAKER: 'SPEAKER', LCD: 'LCD', SEVEN: '7-SEG', FOURTEEN: '14 Segment', 
    NOT: 'NOT', AND: 'AND', OR: 'OR', OR3: 'OR 3 IN', OR3IN: 'OR 3 IN', OR2OUT: 'OR 2 OUT', NAND: 'NAND', NOR: 'NOR', XOR: 'XOR', XNOR: 'XNOR', MEMORY: 'MEM',
    DELAY: 'DELAY', CALCULATOR: 'CALC', GREATER: 'GREATER', XAND: 'XAND', JOYSTICK: 'Joystick', DIPSWITCH: 'Dip Switch', LABEL: 'Note'
  };

  const canvasInner = document.getElementById('canvasInner');
  const canvasWrap  = document.getElementById('canvasWrap');
  const zoomStage   = document.getElementById('zoomStage');
  const wireLayer   = document.getElementById('wireLayer');
  const toastEl     = document.getElementById('toast');
  const selectionBox = document.getElementById('selectionBox');

  document.addEventListener('copy', e => e.preventDefault());

  let nodes = new Map();     
  let wires = [];            
  let connectedPins = new Set();
  const inputWires = new Map();
  let nodeSeq = 0, wireSeq = 0;
  let pendingWireFrom = null; 
  let mousePos = { x: 0, y: 0 };
  let selectedNodeIds = new Set();
  let isSelecting = false;
  let selectStart = { x: 0, y: 0 };
  let nodeScale = 1;
  let routingRevision = 0;
  let hoveredChipNode = null;
  const BOARD_AUTOSAVE_STORAGE_KEY = 'logic-sandbox-board-autosave-v1';
  let autosaveTimer = null;
  let isSimulationPaused = false;
  let simulationSpeed = 1;
  let simulationTime = Date.now();
  let lastSimulationFrame = performance.now();
  const customChips = new Map();
  const customChipsEl = document.getElementById('customChips');
  const CUSTOM_CHIPS_STORAGE_KEY = 'breadboard-custom-chips';

  function isCustomChip(type){ return typeof type === 'string' && type.startsWith('CHIP:'); }
  function chipKey(name){ return 'CHIP:' + name; }
  function isDipSwitchType(type){ return type === 'DIPSWITCH' || type === chipKey('Dip Switch'); }

  function registerChip(definition){
    const type = chipKey(definition.name);
    customChips.set(type, definition);
    INPUT_COUNT[type] = definition.inputs.length;
    LABELS[type] = definition.name;
    const persisted = persistCustomChips();
    renderCustomChips();
    return { type, persisted };
  }

  function persistCustomChips(){
    const payload = JSON.stringify(Object.fromEntries(customChips));
    try {
      localStorage.setItem(CUSTOM_CHIPS_STORAGE_KEY, payload);
      if(localStorage.getItem(CUSTOM_CHIPS_STORAGE_KEY) !== payload) throw new Error('Storage verification failed');
      return true;
    } catch(err) {
      try {
        sessionStorage.setItem(CUSTOM_CHIPS_STORAGE_KEY, payload);
        return false;
      } catch(sessionErr) {
        return false;
      }
    }
  }

  function clearSavedCustomChip(name){
    const keys = [localStorage, sessionStorage];
    keys.forEach(storage => {
      try {
        const raw = storage.getItem(CUSTOM_CHIPS_STORAGE_KEY);
        if(!raw) return;
        const stored = JSON.parse(raw);
        const cleaned = Object.fromEntries(
          Object.entries(stored).filter(([, definition]) => !(definition && definition.name === name))
        );
        storage.setItem(CUSTOM_CHIPS_STORAGE_KEY, JSON.stringify(cleaned));
      } catch(err) {
        try { storage.removeItem(CUSTOM_CHIPS_STORAGE_KEY); } catch(removeErr) { /* storage unavailable */ }
      }
    });
  }

  function createSwitchAssemblyComponent(){
    const name = 'Dip Switch';
    const type = chipKey(name);
    INPUT_COUNT[type] = 0;
    LABELS[type] = name;
    if(customChips.has(type)) customChips.delete(type);
    persistCustomChips();
    renderCustomChips();
    return type;
  }

  function restoreCustomChips(){
    clearSavedCustomChip('Dip Switch');
    try {
      const storedValue = localStorage.getItem(CUSTOM_CHIPS_STORAGE_KEY) || sessionStorage.getItem(CUSTOM_CHIPS_STORAGE_KEY) || '{}';
      const stored = JSON.parse(storedValue);
      Object.values(stored).forEach(definition => {
        if(definition && definition.name && Array.isArray(definition.inputs) && Array.isArray(definition.outputs)) {
          const type = chipKey(definition.name);
          customChips.set(type, definition);
          INPUT_COUNT[type] = definition.inputs.length;
          LABELS[type] = definition.name;
        }
      });
    } catch(err) {
      try { localStorage.removeItem(CUSTOM_CHIPS_STORAGE_KEY); } catch(storageErr) { /* storage unavailable */ }
    }
    renderCustomChips();
  }

  function renderCustomChips(){
    if(!customChipsEl) return;
    customChipsEl.innerHTML = customChips.size ? '<div class="palette-sep"></div><h2>CUSTOM CHIPS</h2>' : '';
    customChips.forEach((definition, type) => {
      const row = document.createElement('div');
      row.className = 'custom-chip-row';
      const button = document.createElement('button');
      button.className = 'part';
      button.dataset.type = type;
      button.innerHTML = `<span class="glyph">▣</span>${definition.name}`;
      const deleteButton = document.createElement('button');
      deleteButton.className = 'custom-chip-delete';
      deleteButton.type = 'button';
      deleteButton.title = `Delete ${definition.name}`;
      deleteButton.textContent = '−';
      deleteButton.addEventListener('click', e => {
        e.stopPropagation();
        deleteCustomChip(type);
      });
      row.appendChild(button);
      row.appendChild(deleteButton);
      customChipsEl.appendChild(row);
      setupPartButton(button);
    });
  }

  function deleteCustomChip(type){
    const definition = customChips.get(type);
    if(!definition) return;
    if(Array.from(nodes.values()).some(node => node.type === type)) {
      toast('Remove placed copies of this chip first');
      return;
    }
    showDeleteConfirmation(definition.name, () => {
      customChips.delete(type);
      delete INPUT_COUNT[type];
      delete LABELS[type];
      persistCustomChips();
      renderCustomChips();
      toast(`Deleted chip: ${definition.name}`);
    });
  }

  function showDeleteConfirmation(name, onDelete){
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
        <div class="confirm-kicker">REMOVE CHIP</div>
        <h3 id="confirmTitle">Delete ${name}?</h3>
        <p>This saved chip will be removed from page storage.</p>
        <div class="confirm-actions">
          <button type="button" class="confirm-cancel">Cancel</button>
          <button type="button" class="confirm-delete">Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.confirm-cancel').addEventListener('click', close);
    overlay.querySelector('.confirm-delete').addEventListener('click', () => {
      close();
      onDelete();
    });
    overlay.addEventListener('click', e => {
      if(e.target === overlay) close();
    });
  }

  /* ---------- view-inside-chip viewer (with zoom/pan) ---------- */
  function openChipViewer(node){
    const definition = customChips.get(node.type);
    if(!definition) return;

    const overlay = document.createElement('div');
    overlay.className = 'chip-viewer-overlay';
    overlay.innerHTML = `
      <div class="chip-viewer-panel">
        <div class="chip-viewer-header">
          <span>Inside: ${definition.name}</span>
          <button type="button" class="chip-viewer-close">×</button>
        </div>
        <svg class="chip-viewer-svg" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
    `;
    document.body.appendChild(overlay);

    const svg = overlay.querySelector('svg');
    const innerNodes = definition.nodes || [];

    let baseBox;
    if(innerNodes.length === 0){
      baseBox = { x:0, y:0, w:400, h:100 };
    } else {
      const xs = innerNodes.map(n => n.x), ys = innerNodes.map(n => n.y);
      const minX = Math.min(...xs) - 40, minY = Math.min(...ys) - 40;
      const maxX = Math.max(...xs) + 160, maxY = Math.max(...ys) + 120;
      baseBox = { x:minX, y:minY, w:maxX-minX, h:maxY-minY };
    }

    let view = { x:baseBox.x, y:baseBox.y, w:baseBox.w, h:baseBox.h };
    const ZOOM_MIN = 0.2, ZOOM_MAX = 6;
    let zoomLevel = 1;

    function applyViewBox(){
      svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    }

    if(innerNodes.length === 0){
      const empty = document.createElementNS('http://www.w3.org/2000/svg','text');
      empty.setAttribute('x', 20); empty.setAttribute('y', 30);
      empty.setAttribute('class','chip-viewer-label');
      empty.textContent = 'No internal components recorded for this chip.';
      svg.appendChild(empty);
    } else {
      const byId = new Map(innerNodes.map(n => [n.id, n]));
      (definition.wires || []).forEach(w => {
        const from = byId.get(w.from), to = byId.get(w.to);
        if(!from || !to) return;
        const path = document.createElementNS('http://www.w3.org/2000/svg','path');
        path.setAttribute('class','chip-viewer-wire');
        path.setAttribute('d', `M ${from.x+120} ${from.y+30} C ${from.x+180} ${from.y+30}, ${to.x-60} ${to.y+30}, ${to.x} ${to.y+30}`);
        svg.appendChild(path);
      });

      innerNodes.forEach(inner => {
        const g = document.createElementNS('http://www.w3.org/2000/svg','g');
        g.setAttribute('class', isCustomChip(inner.type) ? 'chip-viewer-nested' : '');
        const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
        rect.setAttribute('x', inner.x); rect.setAttribute('y', inner.y);
        rect.setAttribute('width', 120); rect.setAttribute('height', 60);
        rect.setAttribute('rx', 6);
        rect.setAttribute('class','chip-viewer-node');
        g.appendChild(rect);
        const label = document.createElementNS('http://www.w3.org/2000/svg','text');
        label.setAttribute('x', inner.x+60); label.setAttribute('y', inner.y+35);
        label.setAttribute('text-anchor','middle');
        label.setAttribute('class','chip-viewer-label');
        label.textContent = LABELS[inner.type] || inner.type;
        g.appendChild(label);
        if(isCustomChip(inner.type)){
          g.style.cursor = 'pointer';
          g.addEventListener('click', (e) => { e.stopPropagation(); openChipViewer(inner); });
        }
        svg.appendChild(g);
      });
    }

    applyViewBox();

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width;
      const py = (e.clientY - rect.top) / rect.height;

      const factor = Math.exp(-e.deltaY * 0.0015);
      const nextZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomLevel * factor));
      zoomLevel = nextZoom;

      const cursorX = view.x + px * view.w;
      const cursorY = view.y + py * view.h;
      view.w = baseBox.w / zoomLevel;
      view.h = baseBox.h / zoomLevel;
      view.x = cursorX - px * view.w;
      view.y = cursorY - py * view.h;

      applyViewBox();
    }, { passive:false });

    let panState = null;
    svg.addEventListener('pointerdown', (e) => {
      if(e.target.closest('g')) return;
      panState = { x:e.clientX, y:e.clientY, vx:view.x, vy:view.y };
      svg.setPointerCapture(e.pointerId);
      svg.style.cursor = 'grabbing';
    });
    svg.addEventListener('pointermove', (e) => {
      if(!panState) return;
      const rect = svg.getBoundingClientRect();
      const dx = (e.clientX - panState.x) * (view.w / rect.width);
      const dy = (e.clientY - panState.y) * (view.h / rect.height);
      view.x = panState.vx - dx;
      view.y = panState.vy - dy;
      applyViewBox();
    });
    const endPan = () => { panState = null; svg.style.cursor = 'grab'; };
    svg.addEventListener('pointerup', endPan);
    svg.addEventListener('pointercancel', endPan);
    svg.style.cursor = 'grab';

    const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
    const escHandler = (e) => { if(e.key === 'Escape') close(); };
    overlay.querySelector('.chip-viewer-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if(e.target === overlay) close(); });
    document.addEventListener('keydown', escHandler);
  }

  function setupPartButton(btn){
    const type = btn.dataset.type;
    btn.setAttribute('draggable', 'true');
    btn.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', type));
    btn.addEventListener('click', () => {
      const x = canvasWrap.scrollLeft / zoom + 60 + (spawnCount % 6) * 40;
      const y = canvasWrap.scrollTop / zoom + 40 + Math.floor(spawnCount / 6) * 90;
      spawnCount++;
      createNode(type, x, y);
      snapshot();
    });
  }

  clearSavedCustomChip('Dip Switch');
  restoreCustomChips();

  const previewPath = document.createElementNS('http://www.w3.org/2000/svg','path');
  previewPath.setAttribute('class','wire-vis temp');
  previewPath.style.display = 'none';
  wireLayer.appendChild(previewPath);

  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(()=>toastEl.classList.remove('show'), 1600);
  }

  function makeId(prefix){ return prefix + (++nodeSeq); }

  function inputWireKey(nodeId, inputIndex){ return `${nodeId}:${inputIndex}`; }
  function getInputWire(nodeId, inputIndex){ return inputWires.get(inputWireKey(nodeId, inputIndex)); }
  function rebuildWireIndex(){
    inputWires.clear();
    wires.forEach(w => inputWires.set(inputWireKey(w.to, w.toIndex), w));
  }

  function setNodeScale(newScale) {
    nodeScale = Math.max(0.5, Math.min(3.0, newScale));
    nodes.forEach(node => {
      if(node.type !== 'SEVEN' && node.type !== 'FOURTEEN') {
        node.el.style.transformOrigin = 'top left';
        node.el.style.transform = `scale(${nodeScale}) rotate(${node.rotation || 0}deg)`;
      }
    });
    routingRevision++;
    toast(`Node scale: ${Math.round(nodeScale * 100)}%`);
  }

  window.setNodeScale = setNodeScale;

  function rotateNode(node){
    node.rotation = ((node.rotation || 0) + 90) % 360;
    node.el.style.transform = `scale(${nodeScale}) rotate(${node.rotation}deg)`;
    snapshot();
    toast(`Rotated ${node.rotation}°`);
  }

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const DEFAULT_SPEAKER_SETTINGS = { frequency: 880, volume: 18, waveform: 'square' };

  document.addEventListener('pointerdown', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }, { once: true });

  function clampSpeakerFrequency(value){
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_SPEAKER_SETTINGS.frequency;
    return Math.min(4000, Math.max(80, parsed));
  }

  function clampSpeakerVolume(value){
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_SPEAKER_SETTINGS.volume;
    return Math.min(35, Math.max(0, parsed));
  }

  function getSpeakerSettings(node){
    if (!node.speakerSettings) {
      node.speakerSettings = { ...DEFAULT_SPEAKER_SETTINGS };
    }
    node.speakerSettings.frequency = clampSpeakerFrequency(node.speakerSettings.frequency);
    node.speakerSettings.volume = clampSpeakerVolume(node.speakerSettings.volume);
    if (!['sine', 'triangle', 'square', 'sawtooth'].includes(node.speakerSettings.waveform || '')) {
      node.speakerSettings.waveform = DEFAULT_SPEAKER_SETTINGS.waveform;
    }
    return node.speakerSettings;
  }

  function updateSpeakerReadouts(node){
    const settings = getSpeakerSettings(node);
    const freqReadout = node.el && node.el.querySelector('.speaker-frequency-readout');
    const volReadout = node.el && node.el.querySelector('.speaker-volume-readout');
    if (freqReadout) freqReadout.textContent = `${settings.frequency} Hz`;
    if (volReadout) volReadout.textContent = `${settings.volume}%`;
  }

  function applySpeakerAudioSettings(node){
    const settings = getSpeakerSettings(node);
    updateSpeakerReadouts(node);
    if (!node.oscillator) return;
    const now = audioCtx.currentTime;
    node.oscillator.type = settings.waveform;
    node.oscillator.frequency.setTargetAtTime(settings.frequency, now, 0.04);
    const targetGain = (settings.volume / 100) * 0.28;
    node.gainNode.gain.cancelScheduledValues(now);
    node.gainNode.gain.setTargetAtTime(targetGain, now, 0.05);
  }

  function stopSpeakerAudio(node) {
    if (node.fadeStopTimeout) {
      clearTimeout(node.fadeStopTimeout);
      node.fadeStopTimeout = null;
    }
    if (node.oscillator) {
      try { node.oscillator.stop(); } catch (e) {}
      try { node.oscillator.disconnect(); } catch (e) {}
      node.oscillator = null;
    }
    if (node.gainNode) {
      try { node.gainNode.disconnect(); } catch (e) {}
      node.gainNode = null;
    }
  }

  function playTone(node, active) {
    const settings = getSpeakerSettings(node);
    const targetGain = (settings.volume / 100) * 0.28;
    const fadeTime = 0.05;

    if (active) {
      if (!node.oscillator) {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        node.oscillator = audioCtx.createOscillator();
        node.gainNode = audioCtx.createGain();
        node.oscillator.type = settings.waveform;
        node.oscillator.frequency.setValueAtTime(settings.frequency, audioCtx.currentTime);
        node.gainNode.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        node.oscillator.connect(node.gainNode);
        node.gainNode.connect(audioCtx.destination);
        node.oscillator.start();
      }

      clearTimeout(node.fadeStopTimeout);
      node.fadeStopTimeout = null;
      const now = audioCtx.currentTime;
      node.oscillator.type = settings.waveform;
      node.oscillator.frequency.setTargetAtTime(settings.frequency, now, 0.04);
      node.gainNode.gain.cancelScheduledValues(now);
      node.gainNode.gain.setTargetAtTime(targetGain, now, fadeTime);
    } else if (node.oscillator) {
      clearTimeout(node.fadeStopTimeout);
      const now = audioCtx.currentTime;
      node.gainNode.gain.cancelScheduledValues(now);
      node.gainNode.gain.setTargetAtTime(0.0001, now, fadeTime);
      node.fadeStopTimeout = setTimeout(() => {
        if (!node.oscillator) return;
        node.oscillator.stop();
        node.oscillator.disconnect();
        node.oscillator = null;
        node.gainNode.disconnect();
        node.gainNode = null;
      }, 120);
    }
  }

    function getNodeGlyph(type){
    if(isCustomChip(type)) return '<span class="node-chip-symbol">▣</span>';
    const glyphs = {
      INPUT: '<span class="node-chip-symbol">◎</span>',
      BUTTON: '<span class="node-chip-symbol">●</span>',
      CLOCK: '<span class="node-chip-symbol">◷</span>',
      OSCLOCK: '<span class="node-chip-symbol">◷</span>',
      OUTPUT: '<span class="node-chip-symbol">◉</span>',
      SPEAKER: '<svg viewBox="0 0 24 16" aria-hidden="true"><path d="M2 6 H6 L11 2 V14 L6 10 H2 Z M14 5 Q18 8 14 11 M17 3 Q23 8 17 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      LCD: '<span class="node-chip-symbol">▭</span>',
      SEVEN: '<span class="node-chip-symbol">8</span>',
      FOURTEEN: '<span class="node-chip-symbol">M</span>',
      AND: '<svg viewBox="0 0 24 16"><path d="M2 1 H12 A7 7 0 0 1 12 15 H2 Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
      OR: '<svg viewBox="0 0 24 16"><path d="M2 1 Q9 1 12 8 Q9 15 2 15 Q6 8 2 1 Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
      OR3: '<svg viewBox="0 0 24 16"><path d="M2 1 Q9 1 12 8 Q9 15 2 15 Q6 8 2 1 Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
      OR3IN: '<svg viewBox="0 0 24 16"><path d="M2 1 Q9 1 12 8 Q9 15 2 15 Q6 8 2 1 Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
      OR2OUT: '<svg viewBox="0 0 24 16"><path d="M2 1 Q9 1 12 8 Q9 15 2 15 Q6 8 2 1 Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
      NOT: '<svg viewBox="0 0 24 16"><path d="M2 1 L2 15 L14 8 Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="16.5" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
      NAND: '<svg viewBox="0 0 24 16"><path d="M2 1 H10 A7 7 0 0 1 10 15 H2 Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="19" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
      NOR: '<svg viewBox="0 0 24 16"><path d="M2 1 Q8 1 10 8 Q8 15 2 15 Q5 8 2 1 Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="16" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
      XOR: '<svg viewBox="0 0 24 16"><path d="M4 1 Q10 1 13 8 Q10 15 4 15 Q7.5 8 4 1 Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M1 1 Q4.5 8 1 15" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
      XNOR: '<svg viewBox="0 0 24 16"><path d="M3 1 Q9 1 12 8 Q9 15 3 15 Q6.5 8 3 1 Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M0.5 1 Q4 8 0.5 15" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="14.5" cy="8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
      MEMORY: '<svg viewBox="0 0 24 16"><rect x="2" y="1" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="11" y="11.5" font-size="8" text-anchor="middle" fill="currentColor" font-family="monospace">M</text></svg>',
      DELAY: '<span class="node-chip-symbol">⏱</span>',
      CALCULATOR: '<span class="node-chip-symbol">ƒ</span>',
      GREATER: '<span class="node-chip-symbol">&gt;</span>',
      XAND: '<span class="node-chip-symbol">&amp;</span>',
      JOYSTICK: '<span class="node-chip-symbol">🕹</span>',
      DIPSWITCH: '<span class="node-chip-symbol">▣</span>',
      LABEL: '<span class="node-chip-symbol">✎</span>'
    };
    return glyphs[type] || '<span class="node-chip-symbol">◈</span>';
  }

  function createNode(type, x, y){
    routingRevision++;
    const id = makeId('n');
    const nInputs = INPUT_COUNT[type];
    const el = document.createElement('div');
    el.className = 'node type-' + type;
    if(isDipSwitchType(type)) {
      el.classList.add('dip-switch-node');
    }
    el.style.left = x+'px';
    el.style.top = y+'px';
    el.style.transformOrigin = 'top left';
    if(type !== 'SEVEN' && type !== 'FOURTEEN') {
      el.style.transform = `scale(${nodeScale}) rotate(0deg)`;
    }
    el.dataset.id = id;

    const head = document.createElement('div');
    head.className = 'node-head';
    head.innerHTML = `<span class="node-chip-mark">${getNodeGlyph(type)}</span><span class="node-chip-label">${LABELS[type]}</span>`;
    el.appendChild(head);

    const del = document.createElement('div');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete part';
    del.addEventListener('click', (e)=>{ e.stopPropagation(); removeNode(id); snapshot(); });
    el.appendChild(del);

    const body = document.createElement('div');
    body.className = 'node-body';

    let inPins = [];
    let outPin = null;
    let outPins = [];

        const node = {
      id, type, x, y, value:false,
      el, inPins, outPin, outPins, led: null, lcdDisplay: null,
      nInputs, period:1500, startTime:simulationTime,
      knobX: 0, knobY: 0, operation: '+', calcInputs: [0, 0], history: [], delayTicks: 1, buffer: [false],
      osTargetTime: null, osAlarmTriggered: false, osAlarmStopped: false, rotation: 0,
      switches: isDipSwitchType(type) ? new Array(6).fill(false) : undefined,
      labelText: type === 'LABEL' ? ' ' : undefined
    };

    if(type === 'LABEL'){
      const area = document.createElement('textarea');
      area.className = 'node-label-area';
      area.value = node.labelText;
      area.placeholder = 'Type something...';
      area.spellcheck = false;
      area.addEventListener('input', (e) => {
        node.labelText = e.target.value;
      });
      area.addEventListener('change', () => snapshot());
      // Prevent dragging the node when interacting with the textarea
      area.addEventListener('pointerdown', e => e.stopPropagation());
      body.appendChild(area);
      el.classList.add('node-is-label');
    } else if(type === 'INPUT'){
      const toggle = document.createElement('div');
      toggle.className = 'toggle';
      toggle.innerHTML = '<div class="knob"></div>';
      toggle.addEventListener('click', ()=>{
        node.value = !node.value;
        toggle.classList.toggle('on', node.value);
        snapshot();
      });
      body.appendChild(toggle);
      const outWrap = document.createElement('div');
      outWrap.className = 'pins out';
      outPin = document.createElement('div');
      outPin.className = 'pin out';
      outPin.dataset.nodeId = id;
      outPin.dataset.kind = 'out';
      outPin.dataset.index = '0';
      outWrap.appendChild(outPin);
      body.appendChild(outWrap);
    } else if(type === 'OUTPUT'){
      const inWrap = document.createElement('div');
      inWrap.className = 'pins in';
      const p = document.createElement('div');
      p.className = 'pin in'; 
      p.dataset.index = '0';
      p.dataset.nodeId = id;
      p.dataset.kind = 'in';
      inWrap.appendChild(p);
      inPins.push(p);
      body.appendChild(inWrap);
      const led = document.createElement('div');
      led.className = 'led';
      body.appendChild(led);
    } else if(type === 'BUTTON'){
      const btn = document.createElement('div');
      btn.className = 'pushbtn';
      const press = (e)=>{ e.preventDefault(); node.value = true; btn.classList.add('pressed'); };
      const release = ()=>{ node.value = false; btn.classList.remove('pressed'); };
      btn.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); press(e); btn.setPointerCapture(e.pointerId); });
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      body.appendChild(btn);
      const outWrap = document.createElement('div');
      outWrap.className = 'pins out';
      outPin = document.createElement('div');
      outPin.className = 'pin out';
      outPin.dataset.nodeId = id;
      outPin.dataset.kind = 'out';
      outPin.dataset.index = '0';
      outWrap.appendChild(outPin);
      body.appendChild(outWrap);
    } else if(type === 'CLOCK'){
      const widget = document.createElement('div');
      widget.className = 'clk-widget';
      const clockConfig = document.createElement('div');
      clockConfig.className = 'delay-config';
      clockConfig.innerHTML = `
        <select class="delay-select clock-select" data-node-id="${id}">
          <option value="1500" selected>1.5 Sec</option>
          <option value="750">0.75 Sec</option>
          <option value="350">0.35 Sec</option>
        </select>
      `;
      widget.appendChild(clockConfig);
      const led = document.createElement('div');
      led.className = 'led';
      widget.appendChild(led);
      body.appendChild(widget);
      const outWrap = document.createElement('div');
      outWrap.className = 'pins out';
      outPin = document.createElement('div');
      outPin.className = 'pin out';
      outPin.dataset.nodeId = id;
      outPin.dataset.kind = 'out';
      outPin.dataset.index = '0';
      outWrap.appendChild(outPin);
      body.appendChild(outWrap);
        }else if(type === 'OSCLOCK'){
          const alarmWrap = document.createElement('div');
          alarmWrap.className = 'osclock-config';
          const alarmInput = document.createElement('input');
          alarmInput.type = 'datetime-local';
          alarmInput.className = 'osclock-input';
          alarmInput.dataset.nodeId = id;
          alarmInput.title = 'Set alarm date and time';
          const alarmOff = document.createElement('button');
          alarmOff.type = 'button';
          alarmOff.className = 'osclock-off';
          alarmOff.dataset.nodeId = id;
          alarmOff.textContent = 'OFF';
          alarmOff.title = 'Turn off the alarm output';
          alarmWrap.appendChild(alarmInput);
          alarmWrap.appendChild(alarmOff);
          body.appendChild(alarmWrap);

          const stopWrap = document.createElement('div');
          stopWrap.className = 'pins in';
          const stopPin = document.createElement('div');
          stopPin.className = 'pin in';
          stopPin.dataset.index = '0';
          stopPin.dataset.nodeId = id;
          stopPin.dataset.kind = 'in';
          stopWrap.appendChild(stopPin);
          inPins.push(stopPin);
          body.appendChild(stopWrap);

          const outWrap = document.createElement('div');
          outWrap.className = 'pins out';
          const outPinElement = document.createElement('div');
          outPinElement.className = 'pin out';
          outPinElement.dataset.index = '0';
          outPinElement.dataset.nodeId = id;
          outPinElement.dataset.kind = 'out';
          outWrap.appendChild(outPinElement);
          outPins.push(outPinElement);
          body.appendChild(outWrap);

    } else if(isDipSwitchType(type)) {
      const switchStack = document.createElement('div');
      switchStack.className = 'switch-assembly-stack';
      switchStack.style.display = 'flex';
      switchStack.style.flexDirection = 'column';
      switchStack.style.gap = '4px';
      switchStack.style.padding = '7px 6px';
      switchStack.style.width = '60px';
      switchStack.style.background = 'linear-gradient(180deg,#f0f0ef,#d8d8d6)';
      switchStack.style.border = '1px solid var(--panel-edge)';
      switchStack.style.borderRadius = '6px';
      switchStack.style.boxShadow = 'inset 0 0 0 1px rgba(0,0,0,0.08)';

      const dipState = new Array(6).fill(false);
      for(let i = 0; i < 6; i++) {
        const toggle = document.createElement('div');
        toggle.className = 'dip-toggle';
        toggle.title = `Switch ${i + 1}`;
        toggle.style.position = 'relative';
        toggle.style.width = '32px';
        toggle.style.height = '12px';
        toggle.style.borderRadius = '3px';
        toggle.style.border = '1px solid var(--panel-edge)';
        toggle.style.background = '#b8b7b3';
        toggle.style.cursor = 'pointer';
        toggle.style.boxShadow = 'inset 0 0 0 1px rgba(0,0,0,0.08)';
        const slider = document.createElement('div');
        slider.style.position = 'absolute';
        slider.style.top = '1px';
        slider.style.left = '1px';
        slider.style.width = '12px';
        slider.style.height = '8px';
        slider.style.borderRadius = '2px';
        slider.style.background = '#e9d27a';
        slider.style.transition = 'left .12s ease';
        toggle.appendChild(slider);
        switchStack.appendChild(toggle);
      }
      body.appendChild(switchStack);

      const outWrap = document.createElement('div');
      outWrap.className = 'pins out';
      for(let i = 0; i < 6; i++) {
        const pin = document.createElement('div');
        pin.className = 'pin out';
        pin.dataset.index = String(i);
        pin.dataset.nodeId = id;
        pin.dataset.kind = 'out';
        outWrap.appendChild(pin);
        outPins.push(pin);
      }
      body.appendChild(outWrap);

    } else if(isCustomChip(type)) {
      const definition = customChips.get(type);
      const inWrap = document.createElement('div');
      inWrap.className = 'pins in';
      for(let i = 0; i < definition.inputs.length; i++) {
        const pin = document.createElement('div');
        pin.className = 'pin in';
        pin.dataset.index = String(i);
        pin.dataset.nodeId = id;
        pin.dataset.kind = 'in';
        inWrap.appendChild(pin);
        inPins.push(pin);
      }
      body.appendChild(inWrap);
      const outWrap = document.createElement('div');
      outWrap.className = 'pins out';
      for(let i = 0; i < definition.outputs.length; i++) {
        const pin = document.createElement('div');
        pin.className = 'pin out';
        pin.dataset.index = String(i);
        pin.dataset.nodeId = id;
        pin.dataset.kind = 'out';
        outWrap.appendChild(pin);
        outPins.push(pin);
      }
      body.appendChild(outWrap);

    } else if(type === 'SEVEN'){
      const inWrap = document.createElement('div');
      inWrap.className = 'pins in';
      for(let i=0;i<7;i++){
        const p = document.createElement('div');
        p.className = 'pin in'; 
        p.dataset.index = String(i);
        p.dataset.nodeId = id;
        p.dataset.kind = 'in';
        inWrap.appendChild(p);
        inPins.push(p);
      }
      body.appendChild(inWrap);
      const screenContainer = document.createElement('div');
      screenContainer.className = 'display-scale-container';
      
      const screen = document.createElement('div');
      screen.className = 'seven-seg-screen';
      screen.innerHTML = `
        <div class="seg seg-a"></div><div class="seg seg-b"></div>
        <div class="seg seg-c"></div><div class="seg seg-d"></div>
        <div class="seg seg-e"></div><div class="seg seg-f"></div>
        <div class="seg seg-g"></div>
      `;
      screenContainer.appendChild(screen);
      body.appendChild(screenContainer);
    } else if(type === 'FOURTEEN'){
      const inWrap = document.createElement('div');
      inWrap.className = 'pins in';
      for(let i=0;i<14;i++){
        const p = document.createElement('div');
        p.className = 'pin in'; 
        p.dataset.index = String(i);
        p.dataset.nodeId = id;
        p.dataset.kind = 'in';
        inWrap.appendChild(p);
        inPins.push(p);
      }
      body.appendChild(inWrap);
      
      const screenContainer = document.createElement('div');
      screenContainer.className = 'display-scale-container';

      const screen = document.createElement('div');
      screen.className = 'fourteen-seg-screen';
      screen.innerHTML = `
        <div class="fseg fseg-a"></div>
        <div class="fseg fseg-b"></div>
        <div class="fseg fseg-c"></div>
        <div class="fseg fseg-d"></div>
        <div class="fseg fseg-e"></div>
        <div class="fseg fseg-f"></div>
        <div class="fseg fseg-h"></div>
        <div class="fseg fseg-i"></div>
        <div class="fseg fseg-j"></div>
        <div class="fseg fseg-k"></div>
        <div class="fseg fseg-l"></div>
        <div class="fseg fseg-m"></div>
        <div class="fseg fseg-g1"></div>
        <div class="fseg fseg-g2"></div>
      `;
      screenContainer.appendChild(screen);
      body.appendChild(screenContainer);
    } else if(type === 'LCD'){
      const inWrap = document.createElement('div');
      inWrap.className = 'pins in';
      for(let i=0;i<nInputs;i++){
        const p = document.createElement('div');
        p.className = 'pin in'; 
        p.dataset.index = String(i);
        p.dataset.nodeId = id;
        p.dataset.kind = 'in';
        inWrap.appendChild(p);
        inPins.push(p);
      }
      body.appendChild(inWrap);
      const screenContainer = document.createElement('div');
      screenContainer.className = 'display-scale-container';

      const screen = document.createElement('div');
      screen.className = 'lcd-screen';
      screen.textContent = '00';
      screenContainer.appendChild(screen);

      body.appendChild(screenContainer);
    } else if(type === 'JOYSTICK'){
      el.style.position = 'absolute';
      const pad = document.createElement('div');
      pad.className = 'joystick-pad';
      const knob = document.createElement('div');
      knob.className = 'joystick-knob';
      pad.appendChild(knob);
      
      const pinTop = document.createElement('div');
      pinTop.className = 'pin out';
      pinTop.style.position = 'absolute';
      pinTop.style.top = '-6px';
      pinTop.style.left = '50%';
      pinTop.style.transform = 'translateX(-50%)';
      pinTop.dataset.nodeId = id;
      pinTop.dataset.kind = 'out';
      pinTop.dataset.index = '0';
      el.appendChild(pinTop);
      outPins.push(pinTop);

      const pinBottom = document.createElement('div');
      pinBottom.className = 'pin out';
      pinBottom.style.position = 'absolute';
      pinBottom.style.bottom = '-6px';
      pinBottom.style.left = '50%';
      pinBottom.style.transform = 'translateX(-50%)';
      pinBottom.dataset.nodeId = id;
      pinBottom.dataset.kind = 'out';
      pinBottom.dataset.index = '1';
      el.appendChild(pinBottom);
      outPins.push(pinBottom);

      const pinLeft = document.createElement('div');
      pinLeft.className = 'pin out';
      pinLeft.style.position = 'absolute';
      pinLeft.style.left = '-6px';
      pinLeft.style.top = '50%';
      pinLeft.style.transform = 'translateY(-50%)';
      pinLeft.dataset.nodeId = id;
      pinLeft.dataset.kind = 'out';
      pinLeft.dataset.index = '2';
      el.appendChild(pinLeft);
      outPins.push(pinLeft);

      const pinRight = document.createElement('div');
      pinRight.className = 'pin out';
      pinRight.style.position = 'absolute';
      pinRight.style.right = '-3px';
      pinRight.style.top = '50%';
      pinRight.style.transform = 'translateY(-50%)';
      pinRight.dataset.nodeId = id;
      pinRight.dataset.kind = 'out';
      pinRight.dataset.index = '3';
      el.appendChild(pinRight);
      outPins.push(pinRight);

      body.appendChild(pad);

      let isDraggingJoy = false;
      pad.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        isDraggingJoy = true;
        pad.setPointerCapture(e.pointerId);
      });
      pad.addEventListener('pointermove', (e) => {
        if(!isDraggingJoy) return;
        const rect = pad.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        let dx = e.clientX - centerX;
        let dy = e.clientY - centerY;
        const dist = Math.sqrt(dx*dx + dy*dy);
        const maxRadius = 30; 
        if(dist > maxRadius) {
          dx = (dx / dist) * maxRadius;
          dy = (dy / dist) * maxRadius;
        }
        node.knobX = dx;
        node.knobY = dy;
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
      });
      const endJoy = (e) => {
        if(!isDraggingJoy) return;
        isDraggingJoy = false;
        node.knobX = 0;
        node.knobY = 0;
        knob.style.transform = `translate(0px, 0px)`;
      };
      pad.addEventListener('pointerup', endJoy);
      pad.addEventListener('pointercancel', endJoy);
    } else if(type === 'SPEAKER'){
      const inWrap = document.createElement('div');
      inWrap.className = 'pins in';
      const p = document.createElement('div');
      p.className = 'pin in'; 
      p.dataset.index = '0';
      p.dataset.nodeId = id;
      p.dataset.kind = 'in';
      inWrap.appendChild(p);
      inPins.push(p);
      body.appendChild(inWrap);

      const configWrap = document.createElement('div');
      configWrap.className = 'speaker-config';
      configWrap.innerHTML = `
        <label class="speaker-setting">
          <div class="speaker-setting-header">
            <span>Hz</span>
            <strong class="speaker-frequency-readout">880 Hz</strong>
          </div>
          <input class="speaker-frequency" data-node-id="${id}" type="range" min="80" max="4000" step="10" value="${DEFAULT_SPEAKER_SETTINGS.frequency}" />
        </label>
        <label class="speaker-setting">
          <div class="speaker-setting-header">
            <span>Vol</span>
            <strong class="speaker-volume-readout">18%</strong>
          </div>
          <input class="speaker-volume" data-node-id="${id}" type="range" min="0" max="35" step="1" value="${DEFAULT_SPEAKER_SETTINGS.volume}" />
        </label>
        <label class="speaker-setting">
          <span>Wave</span>
          <select class="speaker-waveform" data-node-id="${id}">
            <option value="sine">Sine</option>
            <option value="triangle">Triangle</option>
            <option value="square">Square</option>
            <option value="sawtooth">Saw</option>
          </select>
        </label>
      `;
      body.appendChild(configWrap);

      const frequencyInput = configWrap.querySelector('.speaker-frequency');
      const volumeInput = configWrap.querySelector('.speaker-volume');
      const waveformSelect = configWrap.querySelector('.speaker-waveform');
      const settings = getSpeakerSettings(node);
      frequencyInput.value = String(settings.frequency);
      volumeInput.value = String(settings.volume);
      waveformSelect.value = settings.waveform;
      updateSpeakerReadouts(node);

      frequencyInput.addEventListener('input', (e) => {
        node.speakerSettings = { ...getSpeakerSettings(node), frequency: clampSpeakerFrequency(e.target.value) };
        applySpeakerAudioSettings(node);
        snapshot();
      });
      volumeInput.addEventListener('input', (e) => {
        node.speakerSettings = { ...getSpeakerSettings(node), volume: clampSpeakerVolume(e.target.value) };
        applySpeakerAudioSettings(node);
        snapshot();
      });
      waveformSelect.addEventListener('change', (e) => {
        node.speakerSettings = { ...getSpeakerSettings(node), waveform: e.target.value };
        applySpeakerAudioSettings(node);
        snapshot();
      });
    } else if(type === 'OR2OUT') {
      const inWrap = document.createElement('div');
      inWrap.className = 'pins in';
      for(let i=0;i<2;i++){
        const p = document.createElement('div');
        p.className = 'pin in';
        p.dataset.index = String(i);
        p.dataset.nodeId = id;
        p.dataset.kind = 'in';
        inWrap.appendChild(p);
        inPins.push(p);
      }
      body.appendChild(inWrap);

      const outWrap = document.createElement('div');
      outWrap.className = 'pins out';
      for(let i=0;i<2;i++){
        const p = document.createElement('div');
        p.className = 'pin out';
        p.dataset.index = String(i);
        p.dataset.nodeId = id;
        p.dataset.kind = 'out';
        outWrap.appendChild(p);
        outPins.push(p);
        if(i === 0) outPin = p;
      }
      body.appendChild(outWrap);
    } else {
      const inWrap = document.createElement('div');
      inWrap.className = 'pins in';
      for(let i=0;i<nInputs;i++){
        const p = document.createElement('div');
        p.className = 'pin in'; 
        p.dataset.index = String(i);
        p.dataset.nodeId = id;
        p.dataset.kind = 'in';
        inWrap.appendChild(p);
        inPins.push(p);
      }
      body.appendChild(inWrap);
      
      if (type === 'DELAY') {
        const currentTicks = 1;
        const configWrap = document.createElement('div');
        configWrap.className = 'delay-config';
        configWrap.innerHTML = `
          <select class="delay-select" data-node-id="${id}">
            <option value="1" ${currentTicks === 1 ? 'selected' : ''}>1 Tick (16ms)</option>
            <option value="2" ${currentTicks === 2 ? 'selected' : ''}>2 Ticks (~32ms)</option>
            <option value="5" ${currentTicks === 5 ? 'selected' : ''}>5 Ticks (~80ms)</option>
            <option value="10" ${currentTicks === 10 ? 'selected' : ''}>10 Ticks (~160ms)</option>
            <option value="15" ${currentTicks === 15 ? 'selected' : ''}>15 Ticks (~240ms)</option>
            <option value="16" ${currentTicks === 16 ? 'selected' : ''}>16 Ticks (~256ms)</option>
            <option value="17" ${currentTicks === 17 ? 'selected' : ''}>17 Ticks (~272ms)</option>
            <option value="18" ${currentTicks === 18 ? 'selected' : ''}>18 Ticks (~288ms)</option>
            <option value="19" ${currentTicks === 19 ? 'selected' : ''}>19 Ticks (~304ms)</option>
            <option value="20" ${currentTicks === 20 ? 'selected' : ''}>20 Ticks (~320ms)</option>
            <option value="40" ${currentTicks === 40 ? 'selected' : ''}>40 Ticks (~640ms)</option>
            <option value="60" ${currentTicks === 60 ? 'selected' : ''}>60 Ticks (~1 Sec)</option>
            <option value="120" ${currentTicks === 120 ? 'selected' : ''}>120 Ticks (~2 Sec)</option>
            <option value="600" ${currentTicks === 600 ? 'selected' : ''}>600 Ticks (~10 Sec)</option>
            <option value="3600" ${currentTicks === 3600 ? 'selected' : ''}>3600 Ticks (1 Min)</option>
          </select>
        `;
        body.appendChild(configWrap);
      }
      const outWrap = document.createElement('div');
      outWrap.className = 'pins out';
      outPin = document.createElement('div');
      outPin.className = 'pin out';
      outPin.dataset.nodeId = id;
      outPin.dataset.kind = 'out';
      outPin.dataset.index = '0';
      outWrap.appendChild(outPin);
      body.appendChild(outWrap);

      if(type === 'CALCULATOR') {
        node.operation = node.operation || '+';
        node.calcInputs = node.calcInputs || [0, 0];

        const configWrap = document.createElement('div');
        configWrap.className = 'calc-config';

        const operandsRow = document.createElement('div');
        operandsRow.className = 'calc-operands';

        const inputA = document.createElement('input');
        inputA.type = 'number';
        inputA.className = 'calc-operand';
        inputA.value = node.calcInputs[0];
        inputA.step = 'any';
        inputA.title = 'Used when input A has no wire connected';
        inputA.addEventListener('mousedown', e => e.stopPropagation());
        inputA.addEventListener('click', e => e.stopPropagation());
        inputA.addEventListener('input', (e) => {
          node.calcInputs[0] = Number(e.target.value) || 0;
          snapshot();
        });

        const opBtn = document.createElement('div');
        opBtn.className = 'calc-op-btn';
        opBtn.textContent = node.operation;
        opBtn.title = 'Click to cycle operation';
        opBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const ops = ['+', '-', '*', '/', '^'];
          const idx = (ops.indexOf(node.operation || '+') + 1) % ops.length;
          node.operation = ops[idx];
          opBtn.textContent = node.operation;
          snapshot();
        });

        const inputB = document.createElement('input');
        inputB.type = 'number';
        inputB.className = 'calc-operand';
        inputB.value = node.calcInputs[1];
        inputB.step = 'any';
        inputB.title = 'Used when input B has no wire connected';
        inputB.addEventListener('mousedown', e => e.stopPropagation());
        inputB.addEventListener('click', e => e.stopPropagation());
        inputB.addEventListener('input', (e) => {
          node.calcInputs[1] = Number(e.target.value) || 0;
          snapshot();
        });

        operandsRow.appendChild(inputA);
        operandsRow.appendChild(opBtn);
        operandsRow.appendChild(inputB);
        configWrap.appendChild(operandsRow);

        const readout = document.createElement('div');
        readout.className = 'calc-readout';
        readout.textContent = '0';
        configWrap.appendChild(readout);

        const hint = document.createElement('div');
        hint.className = 'calc-hint';
        hint.textContent = 'wire overrides typed value';
        configWrap.appendChild(hint);

        body.appendChild(configWrap);
        node.calcInputEls = [inputA, inputB];
        node.calcReadout = readout;
      }
    }

    el.appendChild(body);
    canvasInner.appendChild(el);

    node.outPin = outPin;
    node.led = el.querySelector('.led');
    node.lcdDisplay = el.querySelector('.lcd-screen, .seven-seg-screen, .fourteen-seg-screen');
    if(isDipSwitchType(type)) {
      const toggles = Array.from(el.querySelectorAll('.dip-toggle'));
      toggles.forEach((toggle, index) => {
        const slider = toggle.querySelector('div');
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          node.switches[index] = !node.switches[index];
          slider.style.left = node.switches[index] ? '17px' : '1px';
          toggle.style.background = node.switches[index] ? '#d2d1ce' : '#b8b7b3';
          node.outValues = node.switches.map(Boolean);
          node.value = !!node.switches[0];
          node.outPins.forEach((p, pIdx) => p.classList.toggle('hot', !!node.outValues[pIdx]));
        });
      });
    }
    nodes.set(id, node);

    node.outPins = outPins;

    if(isCustomChip(type)){
      el.addEventListener('pointerenter', () => { hoveredChipNode = node; });
      el.addEventListener('pointerleave', () => { if(hoveredChipNode === node) hoveredChipNode = null; });
    }

    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.pin, button, input, select, .del, .pushbtn, .toggle, .dip-toggle, .osclock-off')) return;
      e.stopPropagation();
      duplicateNode(node);
    });

    attachDrag(node, head);
    
    inPins.forEach((p, idx) => {
      p.addEventListener('pointerdown', (e) => onPinPointerDown(node, 'in', idx, p, e));
      p.addEventListener('pointerup', (e) => onPinPointerUp(node, 'in', idx, p, e));
    });
    
    if(node.outPin) {
      node.outPin.addEventListener('pointerdown', (e) => onPinPointerDown(node, 'out', 0, node.outPin, e));
      node.outPin.addEventListener('pointerup', (e) => onPinPointerUp(node, 'out', 0, node.outPin, e));
    }

    if(node.outPins && node.outPins.length > 0) {
      node.outPins.forEach((p, idx) => {
        p.addEventListener('pointerdown', (e) => onPinPointerDown(node, 'out', idx, p, e));
        p.addEventListener('pointerup', (e) => onPinPointerUp(node, 'out', idx, p, e));
      });
    }

    return node;
  }

    function duplicateNode(source){
    const duplicate = createNode(source.type, source.x + 40, source.y + 40);
    duplicate.value = source.value;
    duplicate.period = source.period;
    duplicate.delayTicks = source.delayTicks;
    duplicate.buffer = source.buffer ? [...source.buffer] : [false];
    duplicate.operation = source.operation;
    duplicate.calcInputs = source.calcInputs ? [...source.calcInputs] : [0, 0];
    duplicate.rotation = source.rotation || 0;
    duplicate.osTargetTime = source.osTargetTime;
    duplicate.osAlarmTriggered = source.osAlarmTriggered;
    duplicate.osAlarmStopped = source.osAlarmStopped;
    duplicate.speakerSettings = source.speakerSettings ? { ...source.speakerSettings } : { ...DEFAULT_SPEAKER_SETTINGS };
    duplicate.labelText = source.labelText;

    const inputToggle = duplicate.el.querySelector('.toggle');
    if(inputToggle) inputToggle.classList.toggle('on', duplicate.value);
    const clockSelect = duplicate.el.querySelector('.clock-select');
    if(clockSelect) clockSelect.value = duplicate.period;
    const delaySelect = duplicate.el.querySelector('.delay-select');
    if(delaySelect) delaySelect.value = duplicate.delayTicks;
    const frequencyInput = duplicate.el.querySelector('.speaker-frequency');
    if(frequencyInput) frequencyInput.value = String(getSpeakerSettings(duplicate).frequency);
    const volumeInput = duplicate.el.querySelector('.speaker-volume');
    if(volumeInput) volumeInput.value = String(getSpeakerSettings(duplicate).volume);
    const waveformSelect = duplicate.el.querySelector('.speaker-waveform');
    if(waveformSelect) waveformSelect.value = getSpeakerSettings(duplicate).waveform;
    const labelArea = duplicate.el.querySelector('.node-label-area');
    if(labelArea) labelArea.value = duplicate.labelText || '';
    const alarmInput = duplicate.el.querySelector('.osclock-input');
    if(alarmInput && duplicate.osTargetTime) {
      const date = new Date(duplicate.osTargetTime);
      const pad = value => String(value).padStart(2, '0');
      alarmInput.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    if(duplicate.type === 'CALCULATOR' && duplicate.calcInputEls){
      const opEl = duplicate.el.querySelector('.calc-op-btn');
      if(opEl) opEl.textContent = duplicate.operation;
      duplicate.calcInputEls[0].value = duplicate.calcInputs[0];
      duplicate.calcInputEls[1].value = duplicate.calcInputs[1];
    }
    duplicate.el.style.transform = `scale(${nodeScale}) rotate(${duplicate.rotation}deg)`;
    snapshot();
    toast('Component duplicated');
    return duplicate;
  }

  canvasInner.addEventListener('change', (e) => {
    if (e.target.classList.contains('osclock-input')) {
      const node = nodes.get(e.target.getAttribute('data-node-id'));
      if (node) {
        node.osTargetTime = e.target.value ? new Date(e.target.value).getTime() : null;
        node.osAlarmTriggered = false;
        node.osAlarmStopped = false;
        node.value = false;
        snapshot();
      }
      return;
    }
    if (e.target.classList.contains('delay-select')) {
      const nodeId = e.target.getAttribute('data-node-id');
      const node = nodes.get(nodeId);
      if (node) {
        if (node.type === 'CLOCK') {
          node.period = parseInt(e.target.value, 10);
          node.startTime = simulationTime;
        } else {
          node.delayTicks = parseInt(e.target.value, 10);
          node.buffer = new Array(node.delayTicks).fill(false);
        }
        snapshot();
      }
    }
  });

  canvasInner.addEventListener('click', (e) => {
    if (!e.target.classList.contains('osclock-off')) return;
    const node = nodes.get(e.target.getAttribute('data-node-id'));
    if (node) {
      node.value = false;
      node.osAlarmTriggered = true;
      node.osAlarmStopped = true;
      snapshot();
    }
  });

  function applyWireTarget(clientX, clientY){
    if (!pendingWireFrom) return false;

    const targetEl = document.elementFromPoint(clientX, clientY);
    const targetPin = targetEl ? targetEl.closest('.pin') : null;

    if (targetPin && targetPin.dataset.nodeId) {
      const targetNodeId = targetPin.dataset.nodeId;
      const targetKind = targetPin.dataset.kind;
      const targetIndex = parseInt(targetPin.dataset.index || '0', 10);

      if (pendingWireFrom.kind !== targetKind && pendingWireFrom.nodeId !== targetNodeId) {
        let fromId, toId, toIndex, fromIndex = 0;
        if (pendingWireFrom.kind === 'out') {
          fromId = pendingWireFrom.nodeId;
          fromIndex = pendingWireFrom.index;
          toId = targetNodeId;
          toIndex = targetIndex;
        } else {
          toId = pendingWireFrom.nodeId;
          toIndex = pendingWireFrom.index;
          fromId = targetNodeId;
          fromIndex = targetIndex;
        }

        createWire(fromId, toId, toIndex, fromIndex);
        toast('Wire connected');
        snapshot();
      }
    }

    cancelPendingWire();
    return true;
  }

  function onPinPointerDown(node, kind, index, pinEl, e) {
    e.stopPropagation();
    if (!pendingWireFrom) {
      pendingWireFrom = { nodeId: node.id, kind, index, justStarted: true, downX: e.clientX, downY: e.clientY };
      pinEl.classList.add('hot');
      if (pinEl.setPointerCapture) pinEl.setPointerCapture(e.pointerId);
    }
  }

  function onPinPointerUp(node, kind, index, pinEl, e) {
    e.stopPropagation();
    if (pendingWireFrom && pendingWireFrom.justStarted) {
      const dx = e.clientX - pendingWireFrom.downX;
      const dy = e.clientY - pendingWireFrom.downY;
      pendingWireFrom.justStarted = false;
      if (Math.hypot(dx, dy) < 6) {
        // Plain click on the starting pin (no drag) — leave the wire pending
        // so the user can click a second pin later without holding the button.
        return;
      }
    }
    applyWireTarget(e.clientX, e.clientY);
  }

  function cancelPendingWire(){
    if(pendingWireFrom){
      const n = nodes.get(pendingWireFrom.nodeId);
      if(n) {
        if(pendingWireFrom.kind === 'out') {
          if(n.outPin) n.outPin.classList.remove('hot');
          if(n.outPins && n.outPins[pendingWireFrom.index]) n.outPins[pendingWireFrom.index].classList.remove('hot');
        }
        if(pendingWireFrom.kind === 'in' && n.inPins[pendingWireFrom.index]) n.inPins[pendingWireFrom.index].classList.remove('hot');
      }
    }
    pendingWireFrom = null;
    previewPath.style.display = 'none';
  }

  function removeNode(id){
    const node = nodes.get(id);
    if(!node) return;
    if(node.type === 'SPEAKER') stopSpeakerAudio(node);
    wires = wires.filter(w=>{
      if(w.from===id || w.to===id){ disposeWire(w); return false; }
      return true;
    });
    rebuildWireIndex();
    node.el.remove();
    nodes.delete(id);
    routingRevision++;
    selectedNodeIds.delete(id);
    if(hoveredChipNode === node) hoveredChipNode = null;
  }

  function removeWire(wireId){
    const idx = wires.findIndex(w=>w.id===wireId);
    if(idx===-1) return;
    const target = nodes.get(wires[idx].to);
    if(target && target.type === 'SPEAKER') stopSpeakerAudio(target);
    disposeWire(wires[idx]);
    wires.splice(idx,1);
    rebuildWireIndex();
  }

  function disposeWire(wire){
    wire.elVis.remove();
    wire.elHit.remove();
    if(wire.elJunction) wire.elJunction.remove();
  }

  function createWire(fromId, toId, toIndex, fromIndex = 0){
    wires = wires.filter(w=>{
      if(w.to===toId && w.toIndex===toIndex){ disposeWire(w); return false; }
      return true;
    });
    const id = 'w'+(++wireSeq);
    const elHit = document.createElementNS('http://www.w3.org/2000/svg','path');
    elHit.setAttribute('class','wire-hit');
    elHit.addEventListener('click', ()=> { removeWire(id); snapshot(); });
    const elVis = document.createElementNS('http://www.w3.org/2000/svg','path');
    elVis.setAttribute('class','wire-vis');
    const elJunction = document.createElementNS('http://www.w3.org/2000/svg','circle');
    elJunction.setAttribute('class','junction-dot');
    elJunction.setAttribute('r', '5');
    elJunction.style.display = 'none';
    wireLayer.appendChild(elVis);
    wireLayer.appendChild(elHit);
    wireLayer.appendChild(elJunction);
    wires.push({ id, from:fromId, to:toId, toIndex, fromIndex, elVis, elHit, elJunction });
    rebuildWireIndex();
  }

  canvasWrap.addEventListener('click', (e)=>{
    if(e.target === canvasWrap || e.target === canvasInner || e.target === zoomStage){
      cancelPendingWire();
      if(!e.shiftKey) {
        selectedNodeIds.clear();
        nodes.forEach(n => n.el.classList.remove('selected'));
      }
    }
  });

  let panState = null;
  canvasWrap.addEventListener('pointerdown', (e)=>{
    if (pendingWireFrom) return;
    if(e.target !== canvasWrap && e.target !== canvasInner && e.target !== zoomStage) return;
    if(e.button !== 0 && e.button !== 1) return;

    const cr = canvasInner.getBoundingClientRect();
    const cx = (e.clientX - cr.left) / zoom;
    const cy = (e.clientY - cr.top) / zoom;

    if (e.shiftKey && e.button === 0) {
      isSelecting = true;
      selectStart = { x: cx, y: cy };
      selectionBox.style.left = cx + 'px';
      selectionBox.style.top = cy + 'px';
      selectionBox.style.width = '0px';
      selectionBox.style.height = '0px';
      selectionBox.style.display = 'block';
      canvasWrap.setPointerCapture(e.pointerId);
    } else {
      panState = { x:e.clientX, y:e.clientY, sl:canvasWrap.scrollLeft, st:canvasWrap.scrollTop };
      canvasWrap.classList.add('panning');
      canvasWrap.setPointerCapture(e.pointerId);
    }
  });

  document.addEventListener('pointermove', (e)=>{
    if (!pendingWireFrom) return;
    const cr = canvasInner.getBoundingClientRect();
    mousePos.x = (e.clientX - cr.left) / zoom;
    mousePos.y = (e.clientY - cr.top) / zoom;

    const node = nodes.get(pendingWireFrom.nodeId);
    const pinEl = pendingWireFrom.kind === 'out'
      ? (node && (node.outPin || (node.outPins && node.outPins[pendingWireFrom.index])))
      : (node && node.inPins[pendingWireFrom.index]);

    if (pinEl) {
      const pinCoord = pinCenter(pinEl);
      const a = pendingWireFrom.kind === 'out' ? pinCoord : mousePos;
      const b = pendingWireFrom.kind === 'out' ? mousePos : pinCoord;
      previewPath.setAttribute('d', routeWirePath(a, b, new Set([pendingWireFrom.nodeId])));
      previewPath.style.display = 'block';
    }
  });

  canvasWrap.addEventListener('pointermove', (e)=>{
    const cr = canvasInner.getBoundingClientRect();
    mousePos.x = (e.clientX - cr.left) / zoom;
    mousePos.y = (e.clientY - cr.top) / zoom;
    
    if (pendingWireFrom) {
      const node = nodes.get(pendingWireFrom.nodeId);
      const pinEl = pendingWireFrom.kind === 'out' 
        ? (node.outPin || (node.outPins && node.outPins[pendingWireFrom.index])) 
        : node.inPins[pendingWireFrom.index];

      if (pinEl) {
        const pinCoord = pinCenter(pinEl);
        const a = pendingWireFrom.kind === 'out' ? pinCoord : mousePos;
        const b = pendingWireFrom.kind === 'out' ? mousePos : pinCoord;
        previewPath.setAttribute('d', routeWirePath(a, b, new Set([pendingWireFrom.nodeId])));
        previewPath.style.display = 'block';
      }
      return;
    }

    if (isSelecting) {
      const x1 = Math.min(selectStart.x, mousePos.x);
      const y1 = Math.min(selectStart.y, mousePos.y);
      const x2 = Math.max(selectStart.x, mousePos.x);
      const y2 = Math.max(selectStart.y, mousePos.y);

      selectionBox.style.left = x1 + 'px';
      selectionBox.style.top = y1 + 'px';
      selectionBox.style.width = (x2 - x1) + 'px';
      selectionBox.style.height = (y2 - y1) + 'px';
      return;
    }

    if(!panState) return;
    canvasWrap.scrollLeft = panState.sl - (e.clientX - panState.x);
    canvasWrap.scrollTop  = panState.st - (e.clientY - panState.y);
  });

  function endPanOrSelect(e){
    if (pendingWireFrom) {
      applyWireTarget(e.clientX, e.clientY);
    }

    if (isSelecting) {
      isSelecting = false;
      selectionBox.style.display = 'none';

      const x1 = Math.min(selectStart.x, mousePos.x);
      const y1 = Math.min(selectStart.y, mousePos.y);
      const x2 = Math.max(selectStart.x, mousePos.x);
      const y2 = Math.max(selectStart.y, mousePos.y);

      if (!e.shiftKey) {
        selectedNodeIds.clear();
      }

      nodes.forEach((node, id)=>{
        const nodeW = node.el.offsetWidth * nodeScale;
        const nodeH = node.el.offsetHeight * nodeScale;
        if (node.x < x2 && node.x + nodeW > x1 && node.y < y2 && node.y + nodeH > y1) {
          selectedNodeIds.add(id);
          node.el.classList.add('selected');
        } else if (!e.shiftKey) {
          node.el.classList.remove('selected');
        }
      });
    }

    if(!panState) return;
    panState = null;
    canvasWrap.classList.remove('panning');
  }

  canvasWrap.addEventListener('pointerup', endPanOrSelect);
  canvasWrap.addEventListener('pointercancel', endPanOrSelect);

  const BASE_W = 6000, BASE_H = 4000, ZOOM_MIN = 0.35, ZOOM_MAX = 2.2;
  let zoom = 1;
  const zoomLabel = document.getElementById('zoomLabel');

  function applyZoom(nextZoom, anchorX, anchorY){
    nextZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoom));
    const wrapRect = canvasWrap.getBoundingClientRect();
    const ax = anchorX - wrapRect.left, ay = anchorY - wrapRect.top;
    const baseX = (canvasWrap.scrollLeft + ax) / zoom;
    const baseY = (canvasWrap.scrollTop + ay) / zoom;
    zoom = nextZoom;
    zoomStage.style.width  = (BASE_W*zoom)+'px';
    zoomStage.style.height = (BASE_H*zoom)+'px';
    canvasInner.style.transform = `scale(${zoom})`;
    canvasWrap.scrollLeft = baseX*zoom - ax;
    canvasWrap.scrollTop  = baseY*zoom - ay;
    if(zoomLabel) zoomLabel.textContent = Math.round(zoom*100)+'%';
  }

  canvasWrap.addEventListener('wheel', (e)=>{
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    applyZoom(zoom*factor, e.clientX, e.clientY);
  }, { passive:false });

  document.getElementById('zoomReset')?.addEventListener('click', ()=>{
    const wrapRect = canvasWrap.getBoundingClientRect();
    applyZoom(1, wrapRect.left+wrapRect.width/2, wrapRect.top+wrapRect.height/2);
  });

  function attachDrag(node, handle){
    let sx=0, sy=0, dragging=false;
    let initialPositions = new Map();

    handle.addEventListener('pointerdown', (e)=>{
      e.stopPropagation();
      if (!selectedNodeIds.has(node.id)) {
        if (!e.shiftKey) {
          selectedNodeIds.clear();
          nodes.forEach(n => n.el.classList.remove('selected'));
        }
        selectedNodeIds.add(node.id);
        node.el.classList.add('selected');
      }

      dragging = true;
      sx = e.clientX; sy = e.clientY;
      initialPositions.clear();
      selectedNodeIds.forEach(id=>{
        const n = nodes.get(id);
        if(n){
          n.el.classList.add('dragging');
          initialPositions.set(id, { x: n.x, y: n.y });
        }
      });
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e)=>{
      if(!dragging) return;
      const dx = (e.clientX - sx)/zoom;
      const dy = (e.clientY - sy)/zoom;

      selectedNodeIds.forEach(id=>{
        const n = nodes.get(id);
        const init = initialPositions.get(id);
        if(n && init){
          const maxX = Math.max(0, BASE_W - n.el.offsetWidth * nodeScale);
          const maxY = Math.max(0, BASE_H - n.el.offsetHeight * nodeScale);
          n.x = Math.min(maxX, Math.max(0, init.x + dx));
          n.y = Math.min(maxY, Math.max(0, init.y + dy));
          n.el.style.left = n.x + 'px';
          n.el.style.top = n.y + 'px';
          routingRevision++;
        }
      });
    });

    function end(e){
      if(!dragging) return;
      dragging = false;
      selectedNodeIds.forEach(id=>{
        const n = nodes.get(id);
        if(n) n.el.classList.remove('dragging');
      });
      snapshot();
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  window.addEventListener('keydown', (e)=>{
    const inField = document.activeElement && document.activeElement.tagName === 'INPUT';
    if(inField) return;

    if(e.key === 'Escape' && pendingWireFrom){
      cancelPendingWire();
      return;
    }

    if(e.key === 'Delete' || e.key === 'Backspace'){
      if(selectedNodeIds.size > 0){
        const idsToDelete = Array.from(selectedNodeIds);
        idsToDelete.forEach(id => removeNode(id));
        selectedNodeIds.clear();
        toast('Deleted selected parts');
        snapshot();
      }
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if(!mod && e.key.toLowerCase() === 'r' && selectedNodeIds.size > 0){
      e.preventDefault();
      selectedNodeIds.forEach(id => {
        const node = nodes.get(id);
        if(node) rotateNode(node);
      });
      return;
    }
    if(!mod && e.key.toLowerCase() === 'k' && hoveredChipNode){
      e.preventDefault();
      openChipViewer(hoveredChipNode);
      return;
    }
    if(!mod) return;
    const key = e.key.toLowerCase();
    if(key === 'c'){ e.preventDefault(); copySelection(); }
    else if(key === 'v'){ e.preventDefault(); pasteClipboard(); }
    else if(key === 'z'){ e.preventDefault(); undo(); }
    else if(key === 'y'){ e.preventDefault(); redo(); }
  });

  let spawnCount = 0;
  document.querySelectorAll('.part').forEach(btn=>{
    setupPartButton(btn);
  });

  canvasWrap.addEventListener('dragover', (e)=>{
    e.preventDefault();
  });

  canvasWrap.addEventListener('drop', (e)=>{
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if(!type || INPUT_COUNT[type] === undefined) return;
    const cr = canvasInner.getBoundingClientRect();
    const x = (e.clientX - cr.left) / zoom - 50;
    const y = (e.clientY - cr.top) / zoom - 20;
    createNode(type, Math.max(0, x), Math.max(0, y));
    snapshot();
  });

  function pinCenter(pinEl){
    const pr = pinEl.getBoundingClientRect();
    const cr = canvasInner.getBoundingClientRect();
    return { 
      x: (pr.left + pr.width / 2 - cr.left) / zoom, 
      y: (pr.top + pr.height / 2 - cr.top) / zoom 
    };
  }

  function nodeRect(node){
    return {
      x: node.x, y: node.y,
      w: node.el.offsetWidth * nodeScale,
      h: node.el.offsetHeight * nodeScale
    };
  }

  // Liang-Barsky segment/rect intersection test, rect padded outward by `pad`.
  function segmentIntersectsRect(x1,y1,x2,y2, rect, pad){
    const rx1 = rect.x - pad, ry1 = rect.y - pad, rx2 = rect.x + rect.w + pad, ry2 = rect.y + rect.h + pad;
    let t0 = 0, t1 = 1;
    const dx = x2 - x1, dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1 - rx1, rx2 - x1, y1 - ry1, ry2 - y1];
    for(let i=0;i<4;i++){
      if(p[i] === 0){
        if(q[i] < 0) return false;
      } else {
        const r = q[i] / p[i];
        if(p[i] < 0){ if(r > t1) return false; if(r > t0) t0 = r; }
        else { if(r < t0) return false; if(r < t1) t1 = r; }
      }
    }
    return true;
  }

  function simplifyRoute(points){
    const result = [];
    points.forEach(point => {
      const last = result[result.length - 1];
      if(!last || last.x !== point.x || last.y !== point.y) result.push(point);
    });
    for(let i = result.length - 2; i > 0; i--) {
      const before = result[i - 1], point = result[i], after = result[i + 1];
      if((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y)) result.splice(i, 1);
    }
    return result;
  }

  function orthogonalPath(points){
    const route = simplifyRoute(points);
    let d = `M ${route[0].x} ${route[0].y}`;
    for(let i = 1; i < route.length; i++) {
      const previous = route[i - 1], point = route[i];
      if(i === route.length - 1) {
        d += ` L ${point.x} ${point.y}`;
        continue;
      }
      const next = route[i + 1];
      const previousLength = Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
      const nextLength = Math.abs(next.x - point.x) + Math.abs(next.y - point.y);
      const radius = Math.min(10, previousLength / 2, nextLength / 2);
      const before = {
        x: point.x + (previous.x - point.x) * radius / previousLength,
        y: point.y + (previous.y - point.y) * radius / previousLength
      };
      const after = {
        x: point.x + (next.x - point.x) * radius / nextLength,
        y: point.y + (next.y - point.y) * radius / nextLength
      };
      d += ` L ${before.x} ${before.y} Q ${point.x} ${point.y} ${after.x} ${after.y}`;
    }
    return d;
  }

  function routeScore(points, obstacles, pad){
    let length = 0;
    let collisions = 0;
    for(let i = 1; i < points.length; i++) {
      const previous = points[i - 1], point = points[i];
      length += Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
      obstacles.forEach(rect => {
        if(segmentIntersectsRect(previous.x, previous.y, point.x, point.y, rect, pad)) collisions++;
      });
    }
    return collisions * 1000000 + length + (points.length - 2) * 12;
  }

  // Draw traces as clean, right-angled runs. Candidate routes are scored against
  // every other component, then the shortest clear route is selected.
  function routeWirePath(a, b, excludeIds){
    const pad = 18;
    const obstacles = [];
    nodes.forEach((n, id) => {
      if(excludeIds.has(id)) return;
      obstacles.push(nodeRect(n));
    });

    // Outputs are on the right and inputs are on the left, so these short leads
    // make each connection read naturally even when it loops back to the left.
    const lead = 30;
    const start = { x: a.x + lead, y: a.y };
    const end = { x: b.x - lead, y: b.y };
    const candidates = [];
    const addCandidate = points => candidates.push(simplifyRoute(points));

    const centerX = (start.x + end.x) / 2;
    addCandidate([a, start, { x:centerX, y:a.y }, { x:centerX, y:b.y }, end, b]);

    // Detour lanes come from the edges of components close to this connection.
    const minX = Math.min(a.x, b.x) - lead * 2;
    const maxX = Math.max(a.x, b.x) + lead * 2;
    const lanes = new Set([Math.min(a.y, b.y) - 54, Math.max(a.y, b.y) + 54]);
    // Guaranteed escape lanes keep a route available when several components
    // stack up in the same local corridor.
    if(obstacles.length) {
      lanes.add(Math.min(a.y, b.y, ...obstacles.map(rect => rect.y - pad)) - 28);
      lanes.add(Math.max(a.y, b.y, ...obstacles.map(rect => rect.y + rect.h + pad)) + 28);
    }
    const middleY = (a.y + b.y) / 2;
    const nearbyObstacles = obstacles
      .filter(rect => rect.x <= maxX && rect.x + rect.w >= minX && rect.y <= Math.max(a.y, b.y) + 80 && rect.y + rect.h >= Math.min(a.y, b.y) - 80)
      .sort((left, right) => Math.abs((left.y + left.h / 2) - middleY) - Math.abs((right.y + right.h / 2) - middleY))
      .slice(0, 8);
    nearbyObstacles.forEach(rect => {
      lanes.add(rect.y - pad - 2);
      lanes.add(rect.y + rect.h + pad + 2);
    });
    lanes.forEach(y => addCandidate([a, start, { x:start.x, y }, { x:end.x, y }, end, b]));

    // A back-edge needs to travel around the circuit rather than fold through it.
    if(start.x > end.x) {
      const farRight = Math.max(start.x, ...obstacles.map(rect => rect.x + rect.w + pad)) + 36;
      const farLeft = Math.min(end.x, ...obstacles.map(rect => rect.x - pad)) - 36;
      addCandidate([a, start, { x:farRight, y:a.y }, { x:farRight, y:b.y }, end, b]);
      addCandidate([a, start, { x:farLeft, y:a.y }, { x:farLeft, y:b.y }, end, b]);
    }

    let best = candidates[0];
    let bestScore = routeScore(best, obstacles, pad);
    for(let i = 1; i < candidates.length; i++) {
      const score = routeScore(candidates[i], obstacles, pad);
      if(score < bestScore) {
        best = candidates[i];
        bestScore = score;
      }
    }
    return orthogonalPath(best);
  }

  function evaluateChip(node, inputs){
    const definition = customChips.get(node.type);
    if(!definition) return [];
    if(!definition.evalOrder) {
      const byId = new Map(definition.nodes.map(inner => [inner.id, inner]));
      const indegree = new Map(definition.nodes.map(inner => [inner.id, 0]));
      const dependents = new Map(definition.nodes.map(inner => [inner.id, []]));
      definition.wires.forEach(wire => {
        if(byId.has(wire.from) && byId.has(wire.to)) {
          indegree.set(wire.to, indegree.get(wire.to) + 1);
          dependents.get(wire.from).push(wire.to);
        }
      });
      const ready = definition.nodes.filter(inner => indegree.get(inner.id) === 0).map(inner => inner.id);
      const order = [];
      while(ready.length) {
        const id = ready.shift();
        order.push(byId.get(id));
        dependents.get(id).forEach(nextId => {
          indegree.set(nextId, indegree.get(nextId) - 1);
          if(indegree.get(nextId) === 0) ready.push(nextId);
        });
      }
      definition.nodes.forEach(inner => { if(!order.includes(inner)) order.push(inner); });
      definition.evalOrder = order;
    }
    const values = new Map();
    definition.nodes.forEach(inner => {
      if(inner.type === 'INPUT') {
        values.set(inner.id, !!inputs[definition.inputs.indexOf(inner.id)]);
      } else if(isDipSwitchType(inner.type)) {
        const switches = inner.switches || new Array(6).fill(false);
        for(let i = 0; i < 6; i++) {
          const inputIdx = definition.inputs.indexOf(`${inner.id}:${i}`);
          values.set(`${inner.id}:${i}`, inputIdx === -1 ? !!switches[i] : !!inputs[inputIdx]);
        }
      } else {
        values.set(inner.id, !!inner.value);
      }
    });
    const sourceValue = wire => {
      if(!wire) return false;
      const indexedValue = values.get(`${wire.from}:${wire.fromIndex || 0}`);
      return indexedValue !== undefined ? !!indexedValue : !!values.get(wire.from);
    };
    definition.evalOrder.forEach(inner => {
        if(inner.type === 'INPUT' || inner.type === 'OUTPUT') return;
        const vals = [];
        for(let i = 0; i < (INPUT_COUNT[inner.type] || 0); i++) {
          vals.push(sourceValue(definition.wires.find(w => w.to === inner.id && w.toIndex === i)));
        }
        let out = false;
        if(inner.type === 'AND') out = vals[0] && vals[1];
        else if(inner.type === 'OR') out = vals[0] || vals[1];
        else if(inner.type === 'OR3' || inner.type === 'OR3IN') out = vals[0] || vals[1] || vals[2];
        else if(inner.type === 'OR2OUT') {
          const combined = vals[0] || vals[1];
          values.set(`${inner.id}:0`, combined);
          values.set(`${inner.id}:1`, combined);
          out = combined;
        }
        else if(inner.type === 'NAND') out = !(vals[0] && vals[1]);
        else if(inner.type === 'NOR') out = !(vals[0] || vals[1]);
        else if(inner.type === 'XOR') out = !!vals[0] !== !!vals[1];
        else if(inner.type === 'XNOR') out = !!vals[0] === !!vals[1];
        else if(inner.type === 'NOT') out = !vals[0];
        else if(inner.type === 'MEMORY') out = vals[1] ? false : (vals[0] || !!inner.value);
        else if(inner.type === 'DELAY') out = vals[0];
        else if(inner.type === 'CALCULATOR') out = Number(vals[0]) + Number(vals[1]);
        else if(inner.type === 'GREATER') out = Number(vals[0]) > Number(vals[1]);
        else if(inner.type === 'XAND') out = !vals[0] && !vals[1] ? 10 : vals[0] && vals[1];
        else if(isCustomChip(inner.type)) {
          const chipOutputs = evaluateChip(inner, vals);
          chipOutputs.forEach((value, index) => values.set(`${inner.id}:${index}`, value));
          out = chipOutputs[0] || false;
        }
        values.set(inner.id, out);
    });
    return definition.outputs.map(outputId => sourceValue(definition.wires.find(w => w.to === outputId && w.toIndex === 0)));
  }

  function updateCustomChip(node){
    const previousOutputs = node.outValues ? [...node.outValues] : [];
    const inputs = [];
    for(let i = 0; i < node.nInputs; i++) {
      const wire = getInputWire(node.id, i);
      const source = wire ? nodes.get(wire.from) : null;
      if(!source) {
        inputs.push(false);
      } else if(source.type === 'JOYSTICK' && source.outValues) {
        inputs.push(!!source.outValues[wire.fromIndex || 0]);
      } else if((isCustomChip(source.type) || isDipSwitchType(source.type)) && source.outValues) {
        inputs.push(!!source.outValues[wire.fromIndex || 0]);
      } else {
        inputs.push(!!source.value);
      }
    }
    node.outValues = evaluateChip(node, inputs);
    node.value = !!node.outValues[0];
    return previousOutputs.length !== node.outValues.length || node.outValues.some((value, index) => value !== previousOutputs[index]);
  }

  function simulate(){
    nodes.forEach(node=>{
      if(node.type === 'INPUT' || node.type === 'BUTTON') return;
      if(node.type === 'CLOCK'){
        node.value = Math.floor((simulationTime-node.startTime)/node.period) % 2 === 0;
        return;
      }

      if(node.type === 'OSCLOCK'){
        const stopWire = getInputWire(node.id, 0);
        const stopNode = stopWire ? nodes.get(stopWire.from) : null;
        if (stopNode && stopNode.value) {
          node.value = false;
          node.osAlarmTriggered = true;
          node.osAlarmStopped = true;
          return;
        }
        if (node.osTargetTime && !node.osAlarmTriggered && Date.now() >= node.osTargetTime) {
          node.osAlarmTriggered = true;
        }
        node.value = node.osAlarmTriggered && !node.osAlarmStopped && Math.floor(Date.now() / 500) % 2 === 0;
        return;
      }
 
      if(node.type === 'JOYSTICK'){
        const normX = (node.knobX || 0) / 20;
        const normY = (node.knobY || 0) / 20;
        
        let up = false, down = false, left = false, right = false;
        if (Math.abs(normX) > 0.08 || Math.abs(normY) > 0.08) {
          if (Math.abs(normY) > Math.abs(normX)) {
            if (normY < 0) up = true;
            else down = true;
          } else {
            if (normX < 0) left = true;
            else right = true;
          }
        }

        node.outValues = { up, down, left, right };
        node.value = up || down || left || right;
        return;
      }

      if(isDipSwitchType(node.type)) {
        node.switches = node.switches || new Array(6).fill(false);
        node.outValues = node.switches.map(Boolean);
        node.value = !!node.switches[0];
        return;
      }

      if(isCustomChip(node.type)) {
        updateCustomChip(node);
        return;
      }

      const vals = [];
      for(let i=0;i<node.nInputs;i++){
        const w = getInputWire(node.id, i);
        let v = (node.type === 'CALCULATOR' && node.calcInputs) ? (node.calcInputs[i] || 0) : false;
        if(w){
          const src = nodes.get(w.from);
          if(src && src.type === 'JOYSTICK' && src.outValues){
            const keys = ['up', 'down', 'left', 'right'];
            v = !!src.outValues[keys[w.fromIndex || 0]];
          } else if(src && src.outValues && (isCustomChip(src.type) || isDipSwitchType(src.type))) {
            v = !!src.outValues[w.fromIndex || 0];
          } else {
            v = src ? (src.value || false) : false;
          }
        }
        vals.push(v);
      }

      let out;
      switch(node.type){
        case 'AND':  out = vals[0] && vals[1]; break;
        case 'OR':   out = vals[0] || vals[1]; break;
        case 'OR3':
        case 'OR3IN': out = vals[0] || vals[1] || vals[2]; break;
        case 'OR2OUT': {
          out = vals[0] || vals[1];
          node.outValues = [out, out];
          break;
        }
        case 'NAND': out = !(vals[0] && vals[1]); break;
        case 'NOR':  out = !(vals[0] || vals[1]); break;
        case 'XOR':  out = !!vals[0] !== !!vals[1]; break;
        case 'XNOR': out = !!vals[0] === !!vals[1]; break;
        case 'NOT':  out = !vals[0]; break;
        case 'MEMORY': out = vals[1] ? false : (vals[0] ? true : node.value); break;
        case 'OUTPUT': out = vals[0]; break;
        case 'SPEAKER':
          out = !!vals[0];
          playTone(node, out);
          break;
        case 'LCD':  out = (vals[0]?8:0) + (vals[1]?4:0) + (vals[2]?2:0) + (vals[3]?1:0); break;
        case 'DELAY':
          if (!node.buffer || node.buffer.length !== (node.delayTicks || 1)) {
            const ticks = node.delayTicks || 1;
            node.buffer = new Array(ticks).fill(false);
          }
          node.buffer.push(vals[0]);
          out = node.buffer.shift();
          break;
        case 'CALCULATOR': {
          const v0 = Number(vals[0]) || 0;
          const v1 = Number(vals[1]) || 0;
          const op = node.operation || '+';
          if(op === '+') out = v0 + v1;
          else if(op === '-') out = v0 - v1;
          else if(op === '*') out = v0 * v1;
          else if(op === '/') out = v1 !== 0 ? v0 / v1 : 0;
          else if(op === '^') out = Math.pow(v0, v1);
          if(typeof out === 'number' && isFinite(out)) out = Math.round(out * 1e6) / 1e6;
          break;
        }
        case 'GREATER':
          out = (Number(vals[0]) > Number(vals[1])) ? vals[0] : 0;
          break;
        case 'XAND':
          out = (Number(vals[0]) === 0 && Number(vals[1]) === 0) ? 10.0 : (vals[0] && vals[1]);
          break;
        case 'SEVEN':
        case 'FOURTEEN': {
          out = [];
          for(let i=0; i<node.nInputs; i++){
            out.push(!!vals[i]);
          }
          break;
        }
        default: out = false;
      }
      node.value = out;
    });

    nodes.forEach(node=>{
      if(node.outPin) node.outPin.classList.toggle('hot', !!node.value);
      if(node.outPins && node.outPins.length > 0) {
        node.outPins.forEach((p, idx) => {
          let val = false;
          if(isDipSwitchType(node.type)) {
            val = !!(node.outValues && node.outValues[idx]);
          } else if(node.type === chipKey('Switch Assembly')) {
            val = !!(node.outValues && node.outValues[idx]);
          } else if (isCustomChip(node.type)) {
            val = !!(node.outValues && node.outValues[idx]);
          } else if (node.type === 'OR2OUT') {
            val = !!(node.outValues && node.outValues[idx]);
          } else {
            const keys = ['up', 'down', 'left', 'right'];
            val = node.outValues ? !!node.outValues[keys[idx]] : false;
          }
          p.classList.toggle('hot', !!val);
        });
      }
      if(node.led) node.led.classList.toggle('on', !!node.value);
      if(node.type === 'CALCULATOR' && node.calcReadout){
        node.calcReadout.textContent = Number.isFinite(node.value) ? String(node.value) : '0';
        if(node.calcInputEls){
          node.calcInputEls.forEach((inputEl, i) => {
            const wired = !!getInputWire(node.id, i);
            inputEl.disabled = wired;
            if(!wired && document.activeElement !== inputEl){
              inputEl.value = node.calcInputs[i];
            }
          });
        }
      }
      if(node.lcdDisplay && node.type !== 'OSCLOCK') {
        
        if(node.type === 'SEVEN' && Array.isArray(node.value)) {
          const segs = node.lcdDisplay.querySelectorAll('.seg');
          segs.forEach((seg, idx)=>{
            seg.classList.toggle('lit', node.value[idx]);
          });
        } else if(node.type === 'FOURTEEN' && Array.isArray(node.value)) {
          const segs = node.lcdDisplay.querySelectorAll('.fseg');
          segs.forEach((seg, idx)=>{
            seg.classList.toggle('lit', node.value[idx]);
          });
        } else {
          node.lcdDisplay.textContent = String(node.value).padStart(2,'0');
        }
      }
      if(node.type==='INPUT' || node.type==='BUTTON'){
        const toggle = node.el.querySelector('.toggle');
        if(toggle) toggle.classList.toggle('on', node.value);
      }
      node.inPins.forEach((p,i)=>{
        const w = getInputWire(node.id, i);
        let v = false;
        if (w) {
          const src = nodes.get(w.from);
          if (src && src.type === 'JOYSTICK' && src.outValues) {
            const keys = ['up', 'down', 'left', 'right'];
            v = !!src.outValues[keys[w.fromIndex || 0]];
          } else if (src && src.outValues && (isCustomChip(src.type) || isDipSwitchType(src.type))) {
            v = !!src.outValues[w.fromIndex || 0];
          } else {
            v = src ? (src.value || false) : false;
          }
        }
        p.classList.toggle('hot', v);
      });
    });
    const customNodes = Array.from(nodes.values()).filter(node => isCustomChip(node.type));
    for(let pass = 0; pass < customNodes.length; pass++) {
      let changed = false;
      customNodes.forEach(node => { if(updateCustomChip(node)) changed = true; });
      if(!changed) break;
    }
  }

  function renderWires(){
    const branchCounts = new Map();
    const renderedJunctions = new Set();
    const newConnected = new Set();
    wires.forEach(w => {
      const key = `${w.from}:${w.fromIndex || 0}`;
      branchCounts.set(key, (branchCounts.get(key) || 0) + 1);
    });
    wires.forEach(w => {
      const from = nodes.get(w.from), to = nodes.get(w.to);
      if(!from || !to) return;
      const fromIndex = Number.isInteger(Number(w.fromIndex)) ? Number(w.fromIndex) : 0;
      
      let fromPin = from.outPin;
      if(!fromPin && from.outPins) {
        fromPin = from.outPins[fromIndex];
      }
      if(!fromPin && from.outPins && from.outPins.length > 0) {
        fromPin = from.outPins[0];
      }
      const toPin = to.inPins[w.toIndex];
      if(!fromPin || !toPin) return;
      newConnected.add(fromPin);
      newConnected.add(toPin);

      const a = pinCenter(fromPin);
      const b = pinCenter(toPin);
      const routeKey = `${routingRevision}:${a.x.toFixed(1)}:${a.y.toFixed(1)}:${b.x.toFixed(1)}:${b.y.toFixed(1)}`;
      if(w.routeKey !== routeKey) {
        w.routeKey = routeKey;
        w.routeD = routeWirePath(a, b, new Set([w.from, w.to]));
      }
      const d = w.routeD;
      w.elVis.setAttribute('d', d);
      w.elHit.setAttribute('d', d);
      const branchKey = `${w.from}:${w.fromIndex || 0}`;
      const isBranch = branchCounts.get(branchKey) > 1 && !renderedJunctions.has(branchKey);
      renderedJunctions.add(branchKey);
      w.elJunction.style.display = isBranch ? '' : 'none';
      if(isBranch) {
        w.elJunction.setAttribute('cx', a.x);
        w.elJunction.setAttribute('cy', a.y);
      }
      
      let isHot = !!from.value;
      if(from.type === 'JOYSTICK' && from.outValues) {
        const keys = ['up', 'down', 'left', 'right'];
        isHot = !!from.outValues[keys[fromIndex]];
      } else if((isCustomChip(from.type) || isDipSwitchType(from.type) || from.type === 'OR2OUT') && from.outValues) {
        isHot = !!from.outValues[fromIndex];
      }
      w.elVis.classList.toggle('hot', isHot);
      w.elJunction.classList.toggle('hot', isHot);
    });

    connectedPins.forEach(pin => { if(!newConnected.has(pin)) pin.classList.remove('connected'); });
    newConnected.forEach(pin => pin.classList.add('connected'));
    connectedPins = newConnected;
  }

  function loop(){
    const now = performance.now();
    if(!isSimulationPaused) simulationTime += (now - lastSimulationFrame) * simulationSpeed;
    lastSimulationFrame = now;
    if(!isSimulationPaused) simulate();
    renderWires();
    requestAnimationFrame(loop);
  }
  loop();

  function clearBoard(){
    wires.forEach(disposeWire);
    wires = [];
    inputWires.clear();
    nodes.forEach(n=>{
      if(n.type === 'SPEAKER') stopSpeakerAudio(n);
      n.el.remove();
    });
    nodes.clear();
    routingRevision++;
    selectedNodeIds.clear();
    pendingWireFrom = null;
    hoveredChipNode = null;
    spawnCount = 0;
  }
  document.getElementById('clearAll').addEventListener('click', ()=>{ clearBoard(); snapshot(); toast('Board cleared'); });

  document.getElementById('reportBug')?.addEventListener('click', openBugReportDialog);

  function openBugReportDialog(){
    const diagnostics = [
      `Time: ${new Date().toISOString()}`,
      `Nodes on board: ${nodes.size}`,
      `Wires on board: ${wires.length}`,
      `Viewport: ${window.innerWidth}×${window.innerHeight}`,
      `User agent: ${navigator.userAgent}`
    ].join('\n');

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="bugreport-dialog" role="dialog" aria-modal="true" aria-labelledby="bugreportTitle">
        <div class="confirm-kicker">REPORT BUG</div>
        <h3 id="bugreportTitle">What went wrong?</h3>
        <label>Description
          <textarea id="bugreportDesc" placeholder="What did you expect to happen, and what happened instead? Steps to reproduce help a lot."></textarea>
        </label>
        <label class="bugreport-checkline" style="flex-direction:row;">
          <input type="checkbox" id="bugreportIncludeBoard" checked />
          Include current board layout (helps reproduce it)
        </label>
        <div class="bugreport-diagnostics" id="bugreportDiagnostics"></div>
        <div class="bugreport-actions">
          <button type="button" class="bugreport-cancel">Cancel</button>
          <button type="button" class="bugreport-download">Download .txt</button>
          <button type="button" class="bugreport-submit">Copy report</button>
          <button type="button" class="bugreport-github">Open on GitHub</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const GITHUB_ISSUE_URL = 'https://github.com/Twrilz/Logic-Sandbox/issues/new';

    const descEl = overlay.querySelector('#bugreportDesc');
    const includeBoardEl = overlay.querySelector('#bugreportIncludeBoard');
    const diagEl = overlay.querySelector('#bugreportDiagnostics');
    const submitBtn = overlay.querySelector('.bugreport-submit');
    diagEl.textContent = diagnostics;
    descEl.focus();

    function buildReport(){
      const desc = descEl.value.trim();
      const parts = [
        `Bug report`,
        `Description: ${desc || '(none provided)'}`,
        diagnostics
      ];
      if(includeBoardEl.checked){
        try {
          parts.push(`Board JSON:\n${JSON.stringify(serializeBoard())}`);
        } catch(e) {
          parts.push(`Board JSON: (failed to serialize — ${e.message})`);
        }
      }
      return parts.join('\n\n');
    }

    const close = () => overlay.remove();
    overlay.querySelector('.bugreport-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if(e.target === overlay) close(); });
    overlay.addEventListener('keydown', e => { if(e.key === 'Escape') close(); });

    overlay.querySelector('.bugreport-download').addEventListener('click', () => {
      const report = buildReport();
      const blob = new Blob([report], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `logic-sandbox-bug-report-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Bug report downloaded');
    });

    submitBtn.addEventListener('click', () => {
      const report = buildReport();
      if(navigator.clipboard && navigator.clipboard.writeText){
        submitBtn.disabled = true;
        navigator.clipboard.writeText(report).then(
          () => { toast('Bug report copied to clipboard'); close(); },
          () => { console.log(report); toast('Could not copy — logged to console instead'); submitBtn.disabled = false; }
        );
      } else {
        console.log(report);
        toast('Bug report logged to console');
        close();
      }
    });

    overlay.querySelector('.bugreport-github').addEventListener('click', () => {
      const desc = descEl.value.trim();
      if(!desc){
        toast('Add a description before opening on GitHub');
        descEl.focus();
        return;
      }
      const title = desc.split('\n')[0].slice(0, 80);

      function buildGithubBody(includeBoard){
        const lines = [
          desc,
          '',
          '**Diagnostics**',
          '```',
          diagnostics,
          '```'
        ];
        if(includeBoard){
          try {
            lines.push('', '**Board JSON**', '```json', JSON.stringify(serializeBoard()), '```');
          } catch(e) {
            lines.push('', `_Board JSON failed to serialize: ${e.message}_`);
          }
        }
        return lines.join('\n');
      }

      let body = buildGithubBody(includeBoardEl.checked);
      let url = `${GITHUB_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;

      // Browsers and GitHub start truncating very long URLs — drop the board JSON and
      // point the person at the downloaded report instead if it doesn't fit.
      if(url.length > 8000 && includeBoardEl.checked){
        body = buildGithubBody(false);
        url = `${GITHUB_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
        toast('Board layout too large to include — download it separately and attach it');
      }

      window.open(url, '_blank', 'noopener');
    });
  }

  function serializeBoard(){
    return {
      version: 1,
      customChips: Object.fromEntries(customChips),
      nodes: Array.from(nodes.values()).map(n=>({
        id: n.id, type: n.type, x: n.x, y: n.y,
        rotation: n.rotation || 0,
        value: n.type === 'INPUT' ? !!n.value : undefined,
        switches: isDipSwitchType(n.type) ? (n.switches || new Array(6).fill(false)) : undefined,
        period: n.type === 'CLOCK' ? n.period : undefined,
        delayTicks: n.type === 'DELAY' ? n.delayTicks : undefined,
        speakerSettings: n.type === 'SPEAKER' ? getSpeakerSettings(n) : undefined,
        osTargetTime: n.type === 'OSCLOCK' ? n.osTargetTime : undefined,
                osAlarmTriggered: n.type === 'OSCLOCK' ? n.osAlarmTriggered : undefined,
        osAlarmStopped: n.type === 'OSCLOCK' ? n.osAlarmStopped : undefined,
        operation: n.type === 'CALCULATOR' ? n.operation : undefined,
        calcInputs: n.type === 'CALCULATOR' ? n.calcInputs : undefined,
        labelText: n.type === 'LABEL' ? n.labelText : undefined
      })),
      wires: wires.map(w=>({ from: w.from, to: w.to, toIndex: w.toIndex, fromIndex: w.fromIndex }))
    };
  }

  function saveBoard(){
    const blob = new Blob([JSON.stringify(serializeBoard(), null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'breadboard-circuit.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Board saved');
  }

  function encodeShareData(data){
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    let binary = '';
    const chunkSize = 8192;
    for(let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeShareData(encoded){
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((encoded.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function shareableBoardData(){
    const board = serializeBoard();
    const neededChipTypes = new Set(board.nodes.filter(node => isCustomChip(node.type)).map(node => node.type));
    const includedChips = {};
    // A saved chip can itself contain another custom chip, so include only the
    // dependency chain needed to open this particular board.
    for(const type of neededChipTypes) {
      const definition = customChips.get(type);
      if(!definition || includedChips[type]) continue;
      const cleanDefinition = JSON.parse(JSON.stringify(definition, (key, value) => key === 'evalOrder' ? undefined : value));
      includedChips[type] = cleanDefinition;
      (cleanDefinition.nodes || []).forEach(node => {
        if(isCustomChip(node.type)) neededChipTypes.add(node.type);
      });
    }
    board.customChips = includedChips;
    return board;
  }

  function shareBoard(){
    let link;
    try {
      const payload = encodeShareData(shareableBoardData());
      link = `${location.href.split('#')[0]}#board=${payload}`;
    } catch(err) {
      toast('Could not create a share link');
      return;
    }
    if(link.length > 12000) {
      toast('This board is too large for a reliable share link — use Save instead');
      return;
    }
    const copied = () => toast('Share link copied');
    if(navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(link).then(copied, () => window.prompt('Copy this share link:', link));
    } else {
      window.prompt('Copy this share link:', link);
    }
  }

  function saveAsChip(){
    const inputNodes = Array.from(nodes.values())
      .filter(node => node.type === 'INPUT' || isDipSwitchType(node.type))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const outputs = Array.from(nodes.values()).filter(node => node.type === 'OUTPUT').sort((a, b) => a.y - b.y || a.x - b.x);
    if(inputNodes.length === 0 || outputs.length === 0) {
      toast('Add at least one switch and lamp first');
      return;
    }
    const name = window.prompt('Name this chip:', 'Custom Chip');
    if(!name || !name.trim()) return;
    const definition = serializeBoard();
    definition.name = name.trim();
    definition.inputs = inputNodes.flatMap(node =>
      node.type === 'INPUT' ? [node.id] : Array.from({ length: 6 }, (_, i) => `${node.id}:${i}`)
    );
    definition.outputs = outputs.map(node => node.id);
    const result = registerChip(definition);
    snapshot();
    toast(result.persisted ? `Saved chip: ${definition.name}` : `Chip ready: ${definition.name} (session only)`);
  }

  function rebuildFromData(data, opts){
    const clear = !opts || opts.clear !== false;
    if(clear) clearBoard();
    if(data.customChips) {
      Object.values(data.customChips).forEach(definition => registerChip(definition));
    }
    const idMap = new Map();
    data.nodes.forEach(saved=>{
      if(INPUT_COUNT[saved.type] === undefined) return;
      const n = createNode(saved.type, saved.x||0, saved.y||0);
      n.rotation = saved.rotation || 0;
      n.el.style.transform = `scale(${nodeScale}) rotate(${n.rotation}deg)`;
      idMap.set(saved.id, n.id);
      if(saved.type === 'INPUT' && saved.value){
        n.value = true;
        const toggle = n.el.querySelector('.toggle');
        if(toggle) toggle.classList.add('on');
      }
      if(isDipSwitchType(saved.type) && Array.isArray(saved.switches)) {
        n.switches = saved.switches.slice(0, 6).concat(new Array(Math.max(0, 6 - saved.switches.length)).fill(false));
        const toggles = n.el.querySelectorAll('.dip-toggle');
        toggles.forEach((toggle, idx) => {
          const slider = toggle.querySelector('div');
          if(slider) slider.style.left = n.switches[idx] ? '17px' : '1px';
          toggle.style.background = n.switches[idx] ? '#d2d1ce' : '#b8b7b3';
        });
      }
      if(saved.type === 'CLOCK' && saved.period){
        n.period = saved.period;
        n.startTime = simulationTime;
        const selectEl = n.el.querySelector('.clock-select');
        if(selectEl) selectEl.value = saved.period;
      }
      if(saved.type === 'DELAY' && saved.delayTicks){
        n.delayTicks = saved.delayTicks;
        n.buffer = new Array(n.delayTicks).fill(false);
        const selectEl = n.el.querySelector('.delay-select');
        if(selectEl) selectEl.value = saved.delayTicks;
      }
      if(saved.type === 'SPEAKER' && saved.speakerSettings) {
        n.speakerSettings = { ...DEFAULT_SPEAKER_SETTINGS, ...saved.speakerSettings };
        const frequencyInput = n.el.querySelector('.speaker-frequency');
        const volumeInput = n.el.querySelector('.speaker-volume');
        const waveformSelect = n.el.querySelector('.speaker-waveform');
        if(frequencyInput) frequencyInput.value = String(getSpeakerSettings(n).frequency);
        if(volumeInput) volumeInput.value = String(getSpeakerSettings(n).volume);
        if(waveformSelect) waveformSelect.value = getSpeakerSettings(n).waveform;
      }
      if(saved.type === 'OSCLOCK' && saved.osTargetTime){
        n.osTargetTime = saved.osTargetTime;
        n.osAlarmTriggered = !!saved.osAlarmTriggered;
        n.osAlarmStopped = !!saved.osAlarmStopped;
        const alarmInput = n.el.querySelector('.osclock-input');
        if(alarmInput) {
          const date = new Date(saved.osTargetTime);
          const pad = value => String(value).padStart(2, '0');
          alarmInput.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
        }
        n.value = n.osAlarmTriggered;
      }
            if(saved.type === 'CALCULATOR'){
        n.operation = saved.operation || '+';
        n.calcInputs = Array.isArray(saved.calcInputs) ? [Number(saved.calcInputs[0]) || 0, Number(saved.calcInputs[1]) || 0] : [0, 0];
        const opEl = n.el.querySelector('.calc-op-btn');
        if(opEl) opEl.textContent = n.operation;
        if(n.calcInputEls){
          n.calcInputEls[0].value = n.calcInputs[0];
          n.calcInputEls[1].value = n.calcInputs[1];
        }
      }
      if(saved.type === 'LABEL'){
        n.labelText = saved.labelText || '';
        const area = n.el.querySelector('.node-label-area');
        if(area) area.value = n.labelText;
      }
    });
    data.wires.forEach(w=>{
      const fromId = idMap.get(w.from);
      const toId = idMap.get(w.to);
      if(fromId && toId) createWire(fromId, toId, w.toIndex, w.fromIndex || 0);
    });
    return idMap;
  }

  function loadBoardFromData(data){
    if(!data || !Array.isArray(data.nodes) || !Array.isArray(data.wires)){
      toast('Invalid board file');
      return;
    }
    rebuildFromData(data);
    snapshot();
    toast('Board loaded');
  }

  let history = [];
  let historyIndex = -1;
  const HISTORY_LIMIT = 60;

  function snapshot(){
    const state = JSON.stringify(serializeBoard());
    history = history.slice(0, historyIndex+1);
    history.push(state);
    if(history.length > HISTORY_LIMIT) history.shift();
    historyIndex = history.length - 1;
    scheduleAutosave(state);
  }

  function scheduleAutosave(state = JSON.stringify(serializeBoard())){
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      try { localStorage.setItem(BOARD_AUTOSAVE_STORAGE_KEY, state); }
      catch(err) { /* Private browsing or a full storage quota: the editor still works. */ }
    }, 250);
  }

  window.addEventListener('pagehide', () => {
    try { localStorage.setItem(BOARD_AUTOSAVE_STORAGE_KEY, JSON.stringify(serializeBoard())); }
    catch(err) { /* Storage is optional; manual Save remains available. */ }
  });

  function restoreAutosavedBoard(){
    try {
      const saved = localStorage.getItem(BOARD_AUTOSAVE_STORAGE_KEY);
      if(!saved) return false;
      const data = JSON.parse(saved);
      if(!Array.isArray(data.nodes) || !Array.isArray(data.wires)) return false;
      rebuildFromData(data);
      history = [JSON.stringify(serializeBoard())];
      historyIndex = 0;
      toast('Restored autosaved board');
      return true;
    } catch(err) {
      return false;
    }
  }

  function restoreSharedBoardFromHash(){
    try {
      const encoded = new URLSearchParams(location.hash.slice(1)).get('board');
      if(!encoded) return false;
      const data = decodeShareData(encoded);
      if(!Array.isArray(data.nodes) || !Array.isArray(data.wires)) return false;
      rebuildFromData(data);
      history = [JSON.stringify(serializeBoard())];
      historyIndex = 0;
      scheduleAutosave(history[0]);
      toast('Shared board loaded');
      return true;
    } catch(err) {
      toast('This share link is invalid or incomplete');
      return false;
    }
  }

  function restoreSnapshot(json){
    try { rebuildFromData(JSON.parse(json)); } catch(err) { /* corrupt entry */ }
  }

  function undo(){
    if(historyIndex <= 0){ toast('Nothing to undo'); return; }
    historyIndex--;
    restoreSnapshot(history[historyIndex]);
    toast('Undo');
  }

  function redo(){
    if(historyIndex >= history.length - 1){ toast('Nothing to redo'); return; }
    historyIndex++;
    restoreSnapshot(history[historyIndex]);
    toast('Redo');
  }

  let clipboard = null;
  let pasteOffset = 40;

  function copySelection(){
    if(selectedNodeIds.size === 0){ toast('Nothing selected to copy'); return; }
    const ids = Array.from(selectedNodeIds);
    clipboard = {
      nodes: ids.map(id=>{
        const n = nodes.get(id);
        return { id:n.id, type:n.type, x:n.x, y:n.y, rotation:n.rotation || 0,
          value: n.type === 'INPUT' ? !!n.value : undefined,
          period: n.type === 'CLOCK' ? n.period : undefined,
          delayTicks: n.type === 'DELAY' ? n.delayTicks : undefined,
          speakerSettings: n.type === 'SPEAKER' ? { ...getSpeakerSettings(n) } : undefined,
          osTargetTime: n.type === 'OSCLOCK' ? n.osTargetTime : undefined,
                    osAlarmTriggered: n.type === 'OSCLOCK' ? n.osAlarmTriggered : undefined,
          osAlarmStopped: n.type === 'OSCLOCK' ? n.osAlarmStopped : undefined,
          operation: n.type === 'CALCULATOR' ? n.operation : undefined,
          calcInputs: n.type === 'CALCULATOR' ? n.calcInputs : undefined,
          labelText: n.type === 'LABEL' ? n.labelText : undefined };
      }),
      wires: wires.filter(w=>selectedNodeIds.has(w.from) && selectedNodeIds.has(w.to))
                  .map(w=>({ from:w.from, to:w.to, toIndex:w.toIndex, fromIndex:w.fromIndex }))
    };
    pasteOffset = 40;
    toast(`Copied ${ids.length} part${ids.length>1?'s':''}`);
  }

  function pasteClipboard(){
    if(!clipboard || clipboard.nodes.length === 0){ toast('Nothing to paste'); return; }
    const offsetData = {
      nodes: clipboard.nodes.map(n=>({ ...n, x: n.x+pasteOffset, y: n.y+pasteOffset })),
      wires: clipboard.wires
    };
    const idMap = rebuildFromData(offsetData, { clear:false });
    selectedNodeIds.clear();
    nodes.forEach(n=>n.el.classList.remove('selected'));
    idMap.forEach(newId=>{
      selectedNodeIds.add(newId);
      const n = nodes.get(newId);
      if(n) n.el.classList.add('selected');
    });
    pasteOffset += 40;
    snapshot();
    toast(`Pasted ${idMap.size} part${idMap.size>1?'s':''}`);
  }

  document.getElementById('saveBoard').addEventListener('click', saveBoard);
  document.getElementById('shareBoard').addEventListener('click', shareBoard);
  document.getElementById('saveChip').addEventListener('click', saveAsChip);
  document.getElementById('saveChipPalette').addEventListener('click', saveAsChip);
  document.getElementById('simulationPause').addEventListener('click', event => {
    isSimulationPaused = !isSimulationPaused;
    lastSimulationFrame = performance.now();
    event.currentTarget.textContent = isSimulationPaused ? 'Resume' : 'Pause';
    event.currentTarget.classList.toggle('active', isSimulationPaused);
    toast(isSimulationPaused ? 'Simulation paused' : 'Simulation running');
  });
  document.getElementById('simulationSpeed').addEventListener('change', event => {
    simulationSpeed = Number(event.target.value) || 1;
    lastSimulationFrame = performance.now();
    toast(`Simulation speed: ${event.target.options[event.target.selectedIndex].text}`);
  });

  const loadBoardInput = document.getElementById('loadBoardInput');
  document.getElementById('loadBoardBtn').addEventListener('click', ()=> loadBoardInput.click());
  loadBoardInput.addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadBoardFromData(JSON.parse(reader.result));
      } catch(err) {
        toast('Could not parse file');
      }
    };
    reader.readAsText(file);
    loadBoardInput.value = '';
  });

  document.getElementById('loadHalfAdder').addEventListener('click', ()=>{
    clearBoard();
    const a  = createNode('INPUT', 60, 80);
    const b  = createNode('INPUT', 60, 220);
    const xo = createNode('XOR', 320, 70);
    const an = createNode('AND', 320, 230);
    const sum = createNode('OUTPUT', 580, 70);
    const carry = createNode('OUTPUT', 580, 230);
    createWire(a.id, xo.id, 0);
    createWire(b.id, xo.id, 1);
    createWire(a.id, an.id, 0);
    createWire(b.id, an.id, 1);
    createWire(xo.id, sum.id, 0);
    createWire(an.id, carry.id, 0);
    snapshot();
    toast('Half adder loaded');
  });

  document.getElementById('loadLatch').addEventListener('click', ()=>{
    clearBoard();
    const s  = createNode('INPUT', 50, 60);
    const r  = createNode('INPUT', 50, 260);
    const n1 = createNode('NOR', 320, 90);
    const n2 = createNode('NOR', 320, 230);
    const q  = createNode('OUTPUT', 580, 90);
    const qn = createNode('OUTPUT', 580, 230);
    createWire(s.id, n1.id, 0);
    createWire(r.id, n2.id, 1);
    createWire(n1.id, n2.id, 0);
    createWire(n2.id, n1.id, 1);
    createWire(n1.id, q.id, 0);
    createWire(n2.id, qn.id, 0);
    snapshot();
    toast('SR latch loaded');
  });

  document.getElementById('loadDLatch').addEventListener('click', ()=>{
    clearBoard();
    const d  = createNode('INPUT', 50, 120);
    const en = createNode('INPUT', 50, 300);
    const nd = createNode('NOT', 250, 120);
    const setAnd = createNode('AND', 420, 80);
    const resAnd = createNode('AND', 420, 220);
    const qNor = createNode('NOR', 620, 80);
    const qnNor = createNode('NOR', 620, 220);
    const q = createNode('OUTPUT', 850, 80);
    const qn = createNode('OUTPUT', 850, 220);

    createWire(d.id, nd.id, 0);
    createWire(d.id, setAnd.id, 0);
    createWire(en.id, setAnd.id, 1);
    createWire(nd.id, resAnd.id, 0);
    createWire(en.id, resAnd.id, 1);

    createWire(setAnd.id, qNor.id, 0);
    createWire(qnNor.id, qNor.id, 1);
    createWire(resAnd.id, qnNor.id, 0);
    createWire(qNor.id, qnNor.id, 1);

    createWire(qNor.id, q.id, 0);
    createWire(qnNor.id, qn.id, 0);

    snapshot();
    toast('D latch loaded');
  });

  function loadMarioTheme(){
    clearBoard();

    const trigger = createNode('INPUT', 80, 220);
    const speaker = createNode('SPEAKER', 340, 220);
    // Accurate transcription of the Super Mario Bros. (NES) Ground Theme, extended to
    // the full loop: main phrase (A), bridge section (B), then main phrase again (A).
    // freq 0 = rest. Durations in ms (100 = eighth note, 133 = dotted eighth, at ~200bpm).
    const mainPhrase = [
      [659,100],[659,100],[0,100],[659,100],
      [0,100],[523,100],[659,100],[0,100],
      [784,100],[0,100],[0,100],[0,100],
      [392,100],[0,100],[0,100],[0,100],

      [523,100],[0,100],[0,100],[392,100],
      [0,100],[0,100],[330,100],[0,100],
      [0,100],[440,100],[0,100],[494,100],
      [0,100],[466,100],[440,100],[0,100],

      [392,133],[659,133],[784,133],
      [880,100],[0,100],[698,100],[784,100],
      [0,100],[659,100],[0,100],[523,100],
      [587,100],[494,100],[0,100],[0,100],

      [523,100],[0,100],[0,100],[392,100],
      [0,100],[0,100],[330,100],[0,100],
      [0,100],[440,100],[0,100],[494,100],
      [0,100],[466,100],[440,100],[0,100],

      [392,133],[659,133],[784,133],
      [880,100],[0,100],[698,100],[784,100],
      [0,100],[659,100],[0,100],[523,100],
      [587,100],[494,100],[0,100],[0,100]
    ];

    const bridge = [
      [523,100],[523,100],[523,100],
      [0,100],
      [523,100],[587,100],[659,100],
      [523,100],[440,100],[392,100],
      [0,100],
      [0,100],

      [523,100],[523,100],[523,100],
      [0,100],
      [523,100],[587,100],[659,100],
      [0,100],
      [0,100],
      [0,100],

      [523,100],[523,100],[523,100],
      [0,100],
      [523,100],[587,100],[659,100],
      [523,100],[440,100],[392,100],
      [0,100],
      [0,100],

      [330,100],[330,100],[262,100],
      [0,100],
      [0,100],
      [392,100],[0,100],
      [0,100],
      [0,100]
    ];

    const marioNotes = [...mainPhrase, ...bridge, ...mainPhrase];

    let stepIndex = 0;
    let timer = null;

    function playMarioStep(){
      if (stepIndex >= marioNotes.length) {
        trigger.value = false;
        speaker.value = false;
        playTone(speaker, false);
        snapshot();
        return;
      }
      const [freq, duration] = marioNotes[stepIndex];

      if (freq > 0) {
        speaker.speakerSettings = { ...getSpeakerSettings(speaker), frequency: freq, volume: 20, waveform: 'square' };
        trigger.value = true;
        speaker.value = true;
        playTone(speaker, true);
        updateSpeakerReadouts(speaker);
        timer = setTimeout(() => {
          speaker.value = false;
          trigger.value = false;
          playTone(speaker, false);
          stepIndex += 1;
          timer = setTimeout(playMarioStep, duration * 0.1);
        }, duration * 0.9);
      } else {
        trigger.value = false;
        speaker.value = false;
        playTone(speaker, false);
        timer = setTimeout(() => {
          stepIndex += 1;
          playMarioStep();
        }, duration);
      }
    }

    clearTimeout(timer);
    stepIndex = 0;
    createWire(trigger.id, speaker.id, 0);
    playMarioStep();

    snapshot();
    toast('Mario Ground Theme activated');
  }

  const marioSequence = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'Enter'];
  let marioKeyBuffer = [];
  let marioKeyTimer = null;

  function resetMarioSequence(){
    marioKeyBuffer = [];
    clearTimeout(marioKeyTimer);
    marioKeyTimer = null;
  }

  document.addEventListener('keydown', (event) => {
    const key = event.key || event.code || '';
    const normalized = key === 'Up' ? 'ArrowUp' : key === 'Down' ? 'ArrowDown' : key === 'Left' ? 'ArrowLeft' : key === 'Right' ? 'ArrowRight' : key;
    const validKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']);
    const isArrowOrEnter = validKeys.has(normalized);

    if (isArrowOrEnter) {
      event.preventDefault();
      clearTimeout(marioKeyTimer);
      marioKeyTimer = setTimeout(resetMarioSequence, 1800);
    }

    if (!isArrowOrEnter) return;

    if (normalized === marioSequence[marioKeyBuffer.length]) {
      marioKeyBuffer.push(normalized);
    } else {
      marioKeyBuffer = normalized === marioSequence[0] ? [normalized] : [];
    }

    if (marioKeyBuffer.length === marioSequence.length) {
      loadMarioTheme();
      resetMarioSequence();
    }
  });

    if(!restoreSharedBoardFromHash() && !restoreAutosavedBoard()) snapshot();

  /* ---------- palette search ---------- */
  const paletteSearch = document.getElementById('paletteSearch');
  if(paletteSearch){
    paletteSearch.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const parts = document.querySelectorAll('.palette .part');
      const headers = document.querySelectorAll('.palette h2');
      const seps = document.querySelectorAll('.palette .palette-sep');

      parts.forEach(p => {
        const text = p.textContent.toLowerCase();
        const type = p.dataset.type?.toLowerCase() || '';
        const visible = text.includes(q) || type.includes(q);
        p.style.display = visible ? 'flex' : 'none';
      });

      // Hide headers/separators if no children visible
      headers.forEach(h => {
        let next = h.nextElementSibling;
        let anyVisible = false;
        while(next && next.tagName !== 'H2'){
          if(next.classList.contains('part') && next.style.display !== 'none') anyVisible = true;
          if(next.classList.contains('custom-chip-row')){
             const btn = next.querySelector('.part');
             if(btn && btn.style.display !== 'none') anyVisible = true;
          }
          next = next.nextElementSibling;
        }
        h.style.display = anyVisible ? 'block' : 'none';
      });
      
      seps.forEach(s => {
        const prevH = s.previousElementSibling;
        if(prevH && prevH.tagName === 'H2') s.style.display = prevH.style.display;
      });
    });
  }

})();