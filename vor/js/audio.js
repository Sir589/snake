// audio.js — G.audio: every sound in Širé moře is synthesized here with WebAudio (no samples).
//  - one-shot SFX for the 'sfx' event (oscillators, filtered noise, envelopes), positional when the
//    event carries a position (inverse distance, stereo pan, air absorption), with voice limiting;
//  - a living sea ambience (wash, surf, wind, rain, creaks, lapping, gulls, a soft night drone);
//  - a small generative sea-shanty score (Karplus-Strong plucks + accordion-ish pad) that turns
//    into a tense drum + low ostinato loop while pirates are around.
// See ../DESIGN.md §6 "audio.js".
(function () {
  'use strict';
  const G = window.G;
  if (!G) return;

  const AC = window.AudioContext || window.webkitAudioContext || null;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext || null;

  // Every name in the contract list (DESIGN.md §6). Unknown names are ignored.
  const NAMES = ['pickup', 'craft', 'build', 'place', 'break_wood', 'hammer', 'splash', 'splash_big',
    'hook_throw', 'hook_land', 'reel', 'shark_bite', 'hit', 'hurt', 'eat', 'drink', 'cannon',
    'explosion', 'fish_bite', 'fish_catch', 'cast', 'ui_click', 'ui_open', 'ui_close', 'warning',
    'sail', 'anchor', 'sizzle', 'bubble', 'swim', 'step', 'jump', 'death', 'thunder', 'coins',
    'sword', 'pirate_yell', 'whoosh', 'error'];

  const MAX_VOICES = 30;       // simultaneous one-shots (ambience/music not counted)
  const FAR = 120;             // positional sounds are silent past this distance (m)
  const FAR_FADE = 35;         // ...fading out over the last metres
  const ROLLOFF = 0.45;        // inverse-distance rolloff (WebAudio 'inverse' model)

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  let ctx = null, kit = null, ready = false, failed = !AC;
  let master = null, comp = null, pre = null, sfxBus = null, ambBus = null, musBus = null;
  let revIn = null, revOut = null, analyser = null, anaBuf = null;
  let voices = 0, unlockAt = -1e9, hiddenSuspended = false;
  let muted = !!(G.settings && G.settings.muted);
  let lastVolume = G.settings ? G.settings.volume : 0.8;

  // ---------------------------------------------------------------------------
  // Public API (exists at load time)
  // ---------------------------------------------------------------------------
  const A = (G.audio = {
    names: NAMES.slice(),
    get ctx() { return ctx; },
    get ready() { return ready; },
    get muted() { return muted; },
    // play(name, {position?, volume?, pan?}) -> true if a voice started
    play(name, opts) { return play(name, opts || null); },
    has(name) { return !!SFX[name]; },
    setMuted(on, quiet) { setMuted(!!on, quiet); },
    toggleMute() { setMuted(!muted); },
    unlock() { unlock(); },
    // debugging / tests
    info() {
      return { state: ctx ? ctx.state : 'none', ready, muted, voices, music: MUS.mode,
        sampleRate: ctx ? ctx.sampleRate : 0 };
    },
    // current output level of the master bus { rms, peak } (creates a tap on first use)
    level() {
      if (!ready) return { rms: 0, peak: 0 };
      if (!analyser) {
        analyser = ctx.createAnalyser(); analyser.fftSize = 2048; master.connect(analyser);
        anaBuf = new Float32Array(analyser.fftSize);
        return { rms: 0, peak: 0 };
      }
      analyser.getFloatTimeDomainData(anaBuf);
      let s = 0, p = 0;
      for (let i = 0; i < anaBuf.length; i++) { const x = anaBuf[i]; s += x * x; if (x > p) p = x; else if (-x > p) p = -x; }
      return { rms: Math.sqrt(s / anaBuf.length), peak: p };
    },
    // renders one SFX offline and measures it -> Promise<{name, dur, peak, rms, bad}>
    analyze(name, opts) { return analyze(name, opts || {}); },
  });

  // ---------------------------------------------------------------------------
  // Buffers: seamless looping noise, distortion curves, reverb IR, plucked strings
  // ---------------------------------------------------------------------------
  function makeNoise(ac, seconds, kind) {
    const sr = ac.sampleRate, n = Math.floor(sr * seconds), fade = Math.floor(sr * 0.06);
    const d = new Float32Array(n + fade);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'pink') {
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = b0 + b1 + b2 + w * 0.1848;
      } else if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02; d[i] = last;
      } else d[i] = w;
    }
    // the tail continues naturally into the head: crossfade it in so the loop has no seam
    for (let i = 0; i < fade; i++) {
      const a = (i / fade) * Math.PI * 0.5;
      d[i] = d[i] * Math.sin(a) + d[n + i] * Math.cos(a);
    }
    let mean = 0;
    for (let i = 0; i < n; i++) mean += d[i];
    mean /= n;
    let peak = 0;
    for (let i = 0; i < n; i++) { const x = Math.abs(d[i] - mean); if (x > peak) peak = x; }
    const g = peak > 0 ? 0.9 / peak : 1;
    const buf = ac.createBuffer(1, n, sr), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (d[i] - mean) * g;
    return buf;
  }

  function makeCurve(k) {
    const n = 1024, c = new Float32Array(n), t = Math.tanh(k);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / t; }
    return c;
  }

  function makeIR(ac, sec) {
    const sr = ac.sampleRate, n = Math.floor(sr * sec), pre = Math.floor(sr * 0.018);
    const buf = ac.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / (n - pre);
        lp += (1 - 0.86 * t) * ((Math.random() * 2 - 1) - lp);    // tail gets darker
        d[i] = lp * Math.pow(1 - t, 2.3) * (i - pre < 240 ? (i - pre) / 240 : 1);
      }
    }
    return buf;
  }

  function makeKit(ac) {
    return {
      ac, sr: ac.sampleRate,
      white: makeNoise(ac, 3, 'white'),
      pink: makeNoise(ac, 5, 'pink'),
      brown: makeNoise(ac, 5, 'brown'),
      dist: makeCurve(3.2),
      soft: makeCurve(1.6),
      plucks: Object.create(null),
    };
  }

  // Karplus-Strong plucked string, rendered once per base note and re-pitched by playbackRate.
  function pluckBuf(k, base) {
    let b = k.plucks[base];
    if (b) return b;
    const sr = k.sr, f = mtof(base);
    const N = Math.max(4, Math.floor(sr / f - 0.5)), fr = sr / (N + 0.5);  // averaging adds half a sample
    const T60 = base < 45 ? 2.4 : base < 57 ? 2.0 : 1.5;
    const dec = Math.pow(0.001, 1 / (T60 * fr));
    const len = Math.floor(sr * (T60 + 0.2));
    const out = new Float32Array(len);
    let lp = 0, mean = 0;
    for (let i = 0; i < N; i++) {                   // excitation: soft noise + a triangle (warm pick)
      lp += 0.5 * ((Math.random() * 2 - 1) - lp);
      const x = i / N;
      out[i] = 0.55 * lp + 0.6 * (x < 0.5 ? x * 2 : 2 - x * 2) - 0.3;
      mean += out[i];
    }
    mean /= N;
    for (let i = 0; i < N; i++) out[i] -= mean;
    for (let i = N; i < len; i++) out[i] = dec * 0.5 * (out[i - N] + (i - N - 1 >= 0 ? out[i - N - 1] : 0));
    let peak = 0;
    for (let i = 0; i < len; i++) { const x = Math.abs(out[i]); if (x > peak) peak = x; }
    const g = peak > 0 ? 0.8 / peak : 1, fadeN = Math.floor(len * 0.08);
    for (let i = 0; i < len; i++) out[i] *= g * (i > len - fadeN ? (len - i) / fadeN : 1);
    const buf = k.ac.createBuffer(1, len, sr);
    buf.getChannelData(0).set(out);
    b = k.plucks[base] = { buf, corr: f / fr };
    return b;
  }
  const PL_BASES = [38, 50, 62, 74, 86];
  const PL = { buf: null, rate: 1 };
  function pluckFor(k, midi) {
    let best = PL_BASES[0];
    for (let i = 1; i < PL_BASES.length; i++) if (Math.abs(midi - PL_BASES[i]) < Math.abs(midi - best)) best = PL_BASES[i];
    const p = pluckBuf(k, best);
    PL.buf = p.buf; PL.rate = p.corr * Math.pow(2, (midi - best) / 12);
    return PL;
  }
  function pluckNote(k, dest, midi, t, vel, len) {
    const ac = k.ac, pl = pluckFor(k, midi);
    const s = ac.createBufferSource(); s.buffer = pl.buf; s.playbackRate.value = pl.rate;
    const g = ac.createGain(); g.gain.value = vel;
    s.connect(g); g.connect(dest);
    s.start(t);
    const natural = pl.buf.duration / pl.rate;
    if (len && len < natural) {
      g.gain.setValueAtTime(vel, t + len);
      g.gain.setTargetAtTime(0, t + len, 0.06);
      s.stop(t + len + 0.4);
    } else s.stop(t + natural);
  }

  // ---------------------------------------------------------------------------
  // Synthesis helpers (all take the AudioContext explicitly so they also work offline)
  // ---------------------------------------------------------------------------
  function gn(ac, g) { const n = ac.createGain(); n.gain.value = g == null ? 0 : g; return n; }
  function bq(ac, type, f, q) {
    const n = ac.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q == null ? 0.707 : q; return n;
  }
  function os(ac, type, f, t, end) {
    const o = ac.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); o.stop(end); return o;
  }
  function nz(k, kind, t, end, rate) {
    const s = k.ac.createBufferSource(); s.buffer = k[kind]; s.loop = true;
    if (rate) s.playbackRate.value = rate;
    s.start(t, Math.random() * s.buffer.duration * 0.9); s.stop(end);
    return s;
  }
  function link() {
    for (let i = 0; i < arguments.length - 1; i++) arguments[i].connect(arguments[i + 1]);
    return arguments[arguments.length - 1];
  }
  // percussive envelope: silence -> peak in `a` -> exponential decay over `d`
  function perc(p, t, peak, a, d) {
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function sweep(p, t, a, b, d) { p.setValueAtTime(a, t); p.exponentialRampToValueAtTime(Math.max(1e-4, b), t + d); }

  // --- reusable sound atoms ---------------------------------------------------
  function knock(v, t, f, amp, dec) {            // woody knock: pitched body + filtered click
    const { ac, k, out } = v;
    const o = os(ac, 'sine', f, t, t + dec + 0.06);
    sweep(o.frequency, t, f * 1.6, f, 0.012);
    const g = gn(ac); perc(g.gain, t, amp, 0.002, dec);
    link(o, g, out);
    const n = nz(k, 'white', t, t + 0.07), bp = bq(ac, 'bandpass', Math.min(8000, f * 6), 1.5), g2 = gn(ac);
    perc(g2.gain, t, amp * 0.6, 0.001, 0.03);
    link(n, bp, g2, out);
  }
  function thud(v, t, f, amp, dec) {              // low body thump with a pitch drop
    const o = os(v.ac, 'sine', f, t, t + dec + 0.06);
    sweep(o.frequency, t, f, f * 0.45, dec);
    const g = gn(v.ac); perc(g.gain, t, amp, 0.004, dec);
    link(o, g, v.out);
  }
  function rattle(v, t, n, amp) {                // boards settling
    const { ac, k, out } = v;
    const src = nz(k, 'white', t, t + n * 0.08 + 0.1), bp = bq(ac, 'bandpass', 1400, 2), g = gn(ac);
    link(src, bp, g, out);
    let tt = t;
    for (let i = 0; i < n; i++) { perc(g.gain, tt, amp * (1 - i / (n + 1)), 0.002, 0.025); tt += rnd(0.035, 0.065); }
  }
  const BELL_R = [1, 2.01, 2.76, 5.4], BELL_A = [1, 0.45, 0.3, 0.12];
  function bell(v, t, f, amp, dec) {              // soft chime, higher partials die sooner
    for (let i = 0; i < 4; i++) {
      const d = dec / (1 + i * 0.8);
      const o = os(v.ac, 'sine', f * BELL_R[i], t, t + d + 0.05), g = gn(v.ac);
      perc(g.gain, t, amp * BELL_A[i], 0.003, d);
      link(o, g, v.out);
    }
  }
  function pluckTone(v, t, f, amp, dec) {         // small bright pluck (triangle + octave, closing lowpass)
    const { ac, out } = v;
    const o = os(ac, 'triangle', f, t, t + dec + 0.1), o2 = os(ac, 'sine', f * 2, t, t + dec + 0.05), g2 = gn(ac, 0.22);
    const lp = bq(ac, 'lowpass', 6000, 0.9); sweep(lp.frequency, t, 7000, 1500, dec * 0.7);
    const g = gn(ac); perc(g.gain, t, amp, 0.003, dec);
    o.connect(lp); link(o2, g2, lp); link(lp, g, out);
  }
  function whooshAt(v, t, dur, f0, f1, amp) {
    const { ac, k, out, p } = v;
    const n = nz(k, 'white', t, t + dur + 0.1), bp = bq(ac, 'bandpass', f0, 1.3), g = gn(ac);
    bp.frequency.setValueAtTime(f0 * p, t);
    bp.frequency.exponentialRampToValueAtTime(f1 * p, t + dur * 0.45);
    bp.frequency.exponentialRampToValueAtTime(f0 * 1.6 * p, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    link(n, bp, g, out);
  }
  function swish(v, t, f0, f1, dur, amp) {
    const { ac, k, out } = v;
    const n = nz(k, 'white', t, t + dur + 0.05), bp = bq(ac, 'bandpass', f0, 1), g = gn(ac);
    sweep(bp.frequency, t, f0, f1, dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    link(n, bp, g, out);
  }
  function droplets(v, t, n, amp) {               // water drops: tiny rising "plinks"
    for (let i = 0; i < n; i++) {
      const tt = t + Math.random() * 0.5, f = rnd(900, 1800);
      const o = os(v.ac, 'sine', f, tt, tt + 0.07);
      sweep(o.frequency, tt, f, f * 1.8, 0.04);
      const g = gn(v.ac); perc(g.gain, tt, amp * rnd(0.5, 1), 0.002, 0.04);
      link(o, g, v.out);
    }
  }
  function plop(v, t, f, amp) {
    const o = os(v.ac, 'sine', f, t, t + 0.16);
    sweep(o.frequency, t, f, f * 0.28, 0.09);
    const g = gn(v.ac); perc(g.gain, t, amp, 0.002, 0.12);
    link(o, g, v.out);
  }
  function creakTone(v, t, f, dur, amp) {         // wood/rope creak: stick-slip buzz through resonances
    const { ac, out } = v;
    const o = os(ac, 'sawtooth', f, t, t + dur + 0.05);
    o.frequency.setValueAtTime(f, t);
    o.frequency.linearRampToValueAtTime(f * rnd(1.15, 1.45), t + dur);
    const b1 = bq(ac, 'bandpass', f * 6 + 300, 6), b2 = bq(ac, 'bandpass', f * 11 + 500, 8), g2 = gn(ac, 0.5);
    const am = gn(ac, 0.5), lfo = os(ac, 'square', rnd(16, 34), t, t + dur + 0.05), lg = gn(ac, 0.5);
    link(lfo, lg, am.gain);
    const env = gn(ac);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(amp, t + dur * 0.35);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(b1); o.connect(b2); b1.connect(am); link(b2, g2, am); link(am, env, out);
  }
  function organ(v, t, f, len, amp) {
    const { ac, out } = v;
    const o = os(ac, 'sine', f, t, t + len + 0.45), o2 = os(ac, 'triangle', f * 2, t, t + len + 0.45), g2 = gn(ac, 0.18);
    const g = gn(ac);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.05);
    g.gain.setValueAtTime(amp * 0.8, t + len);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.4);
    o.connect(g); link(o2, g2, g); g.connect(out);
  }
  const SB_R = [0.5, 1, 1.19, 1.5, 2, 2.66], SB_A = [0.25, 1, 0.45, 0.3, 0.4, 0.18], SB_D = [2.6, 2.2, 1.5, 1.2, 1.0, 0.6];
  function shipBell(v, t, f, amp) {
    for (let i = 0; i < SB_R.length; i++) {
      const o = os(v.ac, 'sine', f * SB_R[i], t, t + SB_D[i] + 0.05), g = gn(v.ac);
      perc(g.gain, t, amp * SB_A[i], 0.002, SB_D[i]);
      link(o, g, v.out);
    }
  }

  // ---------------------------------------------------------------------------
  // SFX recipes. Each gets v = { ac, k, t, out, p (pitch factor), opts } and returns its length (s).
  // ---------------------------------------------------------------------------
  const S = Object.create(null);

  S.pickup = (v) => {                              // bright two-note pluck
    pluckTone(v, v.t, 784 * v.p, 0.3, 0.22);
    pluckTone(v, v.t + 0.075, 1175 * v.p, 0.36, 0.32);
    return 0.5;
  };
  S.craft = (v) => {                               // woody knocks + chime
    const t = v.t, p = v.p;
    knock(v, t, 380 * p, 0.5, 0.08);
    knock(v, t + 0.12, 330 * p, 0.45, 0.08);
    knock(v, t + 0.24, 420 * p, 0.5, 0.1);
    bell(v, t + 0.38, 1046 * p, 0.22, 1.1);
    bell(v, t + 0.47, 1568 * p, 0.14, 0.9);
    return 1.6;
  };
  S.build = (v) => {
    const t = v.t, p = v.p;
    knock(v, t, 240 * p, 0.6, 0.1);
    thud(v, t, 110 * p, 0.55, 0.3);
    knock(v, t + 0.1, 300 * p, 0.42, 0.08);
    rattle(v, t + 0.17, 4, 0.2);
    return 0.65;
  };
  S.place = (v) => {
    knock(v, v.t, 200 * v.p, 0.55, 0.09);
    thud(v, v.t, 95 * v.p, 0.5, 0.25);
    rattle(v, v.t + 0.08, 2, 0.14);
    return 0.45;
  };
  S.break_wood = (v) => {                          // crack + splinters + thud
    const { ac, k, out, t, p } = v;
    const n = nz(k, 'white', t, t + 0.2), hp = bq(ac, 'highpass', 1400 * p, 0.7), g = gn(ac);
    perc(g.gain, t, 0.5, 0.001, 0.07);
    link(n, hp, g, out);
    const n2 = nz(k, 'white', t, t + 0.75), bp = bq(ac, 'bandpass', 2400 * p, 3), g2 = gn(ac);
    link(n2, bp, g2, out);
    let tt = t + 0.02;
    for (let i = 0; i < 7; i++) {
      bp.frequency.setValueAtTime(rnd(1500, 3800) * p, tt);
      perc(g2.gain, tt, rnd(0.25, 0.5), 0.001, rnd(0.02, 0.04));
      tt += rnd(0.045, 0.08);
    }
    thud(v, t, 130 * p, 0.5, 0.28);
    knock(v, t + 0.01, 260 * p, 0.35, 0.12);
    return 0.75;
  };
  S.hammer = (v) => {                              // short knock with a metallic tick
    const { ac, t, out, p } = v;
    knock(v, t, 320 * p, 0.6, 0.06);
    const o = os(ac, 'sine', 2100 * p, t, t + 0.12), g = gn(ac); perc(g.gain, t, 0.09, 0.001, 0.07); link(o, g, out);
    const o2 = os(ac, 'sine', 3350 * p, t, t + 0.1), g2 = gn(ac); perc(g2.gain, t, 0.045, 0.001, 0.05); link(o2, g2, out);
    return 0.22;
  };
  S.splash = (v) => {                              // noise burst through a sweeping lowpass
    const { ac, k, out, t, p } = v;
    const n = nz(k, 'white', t, t + 0.8), lp = bq(ac, 'lowpass', 4000, 0.9), g = gn(ac);
    sweep(lp.frequency, t, 4200 * p, 420, 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    link(n, lp, g, out);
    const o = os(ac, 'sine', 520 * p, t, t + 0.12), g2 = gn(ac);
    sweep(o.frequency, t, 600 * p, 180, 0.09);
    perc(g2.gain, t, 0.14, 0.003, 0.08);
    link(o, g2, out);
    droplets(v, t + 0.12, 3, 0.06);
    return 0.8;
  };
  S.splash_big = (v) => {
    const { ac, k, out, t, p } = v;
    const n = nz(k, 'white', t, t + 1.6), lp = bq(ac, 'lowpass', 3000, 0.7), g = gn(ac);
    sweep(lp.frequency, t, 3200 * p, 260, 1.1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.65, t + 0.025);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    link(n, lp, g, out);
    thud(v, t, 95 * p, 0.6, 0.4);
    const n2 = nz(k, 'white', t, t + 1.5), hp = bq(ac, 'highpass', 3500, 0.7), g2 = gn(ac);
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.linearRampToValueAtTime(0.12, t + 0.12);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    link(n2, hp, g2, out);
    droplets(v, t + 0.25, 6, 0.07);
    return 1.6;
  };
  S.hook_throw = (v) => {                          // whoosh + rope whirr
    const { ac, t, out, p } = v;
    whooshAt(v, t, 0.32, 380, 2400, 0.38);
    const o = os(ac, 'sawtooth', 90 * p, t, t + 0.5), bp = bq(ac, 'bandpass', 900, 3), g = gn(ac);
    sweep(o.frequency, t, 90 * p, 55 * p, 0.45);
    perc(g.gain, t + 0.05, 0.1, 0.08, 0.3);
    link(o, bp, g, out);
    return 0.55;
  };
  S.hook_land = (v) => {                           // small splash + plonk
    const { ac, k, out, t, p } = v;
    const n = nz(k, 'white', t, t + 0.5), lp = bq(ac, 'lowpass', 2800, 0.8), g = gn(ac);
    sweep(lp.frequency, t, 2800 * p, 500, 0.3);
    perc(g.gain, t, 0.34, 0.008, 0.3);
    link(n, lp, g, out);
    const o = os(ac, 'sine', 420 * p, t, t + 0.15), g2 = gn(ac);
    sweep(o.frequency, t, 520 * p, 190, 0.1);
    perc(g2.gain, t, 0.22, 0.002, 0.1);
    link(o, g2, out);
    droplets(v, t + 0.06, 2, 0.05);
    return 0.55;
  };
  S.reel = (v) => {                                // ratchet clicks
    const { ac, k, out, t, p } = v;
    const n = nz(k, 'white', t, t + 0.45), bp = bq(ac, 'bandpass', 3200 * p, 4), g = gn(ac);
    link(n, bp, g, out);
    let tt = t;
    for (let i = 0; i < 9; i++) {
      bp.frequency.setValueAtTime((i & 1 ? 3600 : 2900) * p, tt);
      perc(g.gain, tt, 0.5, 0.0008, 0.014);
      tt += 0.042;
    }
    return 0.45;
  };
  S.shark_bite = (v) => {                          // crunchy chomps + low growl + thrash
    const { ac, k, out, t, p } = v;
    for (let i = 0; i < 2; i++) {
      const tt = t + i * 0.17;
      const n = nz(k, 'white', tt, tt + 0.25), bp = bq(ac, 'bandpass', (i ? 850 : 700) * p, 0.9);
      const drive = gn(ac, 2.2), ws = ac.createWaveShaper(), g = gn(ac);
      ws.curve = k.dist;
      perc(g.gain, tt, 0.42, 0.003, 0.13);
      link(n, bp, drive, ws, g, out);
      thud(v, tt, 120 * p, 0.4, 0.14);
    }
    const o = os(ac, 'sawtooth', 62 * p, t, t + 0.95), lp = bq(ac, 'lowpass', 320, 1.5), g = gn(ac);
    const lfo = os(ac, 'sine', 11, t, t + 0.95), lg = gn(ac, 7);
    link(lfo, lg, o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.4, t + 0.1);
    g.gain.setValueAtTime(0.4, t + 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    link(o, lp, g, out);
    const n2 = nz(k, 'white', t + 0.05, t + 0.9), lp2 = bq(ac, 'lowpass', 1600, 0.7), g2 = gn(ac);
    sweep(lp2.frequency, t + 0.05, 1800, 400, 0.7);
    perc(g2.gain, t + 0.05, 0.25, 0.05, 0.6);
    link(n2, lp2, g2, out);
    return 1.0;
  };
  S.hit = (v) => {                                 // punchy impact
    const { ac, k, out, t, p } = v;
    thud(v, t, 170 * p, 0.65, 0.16);
    const n = nz(k, 'white', t, t + 0.12), lp = bq(ac, 'lowpass', 2600 * p, 0.8), g = gn(ac);
    perc(g.gain, t, 0.45, 0.001, 0.06);
    link(n, lp, g, out);
    const n2 = nz(k, 'white', t, t + 0.05), hp = bq(ac, 'highpass', 4000, 0.7), g2 = gn(ac);
    perc(g2.gain, t, 0.18, 0.0005, 0.012);
    link(n2, hp, g2, out);
    return 0.26;
  };
  S.hurt = (v) => {                                // muffled "oof": buzz through two vowel formants
    const { ac, out, t, p } = v;
    const f0 = 165 * p;
    const o = os(ac, 'sawtooth', f0, t, t + 0.4);
    sweep(o.frequency, t, f0 * 1.1, f0 * 0.72, 0.28);
    const f1 = bq(ac, 'bandpass', 620, 4), f2 = bq(ac, 'bandpass', 1050, 6), g2 = gn(ac, 0.55);
    const mix = gn(ac, 3.2), lp = bq(ac, 'lowpass', 2200, 0.7), env = gn(ac);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.6, t + 0.025);
    env.gain.setValueAtTime(0.55, t + 0.08);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(f1); o.connect(f2); f1.connect(mix); link(f2, g2, mix); link(mix, lp, env, out);
    thud(v, t, 90 * p, 0.4, 0.15);
    return 0.4;
  };
  S.eat = (v) => {                                 // three crunchy bites
    const { ac, k, out, t, p } = v;
    for (let i = 0; i < 3; i++) {
      const tt = t + i * 0.15 + rnd(0, 0.03);
      const n = nz(k, 'white', tt, tt + 0.12), bp = bq(ac, 'bandpass', rnd(1800, 3000) * p, 1.2), g = gn(ac);
      perc(g.gain, tt, 0.45, 0.004, 0.035);
      perc(g.gain, tt + 0.045, 0.3, 0.003, 0.05);
      link(n, bp, g, out);
      thud(v, tt, 150 * p, 0.16, 0.06);
    }
    return 0.55;
  };
  S.drink = (v) => {                               // three gulps (rising bloops)
    const { ac, k, out, t, p } = v;
    for (let i = 0; i < 3; i++) {
      const tt = t + i * 0.27;
      const o = os(ac, 'sine', 260 * p, tt, tt + 0.15), g = gn(ac);
      sweep(o.frequency, tt, 230 * p, 560 * p, 0.08);
      perc(g.gain, tt, 0.38, 0.006, 0.09);
      link(o, g, out);
      const n = nz(k, 'brown', tt, tt + 0.15), lp = bq(ac, 'lowpass', 700, 1), g2 = gn(ac);
      perc(g2.gain, tt, 0.2, 0.01, 0.08);
      link(n, lp, g2, out);
    }
    return 0.85;
  };
  S.cannon = (v) => {                              // crack + low thump + rumble tail
    const { ac, k, out, t, p } = v;
    const n = nz(k, 'white', t, t + 0.15), hp = bq(ac, 'highpass', 900, 0.7), g = gn(ac);
    perc(g.gain, t, 0.6, 0.001, 0.08);
    link(n, hp, g, out);
    thud(v, t, 85 * p, 0.85, 0.7);
    const n2 = nz(k, 'brown', t, t + 1.2), lp = bq(ac, 'lowpass', 900, 0.8), g2 = gn(ac);
    sweep(lp.frequency, t, 1100, 180, 0.8);
    perc(g2.gain, t, 0.75, 0.004, 0.9);
    link(n2, lp, g2, out);
    const n3 = nz(k, 'brown', t, t + 2.8), lp3 = bq(ac, 'lowpass', 190, 0.7), g3 = gn(ac);
    g3.gain.setValueAtTime(0.0001, t);
    g3.gain.linearRampToValueAtTime(0.5, t + 0.12);
    g3.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    link(n3, lp3, g3, out);
    return 2.8;
  };
  S.explosion = (v) => {                           // blast + long darkening noise + boom + crackles
    const { ac, k, out, t, p } = v;
    const n = nz(k, 'white', t, t + 0.6), bp = bq(ac, 'bandpass', 1400 * p, 0.6), g = gn(ac);
    perc(g.gain, t, 0.45, 0.002, 0.4);
    link(n, bp, g, out);
    const n2 = nz(k, 'brown', t, t + 2.2), lp = bq(ac, 'lowpass', 2500, 0.7), g2 = gn(ac);
    sweep(lp.frequency, t, 2600 * p, 140, 1.6);
    perc(g2.gain, t, 0.85, 0.01, 1.9);
    link(n2, lp, g2, out);
    thud(v, t, 62 * p, 0.85, 1.2);
    const n3 = nz(k, 'white', t, t + 1.6), hp = bq(ac, 'highpass', 2200, 0.7), g3 = gn(ac);
    link(n3, hp, g3, out);
    let tt = t + 0.15;
    while (tt < t + 1.4) { perc(g3.gain, tt, rnd(0.06, 0.2), 0.0008, 0.018); tt += rnd(0.04, 0.16); }
    return 2.3;
  };
  S.fish_bite = (v) => {                           // quick 'plop' pitch drop (+ a bobber bounce)
    const { ac, k, out, t, p } = v;
    plop(v, t, 820 * p, 0.5);
    plop(v, t + 0.14, 700 * p, 0.28);
    const n = nz(k, 'white', t, t + 0.12), bp = bq(ac, 'bandpass', 1500, 1), g = gn(ac);
    perc(g.gain, t, 0.14, 0.002, 0.06);
    link(n, bp, g, out);
    return 0.4;
  };
  const CATCH_NOTES = [784, 988, 1175, 1568];
  S.fish_catch = (v) => {                          // flapping + happy arpeggio
    const { ac, k, out, t, p } = v;
    for (let i = 0; i < 3; i++) {
      const tt = t + i * 0.1;
      const n = nz(k, 'white', tt, tt + 0.1), bp = bq(ac, 'bandpass', 1700, 0.8), g = gn(ac);
      perc(g.gain, tt, 0.32, 0.003, 0.05);
      link(n, bp, g, out);
    }
    for (let i = 0; i < 4; i++) pluckTone(v, t + 0.16 + i * 0.075, CATCH_NOTES[i] * p, 0.26, 0.35);
    return 1.0;
  };
  S.cast = (v) => {                                // swish + line zing
    const { ac, out, t, p } = v;
    whooshAt(v, t, 0.3, 300, 1800, 0.34);
    const o = os(ac, 'sine', 1500 * p, t + 0.05, t + 0.5), g = gn(ac);
    sweep(o.frequency, t + 0.05, 1600 * p, 900 * p, 0.4);
    perc(g.gain, t + 0.05, 0.05, 0.02, 0.4);
    link(o, g, out);
    return 0.55;
  };
  S.ui_click = (v) => {
    const { ac, out, t, p } = v;
    const o = os(ac, 'sine', 1300 * p, t, t + 0.06), g = gn(ac);
    sweep(o.frequency, t, 1500 * p, 1000 * p, 0.03);
    perc(g.gain, t, 0.26, 0.001, 0.04);
    link(o, g, out);
    const o2 = os(ac, 'triangle', 650 * p, t, t + 0.05), g2 = gn(ac);
    perc(g2.gain, t, 0.12, 0.001, 0.03);
    link(o2, g2, out);
    return 0.08;
  };
  S.ui_open = (v) => {
    swish(v, v.t, 500, 1700, 0.14, 0.16);
    pluckTone(v, v.t + 0.02, 523 * v.p, 0.16, 0.18);
    pluckTone(v, v.t + 0.08, 784 * v.p, 0.16, 0.22);
    return 0.35;
  };
  S.ui_close = (v) => {
    swish(v, v.t, 1700, 500, 0.12, 0.14);
    pluckTone(v, v.t + 0.02, 784 * v.p, 0.15, 0.16);
    pluckTone(v, v.t + 0.07, 523 * v.p, 0.15, 0.2);
    return 0.3;
  };
  S.warning = (v) => {                             // ship horn: detuned saws (+ a fifth) through a lowpass
    const { ac, out, t, p } = v;
    const f = 98 * p, end = t + 3.0;
    const lp = bq(ac, 'lowpass', 400, 2.5), env = gn(ac);
    link(lp, env, out);
    const o1 = os(ac, 'sawtooth', f, t, end), o2 = os(ac, 'sawtooth', f * 1.006, t, end);
    const o3 = os(ac, 'sawtooth', f * 1.5, t, end), g3 = gn(ac, 0.35);
    o1.connect(lp); o2.connect(lp); link(o3, g3, lp);
    env.gain.setValueAtTime(0.0001, t);
    const blast = (s, d) => {
      const b = t + s;
      env.gain.setValueAtTime(0.0001, b);
      env.gain.linearRampToValueAtTime(0.36, b + 0.12);
      env.gain.setValueAtTime(0.33, b + d - 0.25);
      env.gain.exponentialRampToValueAtTime(0.0001, b + d);
      lp.frequency.setValueAtTime(350, b);
      lp.frequency.linearRampToValueAtTime(1300, b + 0.15);
      lp.frequency.linearRampToValueAtTime(950, b + d);
      o1.frequency.setValueAtTime(f * 0.94, b); o1.frequency.linearRampToValueAtTime(f, b + 0.15);
      o2.frequency.setValueAtTime(f * 1.006 * 0.94, b); o2.frequency.linearRampToValueAtTime(f * 1.006, b + 0.15);
    };
    blast(0, 1.0);
    blast(1.3, 1.6);
    return 3.0;
  };
  S.sail = (v) => {                                // canvas flap + rope creak
    const { ac, k, out, t, p } = v;
    const n = nz(k, 'white', t, t + 1.2), bp = bq(ac, 'bandpass', 700 * p, 0.7), trem = gn(ac, 0.5), env = gn(ac);
    const lfo = os(ac, 'sine', 13, t, t + 1.2), lg = gn(ac, 0.5);
    link(lfo, lg, trem.gain);
    sweep(bp.frequency, t, 500 * p, 1200 * p, 0.9);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.55, t + 0.12);
    env.gain.setValueAtTime(0.5, t + 0.5);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    link(n, bp, trem, env, out);
    creakTone(v, t + 0.25, 150 * p, 0.6, 0.5);
    return 1.2;
  };
  S.anchor = (v) => {                              // chain rattle (accelerating) + splash
    const { ac, k, out, t, p } = v;
    const n = nz(k, 'white', t, t + 1.3), bp = bq(ac, 'bandpass', 4000, 9), g = gn(ac);
    link(n, bp, g, out);
    const o = os(ac, 'sine', 3000, t, t + 1.3), og = gn(ac);
    link(o, og, out);
    let tt = t, gap = 0.1;
    for (let i = 0; i < 16; i++) {
      const f = rnd(2600, 4800) * p;
      bp.frequency.setValueAtTime(f, tt);
      o.frequency.setValueAtTime(f * 0.73, tt);
      perc(g.gain, tt, rnd(0.5, 0.9), 0.0008, 0.035);
      perc(og.gain, tt, rnd(0.03, 0.06), 0.001, 0.045);
      tt += gap; gap = Math.max(0.05, gap * 0.9);
    }
    const sp = tt + 0.05;
    const n2 = nz(k, 'white', sp, sp + 0.8), lp = bq(ac, 'lowpass', 2500, 0.7), g2 = gn(ac);
    sweep(lp.frequency, sp, 2500, 300, 0.6);
    perc(g2.gain, sp, 0.4, 0.01, 0.6);
    link(n2, lp, g2, out);
    thud(v, sp, 90 * p, 0.3, 0.3);
    return sp - t + 0.7;
  };
  S.sizzle = (v) => {                              // frying hiss with crackle spikes
    const { ac, k, out, t, p } = v;
    const dur = 1.3;
    const n = nz(k, 'white', t, t + dur), hp = bq(ac, 'highpass', 2800 * p, 0.7), lp = bq(ac, 'lowpass', 9000, 0.7), g = gn(ac);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.08);
    g.gain.setValueAtTime(0.1, t + dur - 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    link(n, hp, lp, g, out);
    const n2 = nz(k, 'white', t, t + dur), bp = bq(ac, 'bandpass', 4500, 2), g2 = gn(ac);
    link(n2, bp, g2, out);
    let tt = t + 0.02;
    while (tt < t + dur - 0.1) { perc(g2.gain, tt, rnd(0.12, 0.4), 0.0005, 0.01); tt += rnd(0.02, 0.07); }
    return dur;
  };
  S.bubble = (v) => {
    const { ac, out, t, p } = v;
    let tt = t;
    for (let i = 0; i < 4; i++) {
      const f = rnd(350, 750) * p;
      const o = os(ac, 'sine', f, tt, tt + 0.08), g = gn(ac);
      sweep(o.frequency, tt, f, f * 2.4, 0.05);
      perc(g.gain, tt, rnd(0.14, 0.26), 0.003, 0.05);
      link(o, g, out);
      tt += rnd(0.05, 0.12);
    }
    return tt - t + 0.1;
  };
  S.swim = (v) => {                                // soft water stroke
    const { ac, k, out, t, p } = v;
    const n = nz(k, 'white', t, t + 0.65), lp = bq(ac, 'lowpass', 1000, 0.6), g = gn(ac);
    sweep(lp.frequency, t, 1100 * p, 380, 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.13);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    link(n, lp, g, out);
    const n2 = nz(k, 'brown', t, t + 0.6), lp2 = bq(ac, 'lowpass', 300, 0.7), g2 = gn(ac);
    perc(g2.gain, t + 0.05, 0.25, 0.1, 0.4);
    link(n2, lp2, g2, out);
    droplets(v, t + 0.15, 1, 0.04);
    return 0.7;
  };
  S.step = (v) => {                                // wooden deck knock, or a sand crunch on islands
    const { ac, k, out, t, p, opts } = v;
    const kind = !(opts && opts.position) && G.player ? G.player.groundKind : 'raft';
    if (kind === 'island' || kind === 'ground') {
      const n = nz(k, 'white', t, t + 0.14), bp = bq(ac, 'bandpass', 2400 * p, 0.7), g = gn(ac);
      perc(g.gain, t, 0.2, 0.012, 0.08);
      link(n, bp, g, out);
      const n2 = nz(k, 'brown', t, t + 0.1), lp = bq(ac, 'lowpass', 500, 0.7), g2 = gn(ac);
      perc(g2.gain, t, 0.2, 0.005, 0.05);
      link(n2, lp, g2, out);
      return 0.16;
    }
    const n = nz(k, 'brown', t, t + 0.1), lp = bq(ac, 'lowpass', 750 * p, 0.8), g = gn(ac);
    perc(g.gain, t, 0.35, 0.002, 0.06);
    link(n, lp, g, out);
    const o = os(ac, 'sine', 155 * p, t, t + 0.08), g2 = gn(ac);
    sweep(o.frequency, t, 190 * p, 100 * p, 0.04);
    perc(g2.gain, t, 0.26, 0.002, 0.05);
    link(o, g2, out);
    return 0.12;
  };
  S.jump = (v) => {
    whooshAt(v, v.t, 0.18, 500, 1500, 0.16);
    knock(v, v.t, 170 * v.p, 0.25, 0.05);
    return 0.25;
  };
  const DEATH_F = [440, 349.2, 293.7, 220], DEATH_L = [0.42, 0.42, 0.5, 1.6];
  S.death = (v) => {                               // gentle, sad descending motif over a low swell
    const { ac, out, t } = v;
    let tt = t;
    for (let i = 0; i < 4; i++) { organ(v, tt, DEATH_F[i], DEATH_L[i], 0.2); tt += DEATH_L[i] * (i < 3 ? 0.9 : 1); }
    const o = os(ac, 'sine', 73.4, t, t + 3.4), g = gn(ac);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.25, t + 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.3);
    link(o, g, out);
    return 3.4;
  };
  S.thunder = (v) => {                             // crack(s) + long uneven rumble
    const { ac, k, out, t, p } = v;
    const d0 = rnd(0, 0.25), T = t + d0;
    const n = nz(k, 'white', T, T + 0.5), hp = bq(ac, 'highpass', 700, 0.6), g = gn(ac);
    link(n, hp, g, out);
    perc(g.gain, T, 0.5, 0.002, 0.12);
    perc(g.gain, T + 0.16, 0.3, 0.002, 0.1);
    perc(g.gain, T + 0.3, 0.2, 0.002, 0.15);
    const dur = rnd(3.4, 4.6);
    const n2 = nz(k, 'brown', T, T + dur + 0.2), lp = bq(ac, 'lowpass', 280 * p, 0.8), g2 = gn(ac);
    link(n2, lp, g2, out);
    g2.gain.setValueAtTime(0.0001, T);
    g2.gain.linearRampToValueAtTime(0.75, T + 0.18);
    let tt = T + 0.18;
    while (tt < T + dur * 0.7) { tt += rnd(0.25, 0.6); g2.gain.linearRampToValueAtTime(rnd(0.3, 0.8), tt); }
    g2.gain.exponentialRampToValueAtTime(0.0001, T + dur);
    const o = os(ac, 'sine', 42, T, T + dur), g3 = gn(ac);
    g3.gain.setValueAtTime(0.0001, T);
    g3.gain.linearRampToValueAtTime(0.3, T + 0.3);
    g3.gain.exponentialRampToValueAtTime(0.0001, T + dur * 0.8);
    link(o, g3, out);
    return d0 + dur + 0.1;
  };
  const COIN_R = [1, 2.32, 4.1], COIN_A = [0.16, 0.08, 0.045], COIN_D = [0.28, 0.16, 0.08];
  S.coins = (v) => {                               // metallic high partials, a few clinks
    const { ac, out, t, p } = v;
    const n = 3 + Math.floor(Math.random() * 3);
    let tt = t;
    for (let i = 0; i < n; i++) {
      const f = rnd(2300, 3300) * p;
      for (let j = 0; j < 3; j++) {
        const o = os(ac, 'sine', f * COIN_R[j], tt, tt + COIN_D[j] + 0.05), g = gn(ac);
        perc(g.gain, tt, COIN_A[j], 0.001, COIN_D[j]);
        link(o, g, out);
      }
      tt += rnd(0.045, 0.1);
    }
    return tt - t + 0.35;
  };
  const SWORD_F = [1850, 2790, 4120], SWORD_A = [0.09, 0.055, 0.035], SWORD_D = [0.5, 0.35, 0.2];
  S.sword = (v) => {                               // slash + steel ring
    const { ac, k, out, t, p } = v;
    whooshAt(v, t, 0.2, 800, 3200, 0.26);
    const T = t + 0.07;
    for (let j = 0; j < 3; j++) {
      const o = os(ac, 'sine', SWORD_F[j] * p, T, T + SWORD_D[j] + 0.05), g = gn(ac);
      perc(g.gain, T, SWORD_A[j], 0.002, SWORD_D[j]);
      link(o, g, out);
    }
    const n = nz(k, 'white', T, T + 0.2), bp = bq(ac, 'bandpass', 4200, 4), g = gn(ac);
    perc(g.gain, T, 0.16, 0.002, 0.1);
    link(n, bp, g, out);
    return 0.65;
  };
  S.pirate_yell = (v) => {                         // "Arrr!" / "Hej!": buzz through vowel formants
    const { ac, k, out, t, p } = v;
    const arr = Math.random() < 0.55;
    const f0 = (arr ? 125 : 175) * p * rnd(0.9, 1.12);
    const dur = arr ? 0.62 : 0.42;
    const o = os(ac, 'sawtooth', f0, t, t + dur + 0.05);
    o.frequency.setValueAtTime(f0 * 0.92, t);
    o.frequency.linearRampToValueAtTime(f0 * 1.25, t + dur * 0.3);
    o.frequency.linearRampToValueAtTime(f0 * 0.85, t + dur);
    const vib = os(ac, 'sine', 6, t, t + dur + 0.05), vg = gn(ac, f0 * 0.03);
    link(vib, vg, o.frequency);
    const F1 = bq(ac, 'bandpass', arr ? 720 : 520, 6), F2 = bq(ac, 'bandpass', arr ? 1150 : 1850, 8);
    const F2g = gn(ac, 0.7), mix = gn(ac, 3.5);
    if (arr) {
      F1.frequency.setValueAtTime(760, t); F1.frequency.linearRampToValueAtTime(560, t + dur);
      F2.frequency.setValueAtTime(1150, t); F2.frequency.linearRampToValueAtTime(1350, t + dur);
    }
    o.connect(F1); o.connect(F2); F1.connect(mix); link(F2, F2g, mix);
    const trem = gn(ac, 1);
    if (arr) { const l = os(ac, 'square', 26, t + dur * 0.45, t + dur), lg = gn(ac, 0.45); link(l, lg, trem.gain); }
    const ws = ac.createWaveShaper(); ws.curve = k.soft;
    const env = gn(ac);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.5, t + 0.04);
    env.gain.setValueAtTime(0.45, t + dur * 0.7);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    link(mix, trem, ws, env, out);
    return dur + 0.1;
  };
  S.whoosh = (v) => { whooshAt(v, v.t, 0.3, 450, 2600, 0.36); return 0.35; };
  S.error = (v) => {                               // soft "bu-bum", never harsh (it is played a lot)
    const { ac, out, t, p } = v;
    const lp = bq(ac, 'lowpass', 1600, 0.7);
    lp.connect(out);
    const o = os(ac, 'triangle', 330 * p, t, t + 0.12), g = gn(ac);
    perc(g.gain, t, 0.3, 0.004, 0.09);
    link(o, g, lp);
    const o2 = os(ac, 'triangle', 247 * p, t + 0.1, t + 0.3), g2 = gn(ac);
    perc(g2.gain, t + 0.1, 0.3, 0.004, 0.15);
    link(o2, g2, lp);
    return 0.32;
  };

  // --- internal sounds (ambience one-shots and little jingles) ---
  S.lap = (v) => {                                 // water slapping against the logs
    const { ac, k, out, t, p } = v;
    const n = nz(k, 'white', t, t + 0.5), bp = bq(ac, 'bandpass', 800 * p, 0.9), g = gn(ac);
    sweep(bp.frequency, t, 950 * p, 380 * p, 0.35);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    link(n, bp, g, out);
    const n2 = nz(k, 'brown', t, t + 0.5), lp = bq(ac, 'lowpass', 280, 0.7), g2 = gn(ac);
    perc(g2.gain, t + 0.02, 0.28, 0.06, 0.35);
    link(n2, lp, g2, out);
    return 0.5;
  };
  S.gull = (v) => {                                // "kyow-kyow" of a distant gull
    const { ac, out, t, p } = v;
    const n = 2 + (Math.random() < 0.45 ? 1 : 0) + (Math.random() < 0.2 ? 1 : 0);
    const bp = bq(ac, 'bandpass', 2000, 1.8), lp = bq(ac, 'lowpass', 4200, 0.7);
    link(bp, lp, out);
    let tt = t, base = rnd(1400, 1800) * p;
    for (let i = 0; i < n; i++) {
      const d = rnd(0.22, 0.32);
      const o = os(ac, 'sawtooth', base, tt, tt + d + 0.05), o2 = os(ac, 'sine', base, tt, tt + d + 0.05);
      o.frequency.setValueAtTime(base * 0.78, tt); o.frequency.exponentialRampToValueAtTime(base * 1.1, tt + 0.045);
      o.frequency.exponentialRampToValueAtTime(base * 0.7, tt + d);
      o2.frequency.setValueAtTime(base * 0.78, tt); o2.frequency.exponentialRampToValueAtTime(base * 1.1, tt + 0.045);
      o2.frequency.exponentialRampToValueAtTime(base * 0.7, tt + d);
      const lfo = os(ac, 'sine', rnd(20, 28), tt, tt + d + 0.05), lg = gn(ac, base * 0.025);
      lfo.connect(lg); lg.connect(o.frequency); lg.connect(o2.frequency);
      const g = gn(ac), og = gn(ac, 0.8);
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.linearRampToValueAtTime(0.6, tt + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + d);
      o.connect(g); link(o2, og, g); g.connect(bp);
      tt += d + rnd(0.05, 0.14);
      base *= rnd(0.9, 0.97);
    }
    return tt - t + 0.1;
  };
  S.creak = (v) => {
    const d = rnd(0.5, 1.2);
    creakTone(v, v.t, rnd(70, 150) * v.p, d, 0.8);
    return d + 0.1;
  };
  S.bell = (v) => {                                // ship's bell at midnight: ding-ding, ding-ding
    shipBell(v, v.t, 880 * v.p, 0.22);
    shipBell(v, v.t + 0.32, 880 * v.p, 0.2);
    shipBell(v, v.t + 1.05, 880 * v.p, 0.22);
    shipBell(v, v.t + 1.37, 880 * v.p, 0.2);
    return 3.8;
  };
  S.goal = (v) => {                                // objective done: two bright chimes
    const { t, p } = v;
    pluckTone(v, t, 659 * p, 0.16, 0.4);
    bell(v, t, 1319 * p, 0.14, 1.2);
    pluckTone(v, t + 0.13, 988 * p, 0.16, 0.5);
    bell(v, t + 0.13, 1976 * p, 0.12, 1.4);
    return 1.6;
  };
  const FANF_UP = [62, 66, 69, 74], FANF_CH = [62, 66, 69, 74, 78];
  S.fanfare = (v) => {                             // pirate ship sunk: plucked D-major flourish
    const { k, t, out } = v;
    for (let i = 0; i < FANF_UP.length; i++) pluckNote(k, out, FANF_UP[i], t + i * 0.12, 0.5, 0);
    for (let i = 0; i < FANF_CH.length; i++) pluckNote(k, out, FANF_CH[i], t + 0.55 + i * 0.012, 0.3, 0);
    bell(v, t + 0.55, 1175, 0.1, 1.5);
    return 2.6;
  };

  // --- per-sound settings: vol, ref distance, max voices, min gap, pitch variation, reverb send ---
  const SFX = Object.create(null);
  function def(name, o) {
    SFX[name] = Object.assign({ fn: S[name], vol: 1, ref: 1, max: 4, gap: 0.03, pv: 0.05, rev: 0, pri: false,
      bus: 'sfx', st: { n: 0, last: -1e9 } }, o || {});
  }
  def('pickup', { vol: 0.9, max: 3, gap: 0.05, pv: 0.03, rev: 0.05 });
  def('craft', { max: 2, gap: 0.1, pv: 0.02, rev: 0.12 });
  def('build', { ref: 1.5, max: 3, gap: 0.06 });
  def('place', { ref: 1.5, max: 3, gap: 0.06 });
  def('break_wood', { ref: 2, max: 3, gap: 0.05, pv: 0.08 });
  def('hammer', { vol: 0.9, ref: 1.5, max: 3, gap: 0.05, pv: 0.06 });
  def('splash', { vol: 1.2, ref: 1.5, max: 5, gap: 0.03, pv: 0.08 });
  def('splash_big', { ref: 3, max: 4, gap: 0.05, pv: 0.06 });
  def('hook_throw', { vol: 2.6, max: 2, gap: 0.1 });
  def('hook_land', { vol: 1.2, ref: 2, max: 3, gap: 0.05, pv: 0.08 });
  def('reel', { vol: 2.5, max: 2, gap: 0.06, pv: 0.04 });
  def('shark_bite', { ref: 3, max: 2, gap: 0.12, pv: 0.06 });
  def('hit', { ref: 1.5, max: 4, gap: 0.04, pv: 0.08 });
  def('hurt', { vol: 0.6, max: 2, gap: 0.15, pv: 0.06 });
  def('eat', { vol: 1.4, max: 1, gap: 0.3 });
  def('drink', { vol: 0.9, max: 1, gap: 0.3, pv: 0.04 });
  def('cannon', { ref: 12, max: 4, gap: 0.05, pv: 0.06, rev: 0.2, pri: true });
  def('explosion', { ref: 12, max: 4, gap: 0.05, pv: 0.08, rev: 0.25, pri: true });
  def('fish_bite', { vol: 0.9, ref: 2, max: 2, gap: 0.1, pv: 0.04 });
  def('fish_catch', { vol: 0.9, max: 2, gap: 0.2, pv: 0.02, rev: 0.08 });
  def('cast', { vol: 2.4, max: 2, gap: 0.1 });
  def('ui_click', { vol: 0.7, max: 4, gap: 0.03, pv: 0.03 });
  def('ui_open', { vol: 1.1, max: 2, gap: 0.08, pv: 0.02 });
  def('ui_close', { vol: 1.1, max: 2, gap: 0.08, pv: 0.02 });
  def('warning', { vol: 0.9, ref: 30, max: 1, gap: 0.5, pv: 0, rev: 0.2, pri: true });
  def('sail', { vol: 2.0, ref: 2, max: 2, gap: 0.2 });
  def('anchor', { vol: 1.0, ref: 2, max: 1, gap: 0.3, pv: 0.04 });
  def('sizzle', { vol: 1.25, ref: 1.5, max: 2, gap: 0.2 });
  def('bubble', { vol: 1.0, ref: 1.5, max: 3, gap: 0.08, pv: 0.1 });
  def('swim', { vol: 1.8, max: 2, gap: 0.15, pv: 0.08 });
  def('step', { vol: 1.0, ref: 1.5, max: 3, gap: 0.07, pv: 0.1 });
  def('jump', { vol: 0.95, max: 2, gap: 0.1 });
  def('death', { max: 1, gap: 1, pv: 0, rev: 0.35, pri: true });
  def('thunder', { ref: 60, max: 2, gap: 0.5, pv: 0.1, rev: 0.15, pri: true });
  def('coins', { vol: 1.1, max: 2, gap: 0.08, pv: 0.04, rev: 0.08 });
  def('sword', { vol: 1.7, ref: 2, max: 3, gap: 0.06, pv: 0.06, rev: 0.05 });
  def('pirate_yell', { vol: 0.8, ref: 3, max: 3, gap: 0.12, pv: 0.1, rev: 0.08 });
  def('whoosh', { vol: 2.2, max: 3, gap: 0.05, pv: 0.08 });
  def('error', { vol: 0.7, max: 1, gap: 0.12, pv: 0.02 });
  def('lap', { vol: 1.4, max: 3, gap: 0.2, pv: 0.12, bus: 'amb' });
  def('gull', { max: 2, gap: 1, pv: 0.08, rev: 0.3, bus: 'amb' });
  def('creak', { max: 2, gap: 0.5, pv: 0.1, bus: 'amb' });
  def('bell', { vol: 0.8, max: 1, gap: 2, pv: 0, rev: 0.35 });
  def('goal', { vol: 1.0, max: 1, gap: 0.5, pv: 0, rev: 0.2 });
  def('fanfare', { max: 1, gap: 1, pv: 0, rev: 0.2, pri: true });

  // ---------------------------------------------------------------------------
  // Positional helper: attenuation, pan and air-absorption cutoff from the camera
  // ---------------------------------------------------------------------------
  const SP = { att: 1, pan: 0, lp: 0 };
  function spatial(pos, ref) {
    SP.att = 1; SP.pan = 0; SP.lp = 0;
    const cam = G.camera;
    if (!cam || !cam.matrixWorld) return true;
    const px = +(pos.x !== undefined ? pos.x : pos[0]);
    const py = +(pos.y !== undefined ? pos.y : pos[1]);
    const pz = +(pos.z !== undefined ? pos.z : pos[2]);
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return true;
    const e = cam.matrixWorld.elements;
    const dx = px - e[12], dy = py - e[13], dz = pz - e[14];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= FAR) return false;
    let att = d <= ref ? 1 : ref / (ref + ROLLOFF * (d - ref));
    if (d > FAR - FAR_FADE) att *= (FAR - d) / FAR_FADE;
    SP.att = att;
    if (d > 0.05) {
      const rl = Math.hypot(e[0], e[1], e[2]) || 1, fl = Math.hypot(e[8], e[9], e[10]) || 1;
      const side = (dx * e[0] + dy * e[1] + dz * e[2]) / (d * rl);        // camera right = +1
      const front = -(dx * e[8] + dy * e[9] + dz * e[10]) / (d * fl);     // in front = +1
      SP.pan = side * 0.85 * Math.min(1, d / 1.5);
      let cut = 20000 / (1 + d / 16);                                     // air absorption
      if (front < 0) cut *= 1 + 0.4 * front;                              // a touch duller behind you
      SP.lp = cut < 15000 ? cut : 0;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Voices
  // ---------------------------------------------------------------------------
  function canPlay() {
    if (!ready || muted || hiddenSuspended) return false;
    const s = ctx.state;
    if (s === 'running') return true;
    // a context resumed by this very gesture is still 'suspended' for a moment: let it queue
    return s === 'suspended' && performance.now() - unlockAt < 1000;
  }

  function play(name, o) {
    const d = SFX[name];
    if (!d || !canPlay()) return false;
    const now = ctx.currentTime, st = d.st;
    if (!d.pri && (now - st.last < d.gap || st.n >= d.max || voices >= MAX_VOICES)) return false;
    let vol = d.vol;
    if (o && o.volume != null) { const x = +o.volume; vol *= Number.isFinite(x) ? Math.max(0, Math.min(x, 2)) : 1; }
    let pan = o && Number.isFinite(o.pan) ? o.pan : 0;
    let cut = o && Number.isFinite(o.lp) ? o.lp : 0;
    if (o && o.position && typeof o.position === 'object') {
      if (!spatial(o.position, d.ref)) return false;
      vol *= SP.att; pan = SP.pan;
      if (SP.lp) cut = cut ? Math.min(cut, SP.lp) : SP.lp;
    }
    if (vol < 0.003) return false;

    const out = ctx.createGain();
    out.gain.value = vol;
    let tail = out, filt = null, pn = null, send = null;
    if (cut > 0 && cut < 16000) {
      filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = cut; filt.Q.value = 0.5;
      tail.connect(filt); tail = filt;
    }
    if (pan && ctx.createStereoPanner) {
      pn = ctx.createStereoPanner(); pn.pan.value = clamp(pan, -1, 1);
      tail.connect(pn); tail = pn;
    }
    tail.connect(d.bus === 'amb' ? ambBus : sfxBus);
    if (d.rev) { send = ctx.createGain(); send.gain.value = d.rev; out.connect(send); send.connect(revIn); }

    const v = { ac: ctx, k: kit, t: now + 0.01, out, p: 1 + (Math.random() * 2 - 1) * d.pv, opts: o };
    let dur = 1;
    try { dur = d.fn(v) || 1; }
    catch (err) { disconnectAll(out, filt, pn, send); return false; }
    voices++; st.n++; st.last = now;
    setTimeout(() => { voices--; st.n--; disconnectAll(out, filt, pn, send); }, (dur + 0.3) * 1000);
    return true;
  }
  function disconnectAll(a, b, c, d) {
    try { if (a) a.disconnect(); if (b) b.disconnect(); if (c) c.disconnect(); if (d) d.disconnect(); } catch (e) { /* already gone */ }
  }

  // ---------------------------------------------------------------------------
  // Context, master bus, volume & mute
  // ---------------------------------------------------------------------------
  function volumeSetting() {
    const v = Number(G.settings && G.settings.volume);
    return Number.isFinite(v) ? clamp(v, 0, 1) : 0.8;
  }
  function musicLevel() {
    const m = G.settings ? G.settings.music : 0.5;
    if (typeof m === 'boolean') return m ? 0.6 : 0;
    const x = Number(m);
    return Number.isFinite(x) ? clamp(x, 0, 1) : 0.5;
  }
  function applyMaster() {
    if (!ready) return;
    const v = volumeSetting();
    master.gain.setTargetAtTime(muted ? 0 : v * v, ctx.currentTime, 0.05);
  }
  function setMuted(on, quiet) {
    muted = on;
    if (G.settings) { G.settings.muted = on; if (G.saveSettings) G.saveSettings(); }
    applyMaster();
    if (!quiet) G.notify(on ? 'Zvuk vypnut' : 'Zvuk zapnut', 'info');
  }

  function unlock() {
    if (failed) return;
    if (!ctx) {
      try { ctx = new AC({ latencyHint: 'interactive' }); }
      catch (e) { try { ctx = new AC(); } catch (e2) { failed = true; return; } }
      try { buildGraph(); ready = true; }
      catch (err) { failed = true; ready = false; console.error('[audio] init failed', err); return; }
    }
    if (ctx.state !== 'running' && ctx.state !== 'closed' && !document.hidden) {
      unlockAt = performance.now();
      try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
    }
  }

  function buildGraph() {
    kit = makeKit(ctx);
    master = gn(ctx, 0);
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 5;
    comp.attack.value = 0.003; comp.release.value = 0.25;
    pre = gn(ctx, 0.9);
    link(pre, comp, master, ctx.destination);
    sfxBus = gn(ctx, 1); sfxBus.connect(pre);
    ambBus = gn(ctx, 0); ambBus.connect(pre);
    musBus = gn(ctx, 0); musBus.connect(pre);
    revIn = ctx.createConvolver();
    revIn.buffer = makeIR(ctx, 2.2);
    revOut = gn(ctx, 0.55);
    link(revIn, revOut, pre);
    const musSend = gn(ctx, 0.28);
    link(musBus, musSend, revIn);
    buildAmbience();
    buildMusic();
    ready = true;
    applyMaster();
  }

  // ---------------------------------------------------------------------------
  // Ambience
  // ---------------------------------------------------------------------------
  const AMB = { seaLP: [], seaG: [] };
  let ambT = 0, ambClock = Math.random() * 100, islandT = 0, islandDist = 1e9;
  let lapT = 1.5, creakT = 6, gullT = 6;

  function buildAmbience() {
    const ac = ctx, k = kit, T0 = ac.currentTime;
    const loopSrc = (buf, rate) => {
      const s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate || 1;
      s.start(T0, Math.random() * buf.duration * 0.9); return s;
    };
    const panner = (p) => {
      if (!ac.createStereoPanner) return gn(ac, 1);
      const n = ac.createStereoPanner(); n.pan.value = p; return n;
    };
    // sea wash: two decorrelated brown-noise beds panned apart, each swelling on its own
    AMB.seaLP.length = 0; AMB.seaG.length = 0;
    for (let i = 0; i < 2; i++) {
      const lp = bq(ac, 'lowpass', 500, 0.5), g = gn(ac, 0);
      link(loopSrc(k.brown, i ? 0.93 : 1.07), lp, g, panner(i ? 0.6 : -0.6), ambBus);
      AMB.seaLP.push(lp); AMB.seaG.push(g);
    }
    // surf hiss on the crests (and on island shores)
    AMB.surfBP = bq(ac, 'bandpass', 1100, 0.6); AMB.surfG = gn(ac, 0);
    link(loopSrc(k.pink), AMB.surfBP, AMB.surfG, ambBus);
    // wind + a thin storm whistle
    AMB.windBP = bq(ac, 'bandpass', 600, 1.1); AMB.windG = gn(ac, 0);
    link(loopSrc(k.pink, 0.97), AMB.windBP, AMB.windG, ambBus);
    AMB.whBP = bq(ac, 'bandpass', 1000, 9); AMB.whG = gn(ac, 0);
    link(loopSrc(k.white, 0.97), AMB.whBP, AMB.whG, ambBus);
    // rain: bright hiss + low roar on the sea
    AMB.rainG = gn(ac, 0);
    link(loopSrc(k.white, 1.03), bq(ac, 'highpass', 1400, 0.6), bq(ac, 'lowpass', 8000, 0.6), AMB.rainG, ambBus);
    AMB.rainLowG = gn(ac, 0);
    link(loopSrc(k.pink, 0.9), bq(ac, 'lowpass', 900, 0.6), AMB.rainLowG, ambBus);
    // soft night drone (D2 A2 D3 A3, slightly detuned so it breathes)
    AMB.droneG = gn(ac, 0);
    link(AMB.droneG, bq(ac, 'lowpass', 500, 0.7), ambBus);
    const DR = [[73.42, 0.5], [110, 0.32], [147.4, 0.2], [220.5, 0.07]];
    for (let i = 0; i < DR.length; i++) {
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = DR[i][0];
      link(o, gn(ac, DR[i][1]), AMB.droneG);
      o.start(T0);
    }
  }

  function setT(param, v, tc) { param.setTargetAtTime(v, ctx.currentTime, tc || 0.12); }
  function smooth01(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function worldStorm() { const W = G.world; return W && Number.isFinite(W.storm) ? clamp(W.storm, 0, 1) : 0; }
  function worldNight() { const W = G.world; try { return !!(W && typeof W.isNight === 'function' && W.isNight()); } catch (e) { return false; } }

  function ambUpdate(dt) {
    const st = G.state, playing = st === 'playing';
    const storm = worldStorm(), night = worldNight();
    const P = G.player, R = G.raft;
    const inWater = playing && !!(P && P.inWater);
    const sail = !!(R && R.sailUp);
    ambClock += dt;

    islandT -= dt;
    if (islandT <= 0) {
      islandT = 1;
      islandDist = 1e9;
      try {
        const I = G.islands, isl = I && typeof I.nearest === 'function' ? I.nearest() : null;
        if (isl && isl.position) islandDist = Math.max(0, Math.hypot(isl.position.x, isl.position.z) - (isl.radius || 0));
      } catch (e) { /* islands optional */ }
    }

    const lvl = playing ? (G.paused ? 0.32 : 1) : st === 'menu' ? 0.85 : st === 'dead' ? 0.3 : 0;
    setT(ambBus.gain, lvl, 0.5);

    const c = ambClock;
    const sw0 = 0.5 + 0.3 * Math.sin(c * 0.61) + 0.2 * Math.sin(c * 0.237 + 1.7);
    const sw1 = 0.5 + 0.3 * Math.sin(c * 0.55 + 2.1) + 0.2 * Math.sin(c * 0.193 + 0.4);
    const seaBase = (inWater ? 0.6 : 0.34) * (1 + 0.7 * storm);
    setT(AMB.seaG[0].gain, seaBase * (0.4 + 0.6 * sw0), 0.15);
    setT(AMB.seaG[1].gain, seaBase * (0.4 + 0.6 * sw1), 0.15);
    const lpBase = (inWater ? 700 : 420) + 600 * storm;
    setT(AMB.seaLP[0].frequency, lpBase + 520 * sw0, 0.15);
    setT(AMB.seaLP[1].frequency, lpBase + 520 * sw1, 0.15);
    const crest = Math.max(0, Math.max(sw0, sw1) - 0.62) / 0.38;
    const shore = islandDist < 70 ? 1 - islandDist / 70 : 0;
    setT(AMB.surfG.gain, (0.012 + 0.05 * crest + 0.05 * shore) * (1 + 1.5 * storm) * (inWater ? 1.8 : 1));

    const gust = 0.5 + 0.3 * Math.sin(c * 0.37 + Math.sin(c * 0.11) * 2) + 0.2 * Math.sin(c * 1.3);
    setT(AMB.windG.gain, (0.03 + (sail ? 0.05 : 0) + 0.24 * storm) * (0.5 + 0.8 * gust), 0.2);
    setT(AMB.windBP.frequency, 380 + 500 * gust + 450 * storm, 0.2);
    const ws = Math.sin(c * 0.21);
    setT(AMB.whG.gain, 0.06 * storm * storm * gust + (sail ? 0.004 : 0), 0.3);
    setT(AMB.whBP.frequency, 800 + 600 * ws * ws + 300 * gust, 0.3);

    const rain = smooth01(0.15, 0.7, storm);
    setT(AMB.rainG.gain, 0.14 * rain, 0.5);
    setT(AMB.rainLowG.gain, 0.12 * rain, 0.5);

    setT(AMB.droneG.gain, night && st !== 'dead' ? 0.05 * (0.75 + 0.25 * Math.sin(c * 0.2)) : 0, 1.5);

    // music bus follows the setting; ducked while paused, silent after death
    const ml = st === 'dead' || st === 'boot' ? 0 : musicLevel() * 0.55 * (G.paused ? 0.45 : 1);
    setT(musBus.gain, ml, 0.4);
  }

  function ambEvents(dt) {
    const st = G.state;
    if (!(st === 'menu' || (st === 'playing' && !G.paused))) return;
    const storm = worldStorm();
    const inWater = st === 'playing' && !!(G.player && G.player.inWater);
    lapT -= dt * (1 + storm);
    if (lapT <= 0) {
      lapT = rnd(0.7, 2.2);
      play('lap', { volume: inWater ? rnd(0.7, 1) : rnd(0.35, 0.75), pan: rnd(-0.7, 0.7) });
    }
    creakT -= dt * (1 + 2 * storm);
    if (creakT <= 0) {
      creakT = rnd(7, 20);
      if (!inWater) play('creak', { volume: rnd(0.35, 0.7) * (1 + storm * 0.5), pan: rnd(-0.5, 0.5) });
    }
    const nearIsland = islandDist < 90;
    gullT -= dt * (nearIsland ? 2.5 : 1);
    if (gullT <= 0) {
      gullT = rnd(9, 26);
      if (!worldNight() && storm < 0.3) {
        play('gull', { volume: rnd(0.12, 0.3) * (nearIsland ? 1.5 : 1), pan: rnd(-0.85, 0.85), lp: rnd(3000, 5000) });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Music: gentle generative shanty (calm) / drums + ostinato (pirate raid)
  // ---------------------------------------------------------------------------
  const SCALE = [0, 2, 3, 5, 7, 9, 10];            // D dorian
  const ROOT = 62;                                  // D4
  const degMidi = (d) => { const o = Math.floor(d / 7); return ROOT + o * 12 + SCALE[d - o * 7]; };
  const RHYTHMS = [[[2, 1, 2, 1], 5], [[2, 1, 3], 3], [[3, 2, 1], 2], [[1, 1, 1, 2, 1], 2], [[3, 3], 1],
    [[2, 1, 1, 1, 1], 2], [[1, 1, 1, 3], 2]];
  const CLOSE_RH = [[3, 3], [2, 1, 3], [1, 1, 1, 3]];
  const PROG_A = [[0, 6, 0, 4], [0, 2, 6, 4], [0, 3, 0, 4], [0, 6, 2, 4]];   // chord roots as scale degrees
  const PROG_B = [[2, 6, 0, 4], [3, 6, 2, 4], [2, 3, 6, 4], [6, 2, 3, 4]];
  const B_KICK = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const B_SNARE = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1];
  const B_OST = [0, 0, 12, 0, 10, 0, 8, 7, 0, 0, 12, 0, 8, 7, 5, 3];
  const B_ROOTS = [0, 0, -4, -2];                  // D, D, Bb, C

  const MUS = { mode: 'off', next: 0, stepDur: 0.217, pos: 0, bar: 0, rest: 0, song: null, cur: null,
    bstep: 0, bDur: 0.234 };

  function nearestTone(prev, root) {
    let best = prev, bestScore = 1e9;
    for (let o = -7; o <= 14; o += 7) {
      for (let c = 0; c <= 4; c += 2) {
        const d = root + c + o;
        if (d < -1 || d > 10) continue;
        const s = Math.abs(d - prev) + Math.random() * 2.5 + (d === prev ? 0.8 : 0);
        if (s < bestScore) { bestScore = s; best = d; }
      }
    }
    return best;
  }
  function genBar(root, prev, closing) {
    const rh = closing ? G.pick(CLOSE_RH) : G.weighted(RHYTHMS);
    const notes = [];
    let s = 0;
    for (let i = 0; i < rh.length; i++) {
      const len = rh[i];
      let d;
      if (closing && i === rh.length - 1) d = prev >= 4 ? 7 : 0;
      else if (s === 0 || s === 3) d = nearestTone(prev, root);
      else {
        const r = Math.random();
        d = prev + (r < 0.38 ? 1 : r < 0.76 ? -1 : r < 0.86 ? 2 : r < 0.96 ? -2 : 0);
        if (d < -1) d = 1; else if (d > 10) d = 8;
      }
      if (s === 0 || Math.random() > 0.07) notes.push({ s, len, d });
      prev = d; s += len;
    }
    return { notes, last: prev };
  }
  function genPhrase(prog, prev) {
    const bars = [];
    for (let b = 0; b < 4; b++) {
      const r = genBar(prog[b], prev, false);
      bars.push({ chord: prog[b], notes: r.notes, last: r.last });
      prev = r.last;
    }
    return bars;
  }
  function makeSong() {                            // A A' B A', played twice
    const A1 = genPhrase(G.pick(PROG_A), G.pick([0, 2, 4]));
    const close = genBar(0, A1[2].last, true);
    const A2 = [A1[0], A1[1], A1[2], { chord: 0, notes: close.notes, last: close.last }];
    const B = genPhrase(G.pick(PROG_B), close.last);
    const one = A1.concat(A2, B, A2);
    return one.concat(one);
  }

  function buildMusic() {
    MUS.calm = gn(ctx, 0); MUS.calm.connect(musBus);
    MUS.battle = gn(ctx, 0); MUS.battle.connect(musBus);
    MUS.pluckC = bq(ctx, 'lowpass', 3800, 0.6); MUS.pluckC.connect(MUS.calm);
    MUS.pluckB = bq(ctx, 'lowpass', 2200, 0.8); MUS.pluckB.connect(MUS.battle);
    MUS.drums = gn(ctx, 1); MUS.drums.connect(MUS.battle);
    // accordion-ish pad: three voices of saw + slightly detuned square (musette beating)
    MUS.padG = gn(ctx, 0);
    MUS.padLP = bq(ctx, 'lowpass', 1000, 0.8);
    link(MUS.padLP, MUS.padG, MUS.calm);
    MUS.pad = [];
    for (let i = 0; i < 3; i++) {
      const a = ctx.createOscillator(), b = ctx.createOscillator();
      a.type = 'sawtooth'; b.type = 'square'; b.detune.value = 7;
      a.frequency.value = b.frequency.value = 220;
      link(a, gn(ctx, 0.5), MUS.padLP); link(b, gn(ctx, 0.22), MUS.padLP);
      a.start(); b.start();
      MUS.pad.push(a, b);
    }
    // battle drone: low saws through a dark filter
    MUS.bdG = gn(ctx, 0.05);
    MUS.bdLP = bq(ctx, 'lowpass', 320, 2);
    link(MUS.bdLP, MUS.bdG, MUS.battle);
    MUS.bd = [];
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(i ? 45 : 38);
      link(o, gn(ctx, 0.5), MUS.bdLP); o.start();
      MUS.bd.push(o);
    }
  }

  function padChord(root, t, barDur) {
    const g = MUS.padG.gain;
    if (root === null) { g.setTargetAtTime(0, t, 0.6); return; }
    for (let i = 0; i < 3; i++) {
      let m = degMidi(root + i * 2) - 12;
      while (m > 60) m -= 12;
      while (m < 48) m += 12;
      const f = mtof(m);
      MUS.pad[i * 2].frequency.setTargetAtTime(f, t, 0.03);
      MUS.pad[i * 2 + 1].frequency.setTargetAtTime(f, t, 0.03);
    }
    g.setTargetAtTime(0.07, t, 0.15);                 // bellows: push at the bar start...
    g.setTargetAtTime(0.045, t + barDur * 0.5, 0.3);  // ...ease off mid-bar
  }
  function mpluck(midi, t, vel, len, battle) {
    pluckNote(kit, battle ? MUS.pluckB : MUS.pluckC, midi, t, vel, len);
  }
  function bassMidi(root, off) { return degMidi(root + off) - 24; }

  function calmStep(t) {
    const barDur = MUS.stepDur * 6;
    if (MUS.pos === 0) {
      if (MUS.rest > 0) MUS.rest--;
      if (MUS.rest === 0 && (!MUS.song || MUS.bar >= MUS.song.length)) {
        if (MUS.song) { MUS.song = null; MUS.rest = G.randInt(10, 20); padChord(null, t, barDur); }
        else { MUS.song = makeSong(); MUS.bar = 0; MUS.stepDur = 60 / rnd(84, 98) / 3; }
      }
      MUS.cur = MUS.rest === 0 && MUS.song ? MUS.song[MUS.bar] : null;
      if (MUS.cur) padChord(MUS.cur.chord, t, MUS.stepDur * 6);
    }
    const bar = MUS.cur;
    if (bar) {
      if (MUS.pos === 0) mpluck(bassMidi(bar.chord, 0), t, 0.42, MUS.stepDur * 2.6, false);   // oom...
      else if (MUS.pos === 3) mpluck(bassMidi(bar.chord, 4), t, 0.3, MUS.stepDur * 2.2, false); // ...pah
      const ns = bar.notes;
      for (let i = 0; i < ns.length; i++) {
        const n = ns[i];
        if (n.s !== MUS.pos) continue;
        const vel = n.s === 0 ? 0.5 : n.s === 3 ? 0.42 : 0.34;
        mpluck(degMidi(n.d), t + rnd(-0.004, 0.01), vel, MUS.stepDur * n.len * 1.15, false);
      }
    }
    MUS.pos++;
    if (MUS.pos >= 6) { MUS.pos = 0; if (MUS.cur) MUS.bar++; }
  }

  const DV = { ac: null, k: null, out: null, t: 0, p: 1, opts: null };
  function drumVoice(t) { DV.ac = ctx; DV.k = kit; DV.out = MUS.drums; DV.t = t; return DV; }
  function kick(t, amp) {
    const o = os(ctx, 'sine', 140, t, t + 0.4), g = gn(ctx);
    sweep(o.frequency, t, 150, 46, 0.1);
    perc(g.gain, t, amp, 0.002, 0.3);
    link(o, g, MUS.drums);
  }
  function snare(t, amp) {
    const n = nz(kit, 'white', t, t + 0.2), bp = bq(ctx, 'bandpass', 1900, 0.9), g = gn(ctx);
    perc(g.gain, t, amp, 0.001, 0.13);
    link(n, bp, g, MUS.drums);
    const o = os(ctx, 'triangle', 185, t, t + 0.12), g2 = gn(ctx);
    perc(g2.gain, t, amp * 0.5, 0.001, 0.07);
    link(o, g2, MUS.drums);
  }
  function hat(t, amp) {
    const n = nz(kit, 'white', t, t + 0.06), hp = bq(ctx, 'highpass', 7000, 0.7), g = gn(ctx);
    perc(g.gain, t, amp, 0.0008, 0.028);
    link(n, hp, g, MUS.drums);
  }
  function taiko(t) {
    thud(drumVoice(t), t, 95, 0.6, 0.7);
    const n = nz(kit, 'brown', t, t + 0.6), lp = bq(ctx, 'lowpass', 300, 0.7), g = gn(ctx);
    perc(g.gain, t, 0.4, 0.004, 0.5);
    link(n, lp, g, MUS.drums);
  }
  function battleStep(t) {
    const i = MUS.bstep % 16, cyc = Math.floor(MUS.bstep / 16) % 4, root = B_ROOTS[cyc];
    if (B_KICK[i]) kick(t, i === 0 ? 0.85 : 0.65);
    if (B_SNARE[i]) snare(t, i === 15 ? 0.2 : 0.34);
    if (i & 1) hat(t, 0.06);
    if (i === 0 && cyc === 0) taiko(t);
    mpluck(38 + root + B_OST[i], t, i % 4 === 0 ? 0.6 : 0.42, MUS.bDur * 0.9, true);
    if (i === 0) {
      MUS.bd[0].frequency.setTargetAtTime(mtof(38 + root), t, 0.05);
      MUS.bd[1].frequency.setTargetAtTime(mtof(45 + root), t, 0.05);
    }
    MUS.bstep++;
  }

  function setMode(m) {
    const now = ctx.currentTime;
    const prev = MUS.mode;
    MUS.mode = m;
    MUS.calm.gain.setTargetAtTime(m === 'calm' ? 1 : 0, now, m === 'calm' ? 1.0 : 0.5);
    MUS.battle.gain.setTargetAtTime(m === 'battle' ? 1 : 0, now, m === 'battle' ? 0.25 : 1.5);
    MUS.next = now + 0.1;
    if (m === 'calm') {
      MUS.pos = 0; MUS.song = null; MUS.cur = null;
      MUS.rest = prev === 'battle' ? 4 : 2;         // a breath of just sea before the tune
      MUS.stepDur = 60 / 92 / 3;
    } else {
      padChord(null, now, 1);
      if (m === 'battle') { MUS.bstep = 0; MUS.bDur = 60 / 128 / 2; }
    }
  }

  function musicUpdate() {
    const st = G.state;
    const on = musicLevel() > 0.001 && (st === 'playing' || st === 'menu');
    const battle = on && st === 'playing' && !!(G.pirates && G.pirates.active);
    const mode = !on ? 'off' : battle ? 'battle' : 'calm';
    if (mode !== MUS.mode) setMode(mode);
    if (mode === 'off' || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (MUS.next < now) MUS.next = now + 0.05;      // fell behind (tab was hidden, long frame…)
    let guard = 0;
    while (MUS.next < now + 0.2 && guard++ < 16) {
      if (mode === 'calm') { calmStep(MUS.next); MUS.next += MUS.stepDur; }
      else { battleStep(MUS.next); MUS.next += MUS.bDur; }
    }
  }

  // ---------------------------------------------------------------------------
  // Offline analysis (tests / tuning): renders one SFX and measures it
  // ---------------------------------------------------------------------------
  function analyze(name, o) {
    const d = SFX[name];
    if (!d || !OAC) return Promise.resolve(null);
    const sr = 44100, secs = o.seconds || 5;
    const oc = new OAC(1, Math.ceil(sr * secs), sr);
    const k = makeKit(oc);
    const out = oc.createGain(); out.gain.value = d.vol * (o.volume != null ? o.volume : 1);
    out.connect(oc.destination);
    const v = { ac: oc, k, t: 0.01, out, p: 1, opts: o.opts || null };
    let dur = 0;
    try { dur = d.fn(v) || 1; } catch (err) { return Promise.resolve({ name, error: String(err) }); }
    return oc.startRendering().then((buf) => {
      const ch = buf.getChannelData(0);
      const n = Math.min(ch.length, Math.ceil((dur + 0.02) * sr));
      let peak = 0, sum = 0, bad = 0, tailPeak = 0;
      for (let i = 0; i < ch.length; i++) {
        const x = ch[i];
        if (!Number.isFinite(x)) { bad++; continue; }
        const a = Math.abs(x);
        if (i < n) { if (a > peak) peak = a; sum += x * x; } else if (a > tailPeak) tailPeak = a;
      }
      return { name, dur: Math.round(dur * 100) / 100, peak: Math.round(peak * 1000) / 1000,
        rms: Math.round(Math.sqrt(sum / Math.max(1, n)) * 1000) / 1000, tailPeak: Math.round(tailPeak * 1000) / 1000, bad };
    });
  }

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  function onGesture() { if (!failed && (!ctx || ctx.state !== 'running')) unlock(); }

  G.register({
    name: 'audio',
    order: 85,
    init() {
      const opt = { capture: true, passive: true };
      ['pointerdown', 'pointerup', 'mousedown', 'touchstart', 'touchend', 'keydown', 'click'].forEach((ev) => {
        window.addEventListener(ev, onGesture, opt);
      });
      document.addEventListener('visibilitychange', () => {
        if (!ctx || failed) return;
        if (document.hidden) {
          if (ctx.state === 'running') { hiddenSuspended = true; ctx.suspend().catch(() => {}); }
        } else if (hiddenSuspended) {
          hiddenSuspended = false;
          ctx.resume().catch(() => {});
        }
      });
      G.events.on('sfx', (e) => { if (e && e.name) play(e.name, e); });
      G.events.on('settings:changed', () => {
        const v = G.settings ? G.settings.volume : lastVolume;
        if (muted && v !== lastVolume && volumeSetting() > 0) setMuted(false, true);   // moving the slider unmutes
        lastVolume = v;
        applyMaster();
      });
      G.events.on('goal:done', () => play('goal', { volume: 0.8 }));
      G.events.on('pirates:sunk', () => play('fanfare', { volume: 0.8 }));
      G.events.on('world:day', () => play('bell', { volume: 0.6 }));
      G.debug.audioTest = (gap) => {                  // plays every contract SFX in turn
        unlock();
        NAMES.forEach((n, i) => setTimeout(() => play(n, {}), i * (gap || 700)));
        return NAMES.length;
      };
    },
    reset() {
      lapT = 1.5; creakT = 6; gullT = 6; islandDist = 1e9; islandT = 0;
      if (ready) { MUS.song = null; MUS.cur = null; MUS.rest = 2; MUS.pos = 0; MUS.bstep = 0; }
    },
    frame(dt) {
      if (G.input && G.input.pressed('KeyM')) setMuted(!muted);
      if (!ready || ctx.state !== 'running') return;
      ambT += dt;
      if (ambT >= 0.06) { ambUpdate(ambT); ambT = 0; }
      ambEvents(dt);
      musicUpdate();
    },
  });
})();
