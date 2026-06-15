// slopsmith-plugin-flappy-bend — Flappy Bird, bend-controlled.
//
// Mechanic: the player picks a backing track. Each track specifies a
// base note (e.g. G string fret 7 → D4) and a piecewise-linear bend
// curve in cents over time. The game generates pipes at fixed intervals
// along that curve; each pipe's gap-center sits at the curve's value at
// that moment. To pass a pipe the player must bend by the right amount
// at the right time.
//
// Pitch input comes from the minigames SDK (continuous YIN). The bird's
// Y is driven by detected cents above the base frequency, with a small
// spring-damped pursuit to remove jitter. When confidence drops the
// bird falls via gravity.

(function () {
  'use strict';

  const PLUGIN_ID = 'flappy_bend';
  const API_BASE  = `/api/plugins/${PLUGIN_ID}`;
  const ASSETS    = `${API_BASE}/assets`;

  // ── Kaph font (SIL OFL — see fonts/LICENSE-Kaph.txt) ──────────────────
  // Injected once, eagerly, so the browser can fetch the woff2 while
  // sprites are loading. Scoped via the .fb-game-root class so we never
  // affect surrounding Slopsmith UI.
  (function injectKaph() {
    if (document.getElementById('flappy-bend-kaph-css')) return;
    const style = document.createElement('style');
    style.id = 'flappy-bend-kaph-css';
    style.textContent = `
      @font-face {
        font-family: 'Kaph';
        font-style: normal;
        font-weight: 400;
        font-display: swap;
        src: url('${ASSETS}/fonts/Kaph-Regular.woff2') format('woff2');
      }
      @font-face {
        font-family: 'Kaph';
        font-style: italic;
        font-weight: 400;
        font-display: swap;
        src: url('${ASSETS}/fonts/Kaph-Italic.woff2') format('woff2');
      }
      .fb-game-root,
      .fb-game-root * {
        font-family: 'Kaph', system-ui, -apple-system, sans-serif !important;
        /* Kaph ships in Regular + Italic only. Synthetic bold is allowed so
           Tailwind font-semibold / font-black classes produce visible emphasis
           on countdown numbers and labels. */
      }
      .fb-game-root .uppercase {
        letter-spacing: 0.18em;
      }
    `;
    document.head.appendChild(style);
  })();

  // ── Sprite cache (Flappy Bird assets from samuelcust/flappy-bird-assets) ─
  const SPRITE_NAMES = [
    'background-day', 'background-night', 'base',
    'pipe-green', 'pipe-red',
    'yellowbird-upflap', 'yellowbird-midflap', 'yellowbird-downflap',
    'redbird-upflap',    'redbird-midflap',    'redbird-downflap',
    'bluebird-upflap',   'bluebird-midflap',   'bluebird-downflap',
    'gameover', 'message',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  ];
  let _spritesPromise = null;
  function loadSprites() {
    if (_spritesPromise) return _spritesPromise;
    _spritesPromise = Promise.all(SPRITE_NAMES.map(name => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve([name, img]);
      img.onerror = () => reject(new Error(`failed to load sprite ${name}`));
      img.src = `${ASSETS}/sprites/${name}.png`;
    }))).then(pairs => Object.fromEntries(pairs));
    // Clear the cached promise on rejection so a later startGame() call
    // can retry rather than immediately re-receiving the rejected promise.
    _spritesPromise.catch(() => { _spritesPromise = null; });
    return _spritesPromise;
  }

  // ── Draw helpers (module level so they're swappable / testable) ──────

  function drawBackground(ctx, W, H, songT, sprites, bgScrollPxPerMs) {
    const bg = sprites['background-day'];
    if (!bg) { ctx.fillStyle = '#4ec0ca'; ctx.fillRect(0, 0, W, H); return; }
    // Tile background to cover canvas. Scale uniformly so the sprite
    // height matches the full canvas height and tile horizontally with
    // a slow parallax scroll.
    const scale = H / bg.height;
    const tileW = bg.width * scale;
    const offset = ((songT * bgScrollPxPerMs * 0.18) % tileW + tileW) % tileW;
    let x = -offset;
    while (x < W) {
      ctx.drawImage(bg, x, 0, tileW, H);
      x += tileW;
    }
  }

  function drawBase(ctx, W, H, songT, sprites, scrollPxPerMs) {
    const base = sprites['base'];
    if (!base) return 0;
    const baseH = Math.round(H * 0.13);
    const scale = baseH / base.height;
    const tileW = base.width * scale;
    const offset = ((songT * scrollPxPerMs) % tileW + tileW) % tileW;
    let x = -offset;
    while (x < W) {
      ctx.drawImage(base, x, H - baseH, tileW, baseH);
      x += tileW;
    }
    return baseH;
  }

  function drawIdealCurve(ctx, W, H, birdX, songT, track, MAX_CENTS, VISIBLE_MS, playArea, particles, dt) {
    // Sample the curve into two buckets: "ahead" (challenge to come, rendered
    // bright and thick) and "behind" (already cleared, fades to nothing).
    const ahead  = [];
    const behind = [];
    const yOf = (cents) =>
      playArea.top + (playArea.bottom - playArea.top) * (1 - Math.min(1, Math.max(0, cents / MAX_CENTS)));

    const DISSOLVE_MS = 700;  // window over which the behind-curve fades to gone
    for (let dt2 = -DISSOLVE_MS - 200; dt2 <= VISIBLE_MS + 200; dt2 += 22) {
      const tMs = songT + dt2;
      if (tMs < 0 || tMs > (track.duration_ms || 30000)) continue;
      const c = interpolateBend(track.bends, tMs);
      const x = birdX + (dt2 / VISIBLE_MS) * (W - birdX);
      const y = yOf(c);
      const pt = { x, y, dt2 };
      if (dt2 >= 0) ahead.push(pt);
      else          behind.push(pt);
    }

    // ── Ahead: thick glowing line with bright inner core ───────────────
    if (ahead.length > 1) {
      ctx.save();
      ctx.lineCap  = 'round';
      ctx.lineJoin = 'round';
      // Outer halo
      ctx.shadowColor = 'rgba(255, 200, 60, 0.95)';
      ctx.shadowBlur  = 22;
      const grad = ctx.createLinearGradient(ahead[0].x, 0, ahead[ahead.length - 1].x, 0);
      grad.addColorStop(0,    'rgba(255, 255, 255, 1)');
      grad.addColorStop(0.18, 'rgba(255, 230, 110, 1)');
      grad.addColorStop(1,    'rgba(255, 180, 30, 0.85)');
      ctx.strokeStyle = grad;
      ctx.lineWidth   = 7;
      ctx.beginPath();
      ctx.moveTo(ahead[0].x, ahead[0].y);
      for (let i = 1; i < ahead.length; i++) ctx.lineTo(ahead[i].x, ahead[i].y);
      ctx.stroke();
      // Bright inner core
      ctx.shadowBlur  = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth   = 2.4;
      ctx.beginPath();
      ctx.moveTo(ahead[0].x, ahead[0].y);
      for (let i = 1; i < ahead.length; i++) ctx.lineTo(ahead[i].x, ahead[i].y);
      ctx.stroke();
      ctx.restore();
    }

    // ── Behind: fade with distance behind the bird ─────────────────────
    if (behind.length > 1) {
      ctx.save();
      ctx.lineCap  = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < behind.length - 1; i++) {
        const p0 = behind[i], p1 = behind[i + 1];
        const avgDt = (p0.dt2 + p1.dt2) / 2;             // negative ms
        const a = Math.max(0, 1 + avgDt / DISSOLVE_MS);  // 1 at dt=0 → 0 at dt=-DISSOLVE_MS
        if (a <= 0.02) continue;
        ctx.shadowColor = `rgba(255, 220, 80, ${0.7 * a})`;
        ctx.shadowBlur  = 14 * a;
        ctx.strokeStyle = `rgba(255, 230, 130, ${0.75 * a})`;
        ctx.lineWidth   = 6 * a;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Dust spawner along the actively-dissolving zone ────────────────
    // Higher rate where the fade is "currently happening" (dt2 in the
    // sweet spot where the line is visibly evaporating).
    const dustPerSec = 110;
    const expected   = dustPerSec * Math.max(0, Math.min(0.05, dt));
    let toSpawn = Math.floor(expected) + ((Math.random() < (expected % 1)) ? 1 : 0);
    while (toSpawn-- > 0) {
      // Bias spawn toward the middle of the dissolve window (most-visible fade).
      const dt2 = -40 - Math.pow(Math.random(), 0.7) * (DISSOLVE_MS - 60);
      const tMs = songT + dt2;
      if (tMs < 0 || tMs > (track.duration_ms || 30000)) continue;
      const c = interpolateBend(track.bends, tMs);
      const x = birdX + (dt2 / VISIBLE_MS) * (W - birdX);
      const y = yOf(c);
      const a = Math.max(0, 1 + dt2 / DISSOLVE_MS);
      const palette = ['#fef3c7', '#fde047', '#fbbf24', '#ffffff'];
      particles.push({
        x:  x + (Math.random() - 0.5) * 10,
        y:  y + (Math.random() - 0.5) * 10,
        vx: (Math.random() - 0.5) * 50,
        vy: -30 - Math.random() * 60,
        life: 0.6 + Math.random() * 0.5,
        decay: 1.4,
        size: (1.6 + Math.random() * 1.6) * a,
        gravity: -35,  // negative = drifts upward like real dust
        color: palette[(Math.random() * palette.length) | 0],
      });
    }
  }

  function drawPipe(ctx, x, gapY, gapHalf, pipeW, H, baseH, sprites, hitState) {
    // Pipe sprite is 52x320, lip at one end. We draw the bottom pipe
    // normally and the top pipe flipped vertically. The 320-tall sprite
    // tiles if the play-area chunk needed is taller; we scale uniformly
    // so the width matches our gameplay pipe width.
    const sprite = sprites[hitState === 'hit' ? 'pipe-red' : 'pipe-green'];
    if (!sprite) return;
    const scale = pipeW / sprite.width;
    const spriteH = sprite.height * scale;
    // Guard: if the canvas / container has 0 width, spriteH will be 0 and
    // the tiling while-loops below would never advance, causing an infinite
    // loop. Return early — the pipe will be redrawn on the next frame once
    // layout has settled.
    if (spriteH <= 0) return;

    // Top pipe (above gap): drawn upside-down.
    const topPipeEnd = gapY - gapHalf;
    if (topPipeEnd > 0) {
      ctx.save();
      ctx.translate(x, topPipeEnd);
      ctx.scale(1, -1);
      // Tile downward (which becomes upward after the flip).
      let drawn = 0;
      while (drawn < topPipeEnd) {
        ctx.drawImage(sprite, -pipeW / 2, drawn, pipeW, spriteH);
        drawn += spriteH;
      }
      ctx.restore();
    }

    // Bottom pipe (below gap).
    const bottomPipeStart = gapY + gapHalf;
    const playFloor = H - baseH;
    if (bottomPipeStart < playFloor) {
      ctx.save();
      ctx.translate(x, bottomPipeStart);
      let drawn = 0;
      const total = playFloor - bottomPipeStart;
      while (drawn < total) {
        ctx.drawImage(sprite, -pipeW / 2, drawn, pipeW, spriteH);
        drawn += spriteH;
      }
      ctx.restore();
    }
  }

  function drawBird(ctx, bird, sprites, pitchActive) {
    // Pick a flap frame from the wing phase.
    const phase = ((bird.wingPhase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const frame = (phase < (Math.PI * 2 / 3)) ? 'upflap'
                : (phase < (Math.PI * 4 / 3)) ? 'midflap'
                : 'downflap';
    const colour = pitchActive ? 'yellowbird' : 'redbird';
    const sprite = sprites[`${colour}-${frame}`] || sprites['yellowbird-midflap'];
    if (!sprite) return;
    const scale = 1.7;  // up-scale 34×24 → ~58×41 (more visible)
    const w = sprite.width * scale;
    const h = sprite.height * scale;
    ctx.save();
    ctx.translate(bird.x, bird.y);
    ctx.rotate(bird.rotation);
    ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function drawScoreNumbers(ctx, W, value, sprites, opts) {
    // Centered sprite-based score at top of canvas. `opts.y` is the
    // top edge; `opts.scale` is a uniform scale factor.
    const str = String(value);
    const scale = (opts && opts.scale) || 1.4;
    // All number sprites are 24x36 (sample dimensions).
    const glyphW = 24 * scale;
    const glyphH = 36 * scale;
    const gap    = 2 * scale;
    const totalW = str.length * glyphW + (str.length - 1) * gap;
    const startX = (W - totalW) / 2;
    const y = (opts && opts.y != null) ? opts.y : 16;
    // Soft drop shadow.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;
    for (let i = 0; i < str.length; i++) {
      const img = sprites[str[i]];
      if (img) ctx.drawImage(img, startX + i * (glyphW + gap), y, glyphW, glyphH);
    }
    ctx.restore();
  }

  function drawParticles(ctx, particles, dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      p.vy += (p.gravity || 0) * dt;
      p.life -= dt * (p.decay || 1.6);
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.5 + 0.5 * p.life), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ── Bootstrap: register with the minigames SDK (queue if not ready) ──
  // We register exactly once: either directly (SDK already loaded) or via
  // the pending queue (SDK drains it on init). The 'slopsmith-minigames-
  // ready' event is NOT used as a fallback — it would fire AFTER the
  // queue drain and trigger a second register() call, racing the hub
  // renderer and producing duplicate tiles.
  function postSpec(spec) {
    if (window.slopsmithMinigames && window.slopsmithMinigames.register) {
      window.slopsmithMinigames.register(spec);
    } else {
      (window.__slopsmithMinigamesPending = window.__slopsmithMinigamesPending || []).push(spec);
    }
  }

  // ── Track loading ─────────────────────────────────────────────────────
  let _trackIndex = null;       // [{ id, title }]
  let _trackCache = new Map();  // id → track.json

  async function loadTrackIndex() {
    // null  = not yet loaded / failed last time → try the fetch.
    // array = successfully loaded (may be empty if no tracks installed).
    if (_trackIndex !== null) return _trackIndex;
    try {
      const r = await fetch(`${ASSETS}/tracks/index.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      _trackIndex = j.tracks || [];
    } catch (e) {
      console.warn('[flappy_bend] track index missing:', e);
      // Leave _trackIndex as null so the next startGame() call can retry
      // via its explicit loadTrackIndex() invocation. (bootstrap() is an
      // IIFE and will not run again.) null is intentionally distinct from
      // an empty array so the !== null guard above re-attempts the fetch.
      // Return [] here so callers always get an array.
    }
    return _trackIndex || [];
  }

  async function loadTrack(id) {
    if (_trackCache.has(id)) return _trackCache.get(id);
    const r = await fetch(`${ASSETS}/tracks/${id}/track.json`);
    if (!r.ok) throw new Error(`track ${id} not found`);
    const data = await r.json();
    _trackCache.set(id, data);
    return data;
  }

  // ── Synth: chord-progression → drums + bass + pad via Web Audio ───────
  //
  // Music in track.json is just a tempo + chord list. The synth expands
  // each chord into a rock 4/4 groove: kick on 1+3, snare on 2+4, hihat
  // 8ths, bass root on 1 / fifth on 3, sustained pad triad on the chord
  // root. Scheduled ahead of time against the AudioContext clock so
  // timing is sample-accurate.
  function scheduleMusic(track) {
    const music = track.music;
    if (!music || !music.chords || !music.chords.length) {
      return { audioCtx: null, stop() {} };
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AC();
    const master = audioCtx.createGain();
    master.gain.value = 0.55;
    master.connect(audioCtx.destination);

    // Per-voice busses so we can balance the mix.
    const busDrums = audioCtx.createGain(); busDrums.gain.value = 0.9; busDrums.connect(master);
    const busBass  = audioCtx.createGain(); busBass.gain.value  = 0.7; busBass.connect(master);
    const busPad   = audioCtx.createGain(); busPad.gain.value   = 0.35; busPad.connect(master);

    const bpm    = music.tempo_bpm || track.bpm || 90;
    const beatS  = 60 / bpm;
    const eighth = beatS / 2;

    const startAt = audioCtx.currentTime + 0.1;

    // ── Voices ─────────────────────────────────────────────────────────
    function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

    function kick(t) {
      const osc = audioCtx.createOscillator();
      const g   = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1.0, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      osc.connect(g); g.connect(busDrums);
      osc.start(t); osc.stop(t + 0.28);
    }

    function snare(t) {
      const noise = audioCtx.createBufferSource();
      const buf   = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.2, audioCtx.sampleRate);
      const d     = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noise.buffer = buf;
      const bp = audioCtx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.9;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.8, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      noise.connect(bp); bp.connect(g); g.connect(busDrums);
      noise.start(t); noise.stop(t + 0.2);
    }

    function hihat(t, open) {
      const noise = audioCtx.createBufferSource();
      const len   = open ? 0.15 : 0.05;
      const buf   = audioCtx.createBuffer(1, Math.max(1, audioCtx.sampleRate * len), audioCtx.sampleRate);
      const d     = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noise.buffer = buf;
      const hp = audioCtx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 7000;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(open ? 0.25 : 0.18, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      noise.connect(hp); hp.connect(g); g.connect(busDrums);
      noise.start(t); noise.stop(t + len + 0.02);
    }

    function bass(t, midi, durS) {
      const osc = audioCtx.createOscillator();
      const lp  = audioCtx.createBiquadFilter();
      const g   = audioCtx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = midiToHz(midi);
      lp.type = 'lowpass'; lp.frequency.value = 700;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.7, t + 0.01);
      g.gain.setValueAtTime(0.5, t + durS * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t + durS);
      osc.connect(lp); lp.connect(g); g.connect(busBass);
      osc.start(t); osc.stop(t + durS + 0.02);
    }

    function pad(t, midis, durS) {
      midis.forEach((m, i) => {
        const osc = audioCtx.createOscillator();
        const g   = audioCtx.createGain();
        osc.type = i === 0 ? 'triangle' : 'sine';
        osc.frequency.value = midiToHz(m);
        // Slow attack + release for a pad feel.
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.25);
        g.gain.setValueAtTime(0.16, t + durS - 0.4);
        g.gain.exponentialRampToValueAtTime(0.0001, t + durS);
        osc.connect(g); g.connect(busPad);
        osc.start(t); osc.stop(t + durS + 0.02);
      });
    }

    // ── Expand chords into a groove ────────────────────────────────────
    const QUALITY = { maj: [0, 4, 7], min: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11] };
    const chords = music.chords.slice().sort((a, b) => a.t_ms - b.t_ms);

    chords.forEach((c, i) => {
      const nextMs = (chords[i + 1] && chords[i + 1].t_ms) || (track.duration_ms || 30000);
      const startS = startAt + c.t_ms / 1000;
      const endS   = startAt + nextMs / 1000;
      const durS   = endS - startS;
      const quality = QUALITY[c.quality || 'maj'] || QUALITY.maj;
      // Place pad voices in a fixed 4th-octave-ish window (MIDI 60–71).
      const padTriad = quality.map(iv => 60 + ((c.root + iv) % 12));
      pad(startS, padTriad, durS);

      // Walk 8th notes through the chord region.
      for (let t = c.t_ms; t < nextMs; t += eighth * 1000) {
        const sub  = Math.round((t - c.t_ms) / (eighth * 1000)) % 2; // 0 = downbeat, 1 = upbeat
        const beatInBar = Math.floor((t - c.t_ms) / (beatS * 1000)) % 4;
        const tS = startAt + t / 1000;

        // Drums.
        if (sub === 0 && (beatInBar === 0 || beatInBar === 2)) kick(tS);
        if (sub === 0 && (beatInBar === 1 || beatInBar === 3)) snare(tS);
        // Open hat on the "and of 4" for a little lift.
        const isAndOf4 = (sub === 1 && beatInBar === 3);
        hihat(tS, isAndOf4);

        // Bass: root on beat 1, fifth on beat 3.
        if (sub === 0 && beatInBar === 0) bass(tS, c.root - 12, beatS * 0.95);
        if (sub === 0 && beatInBar === 2) bass(tS, c.root - 12 + 7, beatS * 0.95);
      }
    });

    return {
      audioCtx,
      startAtAudioTime: startAt,
      stop() { audioCtx.close().catch(() => {}); },
    };
  }

  // ── Game state + render loop ──────────────────────────────────────────
  let runState = null;

  async function startGame({ container, modifiers, sdk }) {
    // If bootstrap()'s initial loadTrackIndex() failed transiently,
    // _trackIndex is still null — retry here before picking a default.
    if (_trackIndex === null) await loadTrackIndex();
    const trackId = modifiers.track || (_trackIndex && _trackIndex[0] && _trackIndex[0].id);
    if (!trackId) {
      container.innerHTML = '<div class="text-center text-gray-400 pt-20">No tracks installed.</div>';
      return;
    }

    let track;
    try {
      track = await loadTrack(trackId);
    } catch (e) {
      console.error('[flappy_bend] failed to load track:', trackId, e);
      container.innerHTML = `<div class="text-center text-red-400 pt-20">Failed to load track &#8220;${escapeHtml(trackId)}&#8221;.</div>`;
      return;
    }

    // Stop note_detect if it's running — it owns the mic and will fight
    // us for the stream, and its matchNotes loop crashes when called
    // outside a song screen (no highway → no .getTime). v1.1's scoring-
    // core extraction makes this cooperative; for now we just disable it.
    // Capture whether it was *actively running* so we can restore the same
    // state on exit — only re-enable if we actually interrupted an active
    // session (not if note_detect was already stopped before we entered).
    let noteDetectWasEnabled = false;
    try {
      if (window.noteDetect && typeof window.noteDetect.disable === 'function') {
        const running = typeof window.noteDetect.isRunning === 'function'
          ? window.noteDetect.isRunning()
          : true;  // assume running if no isRunning API (safe to re-enable)
        if (running) {
          noteDetectWasEnabled = true;
          window.noteDetect.disable();
        }
      }
    } catch (e) { console.warn('[flappy_bend] note_detect disable threw:', e); }

    // Modifier-driven knobs.
    const PIPE_SPACING_MS = ({ sparse: 1800, medium: 1100, dense: 700 })[modifiers.pipe_density] || 1100;
    const SCROLL_MULT     = ({ slow: 0.75,    normal: 1.0,   fast: 1.4   })[modifiers.scroll_speed] || 1.0;
    const VISIBLE_MS      = 3000 / SCROLL_MULT;
    const GAP_CENTS       = 60;     // full gap width in cents (halved in gapHalf calculation)
    const MAX_CENTS       = track.max_cents || 200;
    const BASE_FREQ       = track.instrument && track.instrument.base_freq_hz;

    // Build pipe list from the bend curve.
    const pipes = [];
    const firstAt = 1500;
    const endAt   = (track.duration_ms || 30000) - 500;
    for (let t = firstAt; t < endAt; t += PIPE_SPACING_MS) {
      const cents = interpolateBend(track.bends, t);
      pipes.push({ tMs: t, cents, passed: false, hit: false });
    }

    // Build the DOM.
    container.classList.add('fb-game-root');     // scopes the Kaph font + any future game-level styles
    container.style.background = '#4ec0ca';      // matches Flappy Bird day sky
    container.innerHTML = `
      <canvas class="absolute inset-0 w-full h-full block" style="image-rendering: pixelated;"></canvas>
      <div class="absolute top-3 left-4 right-4 flex items-start justify-between pointer-events-none">
        <div class="flex flex-col gap-1">
          <div class="px-3 py-1 rounded-full bg-black/40 text-white text-xs uppercase tracking-widest font-semibold">
            ${escapeHtml(track.title || trackId)}
          </div>
          <div class="px-3 py-1 rounded-full bg-black/40 text-white text-xs tracking-wide">
            ${escapeHtml(centerInstrumentLabel(track))}
          </div>
        </div>
        <div class="text-right">
          <div class="text-[10px] uppercase tracking-[0.25em] text-white/80"
               style="text-shadow: 1px 1px 0 rgba(0,0,0,0.6);">Accuracy</div>
          <div id="fb-score-acc" class="text-2xl font-black text-white leading-none"
               style="text-shadow: 2px 2px 0 rgba(0,0,0,0.6);">—</div>
        </div>
      </div>
      <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div id="fb-center" class="text-center text-white"
             style="text-shadow: 3px 3px 0 rgba(0,0,0,0.6);"></div>
      </div>
      <div class="absolute inset-x-0 top-[18%] flex items-start justify-center px-8 pointer-events-none" id="fb-overlay">
        <div class="text-center max-w-3xl"
             style="font-size: 42px;
                    line-height: 1.15;
                    color: #fde047;
                    text-shadow: 4px 4px 0 rgba(0,0,0,0.75), 0 0 28px rgba(0,0,0,0.4);">
          Play the indicated note — when the pitch is stable, the bird takes off.
        </div>
      </div>
    `;

    // Wait for sprites before painting (drawing helpers tolerate missing
    // sprites, but the first paint should be the real Flappy look — a
    // 1-frame blue flash otherwise).
    let sprites = {};
    try {
      sprites = await loadSprites();
    } catch (e) {
      console.error('[flappy_bend] sprite load failed:', e);
      // Continue anyway; draw helpers fall back to a flat sky color.
    }

    const canvas      = container.querySelector('canvas');
    const overlay     = container.querySelector('#fb-overlay');
    const center      = container.querySelector('#fb-center');
    const scoreAcc    = container.querySelector('#fb-score-acc');
    const ctx         = canvas.getContext('2d');
    // Pixel-art friendly — preserve crisp Flappy Bird sprite edges.
    ctx.imageSmoothingEnabled = false;

    // Persistent particle pool (pipe passes + crash debris).
    const particles = [];
    function spawnParticles(x, y, opts) {
      const n = opts.n || 12;
      const palette = opts.palette || ['#22d3ee', '#a78bfa', '#f0abfc'];
      for (let i = 0; i < n; i++) {
        const angle = (opts.angle != null) ? opts.angle + (Math.random() - 0.5) * (opts.spread || 1.4) : Math.random() * Math.PI * 2;
        const speed = (opts.speed || 200) * (0.5 + Math.random() * 0.8);
        particles.push({
          x, y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          decay: opts.decay || 1.6,
          size: opts.size || 3,
          gravity: opts.gravity || 0,
          color: palette[(Math.random() * palette.length) | 0],
        });
      }
    }

    // Cached CSS pixel size — updated by fitCanvas() so frame() can read
    // layout dimensions without calling getBoundingClientRect() every tick.
    let cssW = 1, cssH = 1;

    function fitCanvas() {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cssW = r.width;
      cssH = r.height;
      canvas.width  = Math.max(1, Math.floor(r.width  * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    fitCanvas();
    const onResize = () => fitCanvas();
    window.addEventListener('resize', onResize);

    // Stage HUD — throttled to re-render only when values change so we
    // don't force DOM updates at 60 fps.
    let _hudPassed = -1, _hudErr = '', _hudActive = null;
    function updateHud() {
      const errStr = errCount > 0 ? meanErrorCents.toFixed(0) : null;
      const errDisplay = errStr !== null ? `${errStr}¢` : '—';
      if (passed === _hudPassed && errDisplay === _hudErr && pitchActive === _hudActive) return;
      _hudPassed = passed; _hudErr = errDisplay; _hudActive = pitchActive;
      sdk.ui.mountHUD(
        `<span class="mg-pitch-dot ${pitchActive ? 'live' : ''}"></span>` +
        `Pipes <b class="text-white">${passed}</b>` +
        `<span class="mx-2 text-gray-600">·</span>` +
        `Err <b class="text-white">${errDisplay}</b>`
      );
    }

    // Pitch handle.
    const pitchHandle = sdk.scoring.createContinuous({
      expectedBaseFreqHz: BASE_FREQ,
      smoothingMs: 40,
    });

    let pitchActive    = false;
    let lastConfidence = 0;
    let currentCents   = 0;
    let baselineSettled = false;
    let baselineSinceMs = null;

    pitchHandle.on('pitch', (frame) => {
      lastConfidence = frame.confidence;
      pitchActive    = frame.confidence > 0.4;
      // Cents are already relative to expectedBaseFreqHz. Clamp.
      const c = pitchActive ? Math.max(-50, Math.min(MAX_CENTS, frame.cents)) : 0;
      currentCents = pitchActive ? c : 0;
      if (!baselineSettled && pitchActive && Math.abs(frame.cents) < 35) {
        // Within 35 cents of base note: count as "on baseline".
        if (baselineSinceMs == null) baselineSinceMs = performance.now();
        if (performance.now() - baselineSinceMs > 250) {
          baselineSettled = true;
          startCountdown();
        }
      } else {
        // Either not pitch-active or the pitch is off the baseline.
        // Reset the timer so the 250 ms window must be uninterrupted.
        baselineSinceMs = null;
      }
    });

    // Bird physics + cosmetics.
    const bird = {
      x: 0,
      y: 0,
      vy: 0,
      // Spring-damped pursuit.
      k:    220.0,   // stiffness
      damp: 18.0,    // damping
      gravityWhenIdle: 220.0, // px/s² when no pitch
      rotation: 0,    // radians, smoothed from vy
      wingPhase: 0,   // radians, animates flapping
    };

    // Game-state.
    let started     = false;
    let startedAtMs = null;
    let songT       = 0;        // ms since song-start
    let passed      = 0;
    let crashed     = false;
    let raf         = null;
    let errSum      = 0;
    let errCount    = 0;
    let meanErrorCents = 0;

    // Tracked so cleanup() can cancel them — without this, quitting
    // during the pre-game 3-2-1 leaves the setInterval running until it
    // ticks down to 0 and calls startSong() against torn-down state
    // (would leak the audio context and re-enter gameplay after stop).
    let countdownInterval = null;
    let goTimeout         = null;

    function startCountdown() {
      // Clear the instructional overlay immediately so 3-2-1 has the
      // center of the canvas to itself.
      overlay.innerHTML = '';
      let n = 3;
      const popIn = (s) => {
        center.innerHTML = `<div class="fb-countdown text-[160px] font-black leading-none">${s}</div>`;
      };
      popIn(n);
      countdownInterval = setInterval(() => {
        n -= 1;
        if (n <= 0) {
          clearInterval(countdownInterval);
          countdownInterval = null;
          center.innerHTML = `<div class="fb-go text-[120px] font-black leading-none text-cyan-200"
                                style="text-shadow: 0 0 32px rgba(34,211,238,0.9), 0 0 8px rgba(255,255,255,0.9);">GO</div>`;
          goTimeout = setTimeout(() => { center.innerHTML = ''; goTimeout = null; }, 500);
          startSong();
        } else {
          popIn(n);
        }
      }, 750);
    }

    // Backing music — synthesized live in Web Audio from the track's
    // chord progression. Returns an object with audioCtx + startAtAudioTime
    // that we use as the authoritative song clock (so pipes and music
    // stay phase-locked even if the rAF loop hiccups).
    let music = null;

    function startSong() {
      try {
        music = scheduleMusic(track);
      } catch (e) {
        // Web Audio unavailable or context-creation refused (e.g. browser
        // limit or no hardware). Fall back to a no-op music object so the
        // run continues without backing audio.
        console.warn('[flappy_bend] scheduleMusic failed, running silent:', e);
        music = { audioCtx: null, startAtAudioTime: 0, stop() {} };
      }
      // The setInterval countdown fires ~2 s after the original user
      // gesture; Chrome's autoplay policy may have suspended the new
      // AudioContext by then. Resume explicitly so backing audio plays even
      // if the context started in the 'suspended' state.
      if (music.audioCtx && music.audioCtx.state === 'suspended') {
        music.audioCtx.resume().catch(() => {});
      }
      started = true;
      startedAtMs = performance.now();
      // (raf loop is already running — see end of startGame.)
    }

    // Shared teardown — called from both endRun() (game over / finish) and
    // runState.cleanup() (user pressed Quit). Keeping it in one place
    // ensures both exit paths cancel the same resources.
    function teardown() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      // Cancel any pending countdown / "GO" splash timers so they can't
      // fire into torn-down state (e.g. instant pipe hit during countdown).
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
      if (goTimeout)         { clearTimeout(goTimeout);          goTimeout = null; }
      window.removeEventListener('resize', onResize);
      try { pitchHandle.stop(); } catch (e) {}
      try { music && music.stop(); } catch (e) {}
      // Re-enable note_detect if we disabled it on entry.
      if (noteDetectWasEnabled) {
        try {
          if (window.noteDetect && typeof window.noteDetect.enable === 'function') {
            window.noteDetect.enable();
          }
        } catch (e) { console.warn('[flappy_bend] note_detect re-enable threw:', e); }
      }
    }

    function endRun(reason) {
      teardown();

      const score = passed * 100 + Math.max(0, Math.round(100 - meanErrorCents));
      const summary =
        `Pipes passed: <b class="text-white">${passed}</b>` +
        `<br>Mean pitch error: <b class="text-white">${meanErrorCents.toFixed(1)}¢</b>` +
        `<br>Reason: <span class="text-gray-500">${reason}</span>`;

      sdk.end({
        score,
        durationMs: Math.max(0, Math.round(performance.now() - (startedAtMs || performance.now()))),
        modifiers,
        meta: {
          trackId,
          pipesPassed: passed,
          meanErrorCents,
          reason,
        },
        summaryHtml: summary,
      });
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - (frame._last || now)) / 1000);
      frame._last = now;
      // Song clock: audio clock once the song is running, frozen at 0
      // during the pre-start preview state.
      if (started && music && music.audioCtx) {
        songT = Math.max(0, (music.audioCtx.currentTime - music.startAtAudioTime) * 1000);
      } else if (started) {
        songT = now - startedAtMs;
      } else {
        songT = 0;
      }

      // Target Y from cents.
      // Use the CSS dimensions cached by fitCanvas() — avoids a forced
      // layout recalc on every animation frame.
      const W = cssW, H = cssH;
      // Reserve the bottom 13% for the base tile (Flappy Bird ground).
      const baseH = Math.round(H * 0.13);
      const playTop = 0;
      const playBottom = H - baseH;
      const birdX = W * 0.28;

      // Inset the bird's vertical range by half its sprite height so the
      // bird sits ON TOP of the base at rest (cents=0), not half-buried,
      // and never clips into the top edge.
      const birdHalfH = 20;
      const safeTop    = playTop    + birdHalfH;
      const safeBottom = playBottom - birdHalfH;
      const safeRange  = safeBottom - safeTop;

      // Map cents into [safeTop, safeBottom]: 0 → bird at rest on the
      // ground, MAX_CENTS → bird at the ceiling.
      const centsToY = (c) => safeBottom - (Math.min(1, Math.max(0, c / MAX_CENTS))) * safeRange;
      const restY = safeBottom;
      const targetY = pitchActive ? centsToY(currentCents) : restY;

      // Initialise bird position.
      if (bird.y === 0) { bird.y = restY; bird.x = birdX; }
      bird.x = birdX;

      if (started && pitchActive) {
        // Spring-damped pursuit.
        const a = -bird.k * (bird.y - targetY) - bird.damp * bird.vy;
        bird.vy += a * dt;
      } else if (started) {
        bird.vy += bird.gravityWhenIdle * dt;
      } else if (pitchActive) {
        // Pre-start: gently lift the bird so the player can see their
        // input is being detected. No collision, no gravity.
        bird.y += (targetY - bird.y) * Math.min(1, dt * 6);
        bird.vy = 0;
      } else {
        // Pre-start, no input: bird rests on the floor (above base).
        bird.y += (restY - bird.y) * Math.min(1, dt * 4);
        bird.vy = 0;
      }
      bird.y += bird.vy * dt;

      // Clamp to the safe band. cents=0 is a legitimate resting state in
      // this game (the player's baseline note), so there's no floor-death
      // — only pipe collisions end the run.
      if (bird.y < safeTop)    { bird.y = safeTop;    bird.vy = 0; }
      if (bird.y > safeBottom) { bird.y = safeBottom; bird.vy = 0; }

      // Track error accumulation (only after countdown).
      if (started && songT > 0) {
        const idealCents = interpolateBend(track.bends, songT);
        const err = Math.abs(currentCents - idealCents);
        errSum += err;
        errCount += 1;
        meanErrorCents = errSum / Math.max(1, errCount);
      }

      // ── Draw ──────────────────────────────────────────────────────────
      // Scroll rate for parallax surfaces: same as pipe scroll so the
      // ground "moves" at gameplay speed.
      const scrollPxPerMs = (W - birdX) / VISIBLE_MS;

      drawBackground(ctx, W, H, songT, sprites, scrollPxPerMs);

      // Pipes (drawn before base so the base overlaps and hides the
      // bottom of the pipes — classic Flappy Bird layering).
      const pipeW    = Math.round(W * 0.085);
      const gapHalf  = (GAP_CENTS / MAX_CENTS) * safeRange * 0.5;
      const birdR    = 16;  // collision radius, slightly smaller than visual
      // Use the inset safe band (matching centsToY's coordinate space) so
      // the ideal-bend curve and pipe gap-centers align with gameplay geometry.
      const playArea = { top: safeTop, bottom: safeBottom };
      for (const p of pipes) {
        const dx = p.tMs - songT;
        const x = birdX + (dx / VISIBLE_MS) * (W - birdX);
        // Cull on actual screen position, not time, so pipes don't pop
        // out mid-air. Skip pipes fully off-screen on either side.
        if (x + pipeW / 2 < -20) continue;
        if (x - pipeW / 2 > W + 20) continue;

        const gapY = centsToY(p.cents);

        drawPipe(ctx, x, gapY, gapHalf, pipeW, playBottom, 0, sprites, p.hit ? 'hit' : 'ok');

        // Mark as passed once fully behind the bird — this also disables
        // further collision checks for the pipe (we already added the
        // score), preventing a phantom hit when the player bends up for
        // the next pipe while this one is still in the bird's column.
        if (!p.passed && !p.hit && started && (x + pipeW / 2 < bird.x - birdR)) {
          p.passed = true;
          passed += 1;
          spawnParticles(birdX, gapY, {
            n: 14, speed: 260, decay: 2.0, size: 2.5,
            palette: ['#fde047', '#ffffff', '#facc15'],
            angle: 0, spread: Math.PI,
          });
        }

        // Collision: only check pipes that have NOT been passed and that
        // actually overlap the bird's bounding box. Treat the bird as a
        // circle; collide with the two solid pipe rectangles (above and
        // below the gap).
        if (!p.passed && !p.hit && started) {
          const xOverlap = Math.abs(x - bird.x) < (pipeW / 2 + birdR);
          if (xOverlap) {
            const topSolidBottom    = gapY - gapHalf;
            const bottomSolidTop    = gapY + gapHalf;
            const hitsTop    = (bird.y - birdR) < topSolidBottom;
            const hitsBottom = (bird.y + birdR) > bottomSolidTop;
            if (hitsTop || hitsBottom) {
              p.hit = true;
              crashed = true;
              spawnParticles(bird.x, bird.y, {
                n: 32, speed: 360, decay: 1.2, size: 4,
                palette: ['#ef4444', '#f97316', '#fbbf24', '#ffffff'],
                gravity: 600,
              });
            }
          }
        }
      }

      // Ideal-bend curve: thick glowing line ahead, fading-with-dust trail behind.
      drawIdealCurve(ctx, W, H, birdX, songT, track, MAX_CENTS, VISIBLE_MS, playArea, particles, dt);

      // Base (ground) — drawn after pipes so it covers their bottoms.
      drawBase(ctx, W, H, songT, sprites, scrollPxPerMs);

      // Particles (drawn over the ground, under the bird).
      drawParticles(ctx, particles, dt);

      // Bird.
      const targetRot = Math.max(-0.55, Math.min(0.9, bird.vy * 0.002));
      bird.rotation += (targetRot - bird.rotation) * Math.min(1, dt * 10);
      bird.wingPhase += dt * (started ? (12 + Math.abs(bird.vy) * 0.02) : 8);
      drawBird(ctx, bird, sprites, pitchActive);

      // Score: big sprite numbers at top center (Flappy convention).
      drawScoreNumbers(ctx, W, passed, sprites, { y: Math.round(H * 0.06), scale: 1.4 });

      // Accuracy HUD (text only — no % sprite available).
      const accPct = errCount > 0
        ? Math.max(0, Math.min(100, Math.round(100 - meanErrorCents)))
        : null;
      scoreAcc.textContent = accPct == null ? '—' : `${accPct}%`;
      updateHud();

      if (crashed) {
        endRun('crashed into a pipe');
        return;
      }
      if (songT > (track.duration_ms || 30000)) {
        endRun('finished');
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    // Kick off the render loop immediately so the scene (floor, idle
    // bird, ideal curve, upcoming pipes) is visible while we wait for
    // the player to settle on the indicated note. The countdown +
    // gameplay run via the same loop with the `started` flag flipped on.
    raf = requestAnimationFrame(frame);

    // Save handles so stop() can reach them.
    runState = {
      cleanup() { teardown(); },
    };
  }

  function stopGame() {
    if (runState && runState.cleanup) runState.cleanup();
    runState = null;
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function interpolateBend(bends, tMs) {
    if (!bends || !bends.length) return 0;
    if (tMs <= bends[0].t_ms) return bends[0].cents;
    if (tMs >= bends[bends.length - 1].t_ms) return bends[bends.length - 1].cents;
    for (let i = 0; i < bends.length - 1; i++) {
      const a = bends[i], b = bends[i + 1];
      if (tMs >= a.t_ms && tMs <= b.t_ms) {
        const f = (tMs - a.t_ms) / Math.max(1, b.t_ms - a.t_ms);
        return a.cents + (b.cents - a.cents) * f;
      }
    }
    return 0;
  }

  function centerInstrumentLabel(track) {
    const ins = track.instrument || {};
    if (!ins.string) return '';
    const fret = ins.fret != null ? ` fret ${ins.fret}` : '';
    const note = ins.base_note ? ` — ${ins.base_note}` : '';
    return `Play ${ins.string} string${fret}${note}`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Register ──────────────────────────────────────────────────────────
  (async function bootstrap() {
    const tracks = await loadTrackIndex();
    postSpec({
      id:        PLUGIN_ID,
      title:     'Flappy Bend',
      tagline:   'Bend strings to keep the bird airborne',
      thumbnail: 'thumb.png',
      availableTracks: tracks,
      modifiers: [
        { id: 'pipe_density', label: 'Pipes', default: 'medium', values: ['sparse', 'medium', 'dense'] },
        { id: 'scroll_speed', label: 'Speed', default: 'normal', values: ['slow', 'normal', 'fast'] },
      ],
      start: startGame,
      stop:  stopGame,
    });
  })();
})();
