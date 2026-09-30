// world.js — ocean, sky, lighting, day/night cycle, weather, the pooled particle system (G.fx)
// and the cinematic menu camera. See ../DESIGN.md §2 and §6 "world.js".
(function () {
  'use strict';

  const G = window.G;
  if (!G) return;

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const wrap = (v, p) => ((v % p) + p) % p;

  // =============================================================================================
  // Waves — a sum of directional "exponential sine" waves (sharp crests, broad troughs).
  // The ocean vertex shader evaluates exactly the same function (see OCEAN_VERT).
  // h_i = A_i * (2 * exp(sin(theta_i) - 1) - 0.93),  theta_i = k_i · (x, z) + phase_i
  // phase_i accumulates both time (-omega_i * t, waves travel along the wind) and the ground
  // motion (-k_i · groundOffset), kept modulo 2π so float precision never degrades.
  // =============================================================================================
  const WAVE_DEFS = [
    // wavelength (m), amplitude (m), heading offset from the base wind (rad), storm gain
    [38.0, 0.25, 0.00, 1.6],
    [23.5, 0.15, 0.62, 1.7],
    [14.2, 0.085, -0.80, 1.9],
    [8.7, 0.048, 1.30, 2.0],
    [5.4, 0.026, -1.90, 2.1],
    [3.3, 0.013, 2.50, 2.1],
  ];
  const NW = WAVE_DEFS.length;
  const wK = new Float64Array(NW), wKX = new Float64Array(NW), wKZ = new Float64Array(NW);
  const wA0 = new Float64Array(NW), wA = new Float64Array(NW), wW = new Float64Array(NW);
  const wPh = new Float64Array(NW), wGain = new Float64Array(NW), wOff = new Float64Array(NW);
  let ampSum = 0;
  for (let i = 0; i < NW; i++) {
    const d = WAVE_DEFS[i];
    wK[i] = TAU / d[0];
    wA0[i] = wA[i] = d[1];
    wW[i] = Math.sqrt(9.81 * wK[i]) * 0.82;
    wPh[i] = (i * 2.39996) % TAU;           // deterministic start phases (golden angle)
    wOff[i] = d[2];
    wGain[i] = d[3];
    ampSum += d[1];
  }
  function setWaveHeading(a) {
    for (let i = 0; i < NW; i++) {
      wKX[i] = Math.cos(a + wOff[i]) * wK[i];
      wKZ[i] = Math.sin(a + wOff[i]) * wK[i];
    }
  }
  setWaveHeading(0);

  function waveHeight(x, z) {
    let h = 0;
    for (let i = 0; i < NW; i++) {
      h += wA[i] * (2 * Math.exp(Math.sin(wKX[i] * x + wKZ[i] * z + wPh[i]) - 1) - 0.93);
    }
    return h;
  }

  function waveNormal(x, z, out) {
    let dx = 0, dz = 0;
    for (let i = 0; i < NW; i++) {
      const th = wKX[i] * x + wKZ[i] * z + wPh[i];
      const g = wA[i] * 2 * Math.exp(Math.sin(th) - 1) * Math.cos(th);
      dx += g * wKX[i];
      dz += g * wKZ[i];
    }
    out = out || new THREE.Vector3();
    return out.set(-dx, 1, -dz).normalize();
  }

  // =============================================================================================
  // Public API (exists at load time; three.js objects are built in init()).
  // =============================================================================================
  const sunDir = new THREE.Vector3(0, 1, 0);   // unit vector towards the sun (may be below horizon)
  const moonDir = new THREE.Vector3(0, -1, 0);
  const lightDir = new THREE.Vector3(0, 1, 0); // direction the key light comes from (sun or moon)

  const world = (G.world = {
    time: 0.30 * G.C.DAY_LENGTH,
    dayFraction: 0.30,
    day: 1,
    storm: 0,
    windDir: new THREE.Vector3(1, 0, 0),
    driftVelocity: new THREE.Vector3(-0.9, 0, 0),
    groundOffset: new THREE.Vector2(),
    sun: null,
    waveHeight,
    waveNormal,
    isNight() { return sunDir.y < -0.03; },
    // --- extras (documented in the report) ---
    sunDir,                 // unit vector towards the sun
    moonDir,                // unit vector towards the moon
    lightLevel: 1,          // ~0.2 (deep night) .. 1 (day), storm-darkened
    underwater: false,      // camera below the surface this frame
    hemi: null,             // the HemisphereLight
    stormActive() { return stormTarget > 0; },
    windAngle: 0,           // current wind heading (rad), windDir = (cos, 0, sin)
    // Shallow turquoise water around an island. `target` is an Object3D (its world position is
    // read every frame) or any {x, z} object; returns a handle for removeShallow(). Max 4 shown.
    addShallow(target, radius = 30, strength = 1) {
      const h = { target, radius, strength };
      shallows.push(h);
      return h;
    },
    removeShallow(h) {
      const i = shallows.indexOf(h);
      if (i >= 0) shallows.splice(i, 1);
    },
  });
  const shallows = [];

  // Internal state
  let windAngle0 = 0, windClock = 0;
  let stormTarget = 0, stormRemain = 0, stormCalm = 150, lightningT = 8, stormHitT = 18;
  let thunderT = -1, thunderVol = 1;
  let flash = 0, flashAge = 10, boltT = 0;
  let clock = 0;                 // cosmetic clock (all states)
  let menuAngle = 0.6, menuClock = 0;
  let occTimer = 0, rainSplashAcc = 0, bubbleT = 0;
  const scrollUV = new Float64Array(4);

  function updateWind() {
    // stays within ±25° of the initial heading, drifting over minutes
    const a = windAngle0 + 0.436 * (0.62 * Math.sin(windClock * 0.0105 + 0.4) + 0.38 * Math.sin(windClock * 0.0247 + 2.1));
    world.windAngle = a;
    world.windDir.set(Math.cos(a), 0, Math.sin(a));
  }
  function updateDrift() {
    const v = G.raft && G.raft.velocity;
    const speed = v ? Math.hypot(v.x, v.z) : 0;
    const k = -(0.9 + 0.6 * speed);
    world.driftVelocity.set(world.windDir.x * k, 0, world.windDir.z * k);
  }
  function setDayFraction(f) {
    f = wrap(f, 1);
    world.dayFraction = f;
    world.time = f * G.C.DAY_LENGTH;
  }

  // =============================================================================================
  // Palette keyframes over the sun elevation (sunDir.y). Colours are authored as display (sRGB)
  // hex values; THREE.Color stores them linear and the shaders convert back on output.
  // Dawn and dusk differ only in the twilight keys, so switching variant at noon/midnight is seamless.
  // =============================================================================================
  const KE = [-1.0, -0.30, -0.12, -0.035, 0.03, 0.10, 0.22, 0.42, 1.0];
  const cols = (arr) => arr.map((h) => new THREE.Color(h));
  const K = {
    zen: cols([0x071230, 0x0a1838, 0x142452, 0x283c72, 0x3c5f9e, 0x4a7ec2, 0x3d86d2, 0x2f7fd8, 0x2b7ad6]),
    horDusk: cols([0x132650, 0x162a52, 0x2e3a6a, 0xb85c5e, 0xf28a4e, 0xf6bf8e, 0xd4e3e6, 0xb6daed, 0xaed6ee]),
    horDawn: cols([0x132650, 0x162a52, 0x323a6c, 0xa86088, 0xf09a9c, 0xf5c9b8, 0xd4e3e6, 0xb6daed, 0xaed6ee]),
    glowDusk: cols([0x000000, 0x000000, 0x2a1030, 0xff5020, 0xff7428, 0xffa860, 0xffe6c0, 0xfff4e0, 0xfff4e0]),
    glowDawn: cols([0x000000, 0x000000, 0x2a1438, 0xff5a60, 0xff8a70, 0xffb890, 0xffe6c8, 0xfff4e0, 0xfff4e0]),
    glowI: [0, 0, 0.35, 1.0, 0.95, 0.7, 0.45, 0.35, 0.3],
    sun: cols([0xff5a20, 0xff5a20, 0xff5a20, 0xff6a2a, 0xff8a42, 0xffbe7c, 0xffe2b8, 0xfff3e2, 0xfff8ee]),
    sunI: [0, 0, 0, 0, 1.0, 1.9, 2.6, 3.0, 3.1],
    hemiSky: cols([0x7390cc, 0x7390cc, 0x6c7cb4, 0x9a7e98, 0xd2b0a8, 0xd8d6d4, 0xcfe4f6, 0xd6eaff, 0xd6eaff]),
    hemiGnd: cols([0x0e2233, 0x0e2233, 0x162637, 0x3a3440, 0x4a4a48, 0x355a58, 0x2e5a5a, 0x2e5c5c, 0x2e5c5c]),
    hemiI: [1.9, 1.9, 1.6, 1.3, 1.3, 1.45, 1.55, 1.6, 1.6],
    light: [0.22, 0.24, 0.32, 0.48, 0.64, 0.82, 0.95, 1.0, 1.0],
    deep: cols([0x05182a, 0x061c32, 0x08263e, 0x0e2c44, 0x0d3c52, 0x0a4a60, 0x0a5268, 0x09566e, 0x09566e]),
    scat: cols([0x0c3448, 0x0e384c, 0x124256, 0x1d4a58, 0x286a6e, 0x1e8a8e, 0x1ba0a4, 0x1aaeb0, 0x1aaeb0]),
    cloudLitDusk: cols([0x1a2640, 0x1f2d4c, 0x3a3d64, 0xcf7a62, 0xffac7a, 0xffd4b0, 0xfaf4ee, 0xffffff, 0xffffff]),
    cloudLitDawn: cols([0x1a2640, 0x1f2d4c, 0x3c3c68, 0xc07898, 0xffb2b2, 0xffd8cc, 0xfaf4ee, 0xffffff, 0xffffff]),
    cloudShade: cols([0x0d1528, 0x101a30, 0x222848, 0x563e5e, 0x86687e, 0xa698a8, 0xb6c3d3, 0xb2c5da, 0xb2c5da]),
  };
  const STORM = {
    zen: new THREE.Color(0x36414d), hor: new THREE.Color(0x6a7682), hemi: new THREE.Color(0x9aa6b0),
    deep: new THREE.Color(0x16323c), scat: new THREE.Color(0x2e5e62),
    cloudLit: new THREE.Color(0x5f6974), cloudShade: new THREE.Color(0x2c343c),
  };
  const UNDER_COL = new THREE.Color(0x0e5a68);
  const FLASH_COL = new THREE.Color(0xc8d4ff);
  let segI = 0, segT = 0;
  function seg(e) {
    let i = 0;
    while (i < KE.length - 2 && e > KE[i + 1]) i++;
    segI = i;
    segT = clamp((e - KE[i]) / (KE[i + 1] - KE[i]), 0, 1);
  }
  const lk = (keys, out) => out.copy(keys[segI]).lerp(keys[segI + 1], segT);
  const ln = (arr) => arr[segI] + (arr[segI + 1] - arr[segI]) * segT;

  // Shared uniforms (the same objects are referenced by several materials).
  const U = {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uGlowCol: { value: new THREE.Color() },
    uSunDir: { value: sunDir },
    uLightDir: { value: lightDir },
    uLightCol: { value: new THREE.Color() },
    uTime: { value: 0 },
    uStorm: { value: 0 },
    uUnder: { value: 0 },
    uUnderCol: { value: new THREE.Color() },
  };

  // =============================================================================================
  // GLSL
  // =============================================================================================
  const SKY_FN = /* glsl */`
    uniform vec3 uZenith;
    uniform vec3 uHorizon;
    uniform vec3 uGlowCol;
    uniform vec3 uSunDir;
    vec3 skyGradient(vec3 dir) {
      float y = max(dir.y, 0.0);
      float t = 1.0 - exp(-y * 4.2);
      vec3 c = mix(uHorizon, uZenith, clamp(t * 1.08, 0.0, 1.0));
      float sd = max(dot(dir, uSunDir), 0.0);
      float band = exp(-y * 5.0);
      c += uGlowCol * (pow(sd, 5.0) * 0.5 * band + pow(sd, 42.0) * 0.55);
      return c;
    }
  `;

  const SKY_VERT = /* glsl */`
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
    }
  `;
  const SKY_FRAG = /* glsl */`
    ${SKY_FN}
    uniform vec3 uMoonDir;
    uniform vec3 uSunDisc;
    uniform vec3 uMoonCol;
    uniform float uFlash;
    uniform vec3 uFlashCol;
    uniform vec3 uAbyss;
    uniform float uUnder;
    uniform vec3 uUnderCol;
    varying vec3 vDir;
    void main() {
      vec3 dir = normalize(vDir);
      vec3 c;
      if (uUnder > 0.5) {
        c = uUnderCol;
      } else if (dir.y < -0.06) {
        c = uAbyss;                        // only ever seen through the near, semi-transparent sea
      } else {
        c = skyGradient(dir);
        // sun disc with a soft corona
        float sd = dot(dir, uSunDir);
        if (sd > 0.99) {
          float k = (sd - 0.99) * 100.0;
          c += uSunDisc * (smoothstep(0.99955, 0.99978, sd) * 3.0 + k * k * k * k * 0.6);
        }
        // moon disc with a few darker "seas"
        float md = dot(dir, uMoonDir);
        if (md > 0.99 && uMoonCol.b > 0.001) {
          vec3 mt = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
          vec3 mb = cross(mt, uMoonDir);
          vec2 mp = vec2(dot(dir, mt), dot(dir, mb)) / 0.028;
          float disc = smoothstep(0.99955, 0.99966, md);
          float seas = smoothstep(0.42, 0.18, length(mp - vec2(0.28, 0.22))) * 0.22
                     + smoothstep(0.34, 0.12, length(mp - vec2(-0.3, -0.1))) * 0.18
                     + smoothstep(0.24, 0.08, length(mp - vec2(0.08, -0.46))) * 0.2;
          vec3 moon = uMoonCol * (1.0 - seas) * (0.82 + 0.18 * (1.0 - dot(mp, mp)));
          c = mix(c, max(c, moon), disc);   // never darker than the sky behind it
          float k = (md - 0.99) * 100.0;
          float k2 = k * k;
          float k4 = k2 * k2;
          c += uMoonCol * (k4 * k4 * 0.28 + k2 * k * 0.05);
        }
        c += uFlash * uFlashCol * (0.35 + 0.65 * max(dir.y, 0.0));
        // below the horizon: the deep water seen through the (semi-transparent) near sea surface
        c = mix(c, uAbyss, smoothstep(-0.004, -0.06, dir.y));
      }
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }
  `;

  const STAR_VERT = /* glsl */`
    attribute float aSize;
    attribute float aPhase;
    attribute vec3 aTint;
    uniform float uTime;
    uniform float uVis;
    uniform float uPx;
    varying vec3 vTint;
    varying float vA;
    void main() {
      gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
      float tw = 0.7 + 0.3 * sin(uTime * (1.3 + aPhase) + aPhase * 17.0);
      vA = uVis * tw * smoothstep(0.0, 0.2, normalize(position).y);
      vTint = aTint;
      gl_PointSize = aSize * uPx;
    }
  `;
  const STAR_FRAG = /* glsl */`
    varying vec3 vTint;
    varying float vA;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.05, d) * vA;
      if (a < 0.004) discard;
      gl_FragColor = vec4(vTint, a);
      #include <colorspace_fragment>
    }
  `;

  const CLOUD_VERT = /* glsl */`
    attribute float aStormOnly;
    attribute vec3 aCenter;
    uniform float uStorm;
    varying vec3 vWorld;
    void main() {
      float grow = aStormOnly > 0.5 ? smoothstep(0.15, 0.85, uStorm) : 1.0;
      vec4 local = instanceMatrix * vec4(position, 1.0);
      local.xyz = aCenter + (local.xyz - aCenter) * grow;
      vec4 wp = modelMatrix * local;
      wp.xz += cameraPosition.xz;
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;
  const CLOUD_FRAG = /* glsl */`
    ${SKY_FN}
    uniform vec3 uLightDir;
    uniform vec3 uCloudLit;
    uniform vec3 uCloudShade;
    uniform float uFlash;
    uniform vec3 uFlashCol;
    uniform float uUnder;
    uniform vec3 uUnderCol;
    varying vec3 vWorld;
    void main() {
      vec3 toCam = cameraPosition - vWorld;
      float dist = length(toCam);
      vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
      if (dot(N, toCam) < 0.0) N = -N;
      float lit = max(dot(N, uLightDir), 0.0);
      float up = N.y * 0.5 + 0.5;
      vec3 c = mix(uCloudShade, uCloudLit, clamp(lit * 0.65 + up * 0.45, 0.0, 1.0));
      c += uFlash * uFlashCol * 0.6;
      vec3 dir = -toCam / dist;
      float f = max(1.0 - exp(-dist * dist * 1.1e-6), smoothstep(0.1, 0.0, dir.y));
      c = mix(c, skyGradient(dir), clamp(f, 0.0, 0.9));
      c = mix(c, uUnderCol, uUnder);
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }
  `;

  const WAVE_UNIFORMS = /* glsl */`
    #define NW ${NW}
    uniform vec4 uWave[NW];      // kx, kz, amplitude, phase
    uniform float uWaveL[NW];    // wavelength
  `;
  const OCEAN_VERT = /* glsl */`
    ${SKY_FN}
    ${WAVE_UNIFORMS}
    uniform float uStep;
    uniform float uInner;
    uniform sampler2D uRaftMap;
    uniform float uDeckY;
    uniform float uFogDensity;
    uniform float uUnder;
    uniform vec3 uUnderCol;
    varying vec3 vWorld;
    varying vec2 vGrad;
    varying float vH;
    varying float vOcc;
    varying vec4 vFog;
    void main() {
      vec2 snap = floor(cameraPosition.xz / uStep + 0.5) * uStep;
      vec3 p = vec3(position.x + snap.x, 0.0, position.z + snap.y);
      float r = length(position.xz);
      float spacing = uStep + max(r - uInner, 0.0) * 0.14;
      float h = 0.0, dx = 0.0, dz = 0.0;
      for (int i = 0; i < NW; i++) {
        vec4 w = uWave[i];
        float L = uWaveL[i];
        float fade = 1.0 - smoothstep(uInner, uInner + L * 4.0 + 30.0, r);
        float th = dot(w.xy, p.xz) + w.w;
        float e = exp(sin(th) - 1.0);
        h += w.z * fade * (2.0 * e - 0.93);
        float g = w.z * 2.0 * e * cos(th) * (1.0 - smoothstep(0.2, 0.45, spacing / L));
        dx += g * w.x;
        dz += g * w.y;
      }
      vH = h;
      vGrad = vec2(dx, dz);
      // keep the water below the deck under the raft (no waves poking through the planks)
      float occ = texture2D(uRaftMap, (p.xz * 0.5 + 16.0) / 32.0).r;
      h = mix(h, min(h, uDeckY - 0.2), smoothstep(0.3, 0.62, occ));
      p.y = h;
      vWorld = p;
      vOcc = occ;
      // fog towards the sky colour at the horizon in this direction (seamless sea/sky edge)
      vec3 toCam = cameraPosition - p;
      float dist = length(toCam);
      vec3 hd = normalize(vec3(-toCam.x, 0.0, -toCam.z) + vec3(1e-5, 0.0, 0.0));
      vFog.rgb = mix(skyGradient(hd), uUnderCol, uUnder);
      vFog.a = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }
  `;
  const OCEAN_FRAG = /* glsl */`
    uniform vec3 uZenith;
    uniform vec3 uHorizon;
    uniform vec3 uGlowCol;
    uniform vec3 uSunDir;
    uniform sampler2D uNoise;
    uniform vec2 uGo;
    uniform vec4 uScroll;
    uniform vec2 uWind;
    uniform vec3 uDeep;
    uniform vec3 uScat;
    uniform vec3 uFoamCol;
    uniform vec3 uLightDir;
    uniform vec3 uLightCol;
    uniform float uSpec;
    uniform float uFoamThr;
    uniform float uAmp;
    uniform float uStorm;
    uniform float uUnder;
    uniform vec3 uUnderCol;
    uniform float uTime;
    uniform float uFlash;
    uniform vec3 uFlashCol;
    uniform vec4 uShallow[4];    // x, z, radius, strength (0 = unused)
    uniform vec3 uShallowCol;
    varying vec3 vWorld;
    varying vec2 vGrad;
    varying float vH;
    varying float vOcc;
    varying vec4 vFog;

    void main() {
      vec3 toCam = cameraPosition - vWorld;
      float dist = length(toCam);
      vec3 V = toCam / dist;
      vec2 q = vWorld.xz - uGo;

      // detail ripples: two scrolling layers of a tiling normal map (B channel = foam noise)
      vec4 n1 = texture2D(uNoise, q * 0.125 + uScroll.xy);
      vec4 n2 = texture2D(uNoise, vec2(q.x * 0.04 - q.y * 0.03, q.x * 0.03 + q.y * 0.04) + uScroll.zw);
      float near = 1.0 - clamp(dist * 0.012, 0.0, 1.0);
      vec2 dn = (n1.xy - 0.5) * (0.4 + 0.8 * near) + (n2.xy - 0.5) * 1.0;
      float detail = (0.32 + 0.25 * uStorm) * (1.0 - clamp(dist * 0.004, 0.0, 0.8));
      vec3 N = normalize(vec3(-vGrad.x * 1.5 + dn.x * detail, 1.0, -vGrad.y * 1.5 + dn.y * detail));

      vec3 col;
      float alpha;
      if (uUnder < 0.5) {
        vec3 L = uLightDir;
        float NdL = max(dot(N, L), 0.0);
        float f = 1.0 - max(dot(N, V), 0.0);
        float f2 = f * f;
        float fres = 0.02 + 0.98 * f2 * f2 * f;
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        // cheap sky reflection: gradient + sun glow
        float t = clamp(R.y * 3.2 / (1.0 + R.y * 2.3), 0.0, 1.0);
        vec3 sky = mix(uHorizon, uZenith, t);
        float sd = max(dot(R, uSunDir), 0.0);
        float sd2 = sd * sd;
        sky += uGlowCol * (sd2 * sd2 * sd * 0.5 * (1.0 - t));

        // body colour: crests and sun-backlit slopes glow turquoise (fake subsurface scattering)
        float hn = vH / uAmp;
        float bk = max(dot(-V.xz, L.xz) * 0.5 + 0.5, 0.0);
        float back = bk * bk * bk * clamp(L.y * 4.0 + 0.3, 0.0, 1.0);
        float sss = clamp(hn * 0.95 + 0.34, 0.0, 1.0) * (0.5 + 0.8 * back);
        vec3 body = mix(uDeep, uScat, clamp(sss, 0.0, 1.0));
        body *= 0.82 + 0.3 * NdL;
        body = mix(body, uDeep * 0.75, clamp(V.y, 0.0, 1.0) * 0.35);
        // shallow turquoise lagoons around islands
        float sh = 0.0;
        for (int i = 0; i < 4; i++) {
          vec4 sp = uShallow[i];
          if (sp.w > 0.0) sh = max(sh, sp.w * (1.0 - smoothstep(sp.z * 0.5, sp.z, length(vWorld.xz - sp.xy))));
        }
        body = mix(body, uShallowCol * (0.9 + 0.2 * hn), sh * 0.85);

        col = mix(body, sky, fres * 0.72);
        float rl = max(dot(R, L), 0.0);
        float s1 = pow(rl, 150.0);
        float s2 = s1 * s1;
        s2 *= s2;
        s2 *= s2;
        col += uLightCol * uSpec * (s2 * 7.0 + s1 * 0.55);

        // foam: crests, storm whitecaps streaked along the wind, and a lapping fringe around the raft
        // foam noise: fine (8 m tile) + coarse (20 m tile); foam grows into patches with holes
        float fn = n1.b * 0.6 + n2.b * 0.4;
        float crest = smoothstep(uFoamThr, uFoamThr + 0.3 * uAmp, vH);
        float ft = 0.8 - 0.24 * crest;
        float foam = (smoothstep(ft, ft + 0.035, fn) + (1.0 - smoothstep(0.0, 0.03, abs(fn - ft + 0.05))) * 0.45) * min(crest * 4.0, 1.0);
        if (uStorm > 0.01) {
          vec2 ws = vec2(dot(q, uWind), dot(q, vec2(-uWind.y, uWind.x)));
          float sn = texture2D(uNoise, ws * vec2(0.025, 0.12) + uScroll.xy * 0.4).b * 0.7 + fn * 0.3;
          float lift = smoothstep(-0.05 * uAmp, 0.4 * uAmp, vH) * uStorm;
          float st = 0.8 - 0.14 * lift;
          foam += smoothstep(st, st + 0.04, sn) * min(lift * 3.0, 1.0) * 0.85;
        }
        if (vOcc > 0.05) {
          // lacy foam lines lapping around the raft edges
          float band = smoothstep(0.12, 0.24, vOcc) * (1.0 - smoothstep(0.44, 0.52, vOcc));
          float fine = texture2D(uNoise, q * 0.42 + uScroll.zw * 2.0).b;
          float wob = 0.07 * sin(uTime * 1.9 + vWorld.x * 1.3 + vWorld.z * 0.9);
          float lace = 1.0 - smoothstep(0.0, 0.05, abs(fine - 0.5 + wob));
          foam += band * (lace * 0.8 + smoothstep(0.78, 0.82, fine + wob) * 0.6);
          col *= 1.0 - smoothstep(0.45, 0.75, vOcc) * 0.5;
        }
        foam = clamp(foam, 0.0, 1.0) * (1.0 - clamp(dist * 0.002 - 0.25, 0.0, 0.75));
        col = mix(col, uFoamCol * (0.85 + 0.25 * NdL), foam * 0.92);
        col += uFlash * uFlashCol * (0.15 + fres * 0.5);

        alpha = clamp(0.6 + fres * 0.9 + foam + dist * 0.025 + vOcc, 0.0, 1.0);
        // soft highlight roll-off so the sun glitter does not clip into flat white blobs
        col = col / (1.0 + max(max(col.r, max(col.g, col.b)) - 1.0, 0.0) * 0.5);
      } else {
        // seen from below: bright rippled ceiling, a glimpse of the sky straight up
        float up = clamp(-V.y, 0.0, 1.0);
        col = mix(uUnderCol * 1.25, uZenith * 0.8 + uLightCol * 0.12, smoothstep(0.55, 0.95, up) * (0.7 + 0.3 * dn.x));
        alpha = 0.9;
      }

      gl_FragColor = vec4(col, alpha);
      #include <colorspace_fragment>
      gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(vFog.rgb, 1.0)).rgb, vFog.a);
      gl_FragColor.a = mix(alpha, 1.0, vFog.a);
    }
  `;

  const RAIN_VERT = /* glsl */`
    attribute vec4 aSeed;
    attribute float aEnd;
    uniform float uTime;
    uniform float uRain;
    uniform vec3 uFall;
    uniform float uBox;
    uniform float uHeight;
    varying float vA;
    void main() {
      vec3 v = uFall * (0.85 + 0.3 * aSeed.w);
      float period = uHeight / -v.y;
      float t = fract(aSeed.y + uTime / period);
      vec3 base = vec3(aSeed.x * uBox, uHeight * (1.0 - t), aSeed.z * uBox) + vec3(v.x, 0.0, v.z) * t * period;
      vec3 p;
      p.xz = mod(base.xz - cameraPosition.xz + uBox * 0.5, uBox) + cameraPosition.xz - uBox * 0.5;
      p.y = base.y + cameraPosition.y - uHeight * 0.45;
      p -= normalize(v) * aEnd * (0.7 + 0.5 * aSeed.w);
      vA = (1.0 - aEnd * 0.9) * uRain * step(aSeed.w, uRain * 1.1);
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }
  `;
  const RAIN_FRAG = /* glsl */`
    uniform vec3 uRainCol;
    varying float vA;
    void main() {
      gl_FragColor = vec4(uRainCol, vA * 0.42);
      #include <colorspace_fragment>
    }
  `;

  const FX_VERT = /* glsl */`
    attribute vec3 aColor;
    attribute vec4 aParams;   // size, alpha, shape, rotation
    uniform float uScale;
    uniform float uLight;
    varying vec4 vCol;
    varying vec2 vShape;
    #include <fog_pars_vertex>
    void main() {
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      float dz = max(-mvPosition.z, 0.05);
      // cap the on-screen size (about a fifth of the screen height) and fade out particles that
      // come right up to the camera (pickup sparkles at the hand, splashes when swimming)
      gl_PointSize = min(aParams.x * uScale / dz, min(uScale * 0.36, 480.0));
      float em = step(9.5, aParams.z);
      vCol = vec4(aColor * mix(uLight, 1.0, em), aParams.y * smoothstep(0.35, 1.3, dz));
      vShape = vec2(aParams.z - em * 10.0, aParams.w);
      #include <fog_vertex>
    }
  `;
  const FX_FRAG = /* glsl */`
    varying vec4 vCol;
    varying vec2 vShape;
    #include <fog_pars_fragment>
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float a;
      float s = vShape.x;
      if (s < 0.5) {                       // soft puff
        float d = clamp(1.0 - length(c) * 2.0, 0.0, 1.0);
        a = d * d;
      } else if (s < 1.5) {                // droplet
        a = 1.0 - smoothstep(0.32, 0.5, length(c));
      } else if (s < 2.5) {                // wood chip
        float cs = cos(vShape.y), sn = sin(vShape.y);
        vec2 r = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
        a = 1.0 - smoothstep(0.2, 0.26, max(abs(r.x), abs(r.y) * 2.2));
      } else if (s < 3.5) {                // bubble ring
        float d = length(c);
        a = smoothstep(0.1, 0.0, abs(d - 0.38)) + smoothstep(0.16, 0.0, length(c - vec2(-0.12, 0.12))) * 0.8;
      } else {                             // sparkle star
        float cs = cos(vShape.y), sn = sin(vShape.y);
        vec2 r = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
        float st = max(0.0, 1.0 - abs(r.x) * 14.0) * max(0.0, 1.0 - abs(r.y) * 2.1)
                 + max(0.0, 1.0 - abs(r.y) * 14.0) * max(0.0, 1.0 - abs(r.x) * 2.1);
        a = clamp(st + smoothstep(0.22, 0.0, length(c)), 0.0, 1.0);
      }
      a *= vCol.a;
      if (a < 0.01) discard;
      gl_FragColor = vec4(vCol.rgb, a);
      #include <colorspace_fragment>
      #include <fog_fragment>
    }
  `;

  // =============================================================================================
  // Scene objects
  // =============================================================================================
  let sun = null, hemi = null, fxLight = null, fxLightPeak = 0, fxLightAge = 10;
  let sky = null, skyMat = null, stars = null, starMat = null, clouds = null, cloudMat = null;
  let ocean = null, oceanMat = null, oceanQuality = null, noiseTex = null, raftTex = null;
  let rain = null, rainMat = null, bolts = [], boltMesh = null;
  const occData = new Uint8Array(32 * 32 * 4);
  const occNext = new Uint8Array(32 * 32);

  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _cam = new THREE.Vector3();
  const _c = new THREE.Color(), _c2 = new THREE.Color();

  function mulberry(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Tileable noise: RG = detail normal (x, z), B = foam/height noise.
  function makeNoiseTexture() {
    const S = 256;
    const rnd = mulberry(1337);
    const hgt2 = new Float32Array(S * S);
    const octave = (target, cells, amp) => {
      const lat = new Float32Array(cells * cells);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      for (let y = 0; y < S; y++) {
        const fy = (y / S) * cells, iy = Math.floor(fy), ty = fy - iy;
        const sy = ty * ty * (3 - 2 * ty), y0 = iy % cells, y1 = (iy + 1) % cells;
        for (let x = 0; x < S; x++) {
          const fx = (x / S) * cells, ix = Math.floor(fx), tx = fx - ix;
          const sx = tx * tx * (3 - 2 * tx), x0 = ix % cells, x1 = (ix + 1) % cells;
          const a = lat[y0 * cells + x0], b = lat[y0 * cells + x1];
          const c = lat[y1 * cells + x0], d = lat[y1 * cells + x1];
          target[y * S + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
        }
      }
    };
    octave(hgt2, 4, 0.45); octave(hgt2, 8, 0.3); octave(hgt2, 16, 0.18); octave(hgt2, 32, 0.1);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < hgt2.length; i++) { if (hgt2[i] < lo) lo = hgt2[i]; if (hgt2[i] > hi) hi = hgt2[i]; }
    for (let i = 0; i < hgt2.length; i++) hgt2[i] = (hgt2[i] - lo) / (hi - lo);
    // Ripples: a periodic sum of sines with integer wave vectors (tiles seamlessly), mostly
    // travelling along +x (the wind axis in texture space), with sharpened crests.
    const comps = [];
    for (let n = 0; n < 56; n++) {
      const kmag = 3 + Math.pow(rnd(), 1.6) * 22;
      const ang = (rnd() - 0.5) * (rnd() < 0.75 ? 1.9 : 6.28);
      const kx = Math.round(Math.cos(ang) * kmag), ky = Math.round(Math.sin(ang) * kmag);
      if (kx === 0 && ky === 0) continue;
      comps.push([kx, ky, Math.pow(Math.hypot(kx, ky), -1.25), rnd() * TAU]);
    }
    // sin/cos(a + b) from per-column and per-row tables: only one exp() per sample and component
    const NC = comps.length;
    const cx = new Float32Array(NC * S), sx = new Float32Array(NC * S), cy = new Float32Array(NC * S), sy = new Float32Array(NC * S);
    for (let c = 0; c < NC; c++) {
      for (let i = 0; i < S; i++) {
        const a = (TAU * comps[c][0] * i) / S, b = (TAU * comps[c][1] * i) / S + comps[c][3];
        cx[c * S + i] = Math.cos(a); sx[c * S + i] = Math.sin(a);
        cy[c * S + i] = Math.cos(b); sy[c * S + i] = Math.sin(b);
      }
    }
    const gx = new Float32Array(S * S), gy = new Float32Array(S * S);
    let gmax = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let dx = 0, dy = 0;
        for (let c = 0; c < NC; c++) {
          const A = c * S + x, B = c * S + y;
          const sn = sx[A] * cy[B] + cx[A] * sy[B];
          const e = Math.exp(sn - 1) * (cx[A] * cy[B] - sx[A] * sy[B]) * comps[c][2];
          dx += e * comps[c][0];
          dy += e * comps[c][1];
        }
        gx[y * S + x] = dx; gy[y * S + x] = dy;
        const m = Math.hypot(dx, dy);
        if (m > gmax) gmax = m;
      }
    }
    const data = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      let nx = -gx[i] / gmax * 1.6, nz = -gy[i] / gmax * 1.6;
      const l = Math.hypot(nx, 1, nz);
      nx /= l; nz /= l;
      const o = i * 4;
      data[o] = Math.round(clamp(nx * 0.5 + 0.5, 0, 1) * 255);
      data[o + 1] = Math.round(clamp(nz * 0.5 + 0.5, 0, 1) * 255);
      data[o + 2] = Math.round(hgt2[i] * 255);
      data[o + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  // Ocean mesh: a uniform inner grid (snapped to its own step in the shader, so vertices never
  // swim) surrounded by rings that grow geometrically out to the horizon.
  function buildOceanGeometry(quality) {
    const low = quality === 'low';
    const step = low ? 1.2 : 0.8;
    const n = low ? 60 : 100;               // cells per side (even)
    const growth = low ? 1.2 : 1.16;
    const half = (n * step) / 2;
    const perim = 4 * n;
    const idx = (ix, iz) => iz * (n + 1) + ix;
    const border = new Int32Array(perim);
    let b = 0;
    for (let ix = 0; ix < n; ix++) border[b++] = idx(ix, 0);
    for (let iz = 0; iz < n; iz++) border[b++] = idx(n, iz);
    for (let ix = n; ix > 0; ix--) border[b++] = idx(ix, n);
    for (let iz = n; iz > 0; iz--) border[b++] = idx(0, iz);
    // ring distances
    const dists = [];
    let d = 0, dr = step;
    while (d < 1210) { dr *= growth; d += dr; dists.push(Math.min(d, 1230)); }
    const nInner = (n + 1) * (n + 1);
    const total = nInner + perim * dists.length;
    const pos = new Float32Array(total * 3);
    let v = 0;
    for (let iz = 0; iz <= n; iz++) {
      for (let ix = 0; ix <= n; ix++) { pos[v * 3] = -half + ix * step; pos[v * 3 + 2] = -half + iz * step; v++; }
    }
    const tris = (n * n + perim * dists.length) * 6;
    const index = total > 65535 ? new Uint32Array(tris) : new Uint16Array(tris);
    let t = 0;
    const tri = (a, bb, c) => {
      const ax = pos[a * 3], az = pos[a * 3 + 2];
      const ny = (pos[bb * 3 + 2] - az) * (pos[c * 3] - ax) - (pos[bb * 3] - ax) * (pos[c * 3 + 2] - az);
      if (ny >= 0) { index[t++] = a; index[t++] = bb; index[t++] = c; }
      else { index[t++] = a; index[t++] = c; index[t++] = bb; }
    };
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const a = idx(ix, iz), bx = idx(ix + 1, iz), c = idx(ix, iz + 1), dd = idx(ix + 1, iz + 1);
        tri(a, c, bx); tri(bx, c, dd);
      }
    }
    let prevStart = -1;
    for (let k = 0; k < dists.length; k++) {
      const start = v;
      for (let j = 0; j < perim; j++) {
        const bi = border[j];
        const bx = pos[bi * 3], bz = pos[bi * 3 + 2];
        const bl = Math.hypot(bx, bz);
        pos[v * 3] = (bx / bl) * (bl + dists[k]);
        pos[v * 3 + 2] = (bz / bl) * (bl + dists[k]);
        v++;
      }
      for (let j = 0; j < perim; j++) {
        const j1 = (j + 1) % perim;
        const a = prevStart < 0 ? border[j] : prevStart + j;
        const a1 = prevStart < 0 ? border[j1] : prevStart + j1;
        tri(a, a1, start + j);
        tri(a1, start + j1, start + j);
      }
      prevStart = start;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1300);
    return { geo, step, half };
  }

  function buildOcean() {
    const quality = G.settings.quality === 'low' ? 'low' : 'high';
    const built = buildOceanGeometry(quality);
    if (!oceanMat) {
      noiseTex = makeNoiseTexture();
      raftTex = new THREE.DataTexture(occData, 32, 32, THREE.RGBAFormat);
      raftTex.magFilter = THREE.LinearFilter;
      raftTex.minFilter = THREE.LinearFilter;
      raftTex.wrapS = raftTex.wrapT = THREE.ClampToEdgeWrapping;
      raftTex.needsUpdate = true;
      const waves = [];
      const lens = [];
      for (let i = 0; i < NW; i++) { waves.push(new THREE.Vector4()); lens.push(WAVE_DEFS[i][0]); }
      oceanMat = new THREE.ShaderMaterial({
        uniforms: {
          uZenith: U.uZenith, uHorizon: U.uHorizon, uGlowCol: U.uGlowCol, uSunDir: U.uSunDir,
          uLightDir: U.uLightDir, uLightCol: U.uLightCol, uTime: U.uTime, uStorm: U.uStorm,
          uUnder: U.uUnder, uUnderCol: U.uUnderCol,
          uWave: { value: waves }, uWaveL: { value: lens },
          uStep: { value: built.step }, uInner: { value: built.half * 0.96 },
          uRaftMap: { value: raftTex }, uDeckY: { value: 0.35 },
          uNoise: { value: noiseTex }, uGo: { value: new THREE.Vector2() }, uScroll: { value: new THREE.Vector4() },
          uWind: { value: new THREE.Vector2(1, 0) },
          uDeep: { value: new THREE.Color() }, uScat: { value: new THREE.Color() }, uFoamCol: { value: new THREE.Color() },
          uSpec: { value: 1 }, uFoamThr: { value: 0.4 }, uAmp: { value: ampSum },
          uFogDensity: { value: 0.0025 }, uFlash: { value: 0 }, uFlashCol: { value: FLASH_COL },
          uShallow: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
          uShallowCol: { value: new THREE.Color() },
        },
        vertexShader: OCEAN_VERT,
        fragmentShader: OCEAN_FRAG,
        transparent: true,
        depthWrite: true,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      });
    } else {
      oceanMat.uniforms.uStep.value = built.step;
      oceanMat.uniforms.uInner.value = built.half * 0.96;
    }
    if (ocean) {
      ocean.geometry.dispose();
      ocean.geometry = built.geo;
    } else {
      ocean = new THREE.Mesh(built.geo, oceanMat);
      ocean.frustumCulled = false;
      ocean.renderOrder = -1;
      ocean.name = 'ocean';
      G.scene.add(ocean);
    }
    oceanQuality = quality;
  }

  function buildSky() {
    skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: U.uZenith, uHorizon: U.uHorizon, uGlowCol: U.uGlowCol, uSunDir: U.uSunDir,
        uMoonDir: { value: moonDir }, uSunDisc: { value: new THREE.Color() }, uMoonCol: { value: new THREE.Color() },
        uFlash: { value: 0 }, uFlashCol: { value: FLASH_COL }, uAbyss: { value: new THREE.Color() },
        uUnder: U.uUnder, uUnderCol: U.uUnderCol,
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      fog: false,
    });
    sky = new THREE.Mesh(new THREE.SphereGeometry(1300, 40, 20), skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -100;
    sky.name = 'sky';
    G.scene.add(sky);
  }

  function buildStars() {
    const N = 1300;
    const rnd = mulberry(99);
    const pos = new Float32Array(N * 3), size = new Float32Array(N), phase = new Float32Array(N), tint = new Float32Array(N * 3);
    // a tilted great circle for a faint Milky Way band
    const bandN = new THREE.Vector3(0.35, 0.55, 0.76).normalize();
    for (let i = 0; i < N; i++) {
      let x, y, z;
      if (i < N * 0.35) {
        // near the band: random point on the circle, jittered
        _v.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
        _v.addScaledVector(bandN, -_v.dot(bandN)).normalize();
        _v.addScaledVector(bandN, (rnd() - 0.5) * 0.28).normalize();
        if (_v.y < -0.05) _v.y = -_v.y;
        x = _v.x; y = _v.y; z = _v.z;
      } else {
        y = rnd() * 1.05 - 0.05;
        const a = rnd() * TAU, r = Math.sqrt(1 - y * y);
        x = Math.cos(a) * r; z = Math.sin(a) * r;
      }
      pos[i * 3] = x * 1200; pos[i * 3 + 1] = y * 1200; pos[i * 3 + 2] = z * 1200;
      const big = Math.pow(rnd(), 7);
      size[i] = 1.1 + big * 2.6 + (i < N * 0.35 ? -0.3 : 0);
      phase[i] = rnd() * 3;
      const warm = rnd();
      _c.setRGB(0.85 + warm * 0.15, 0.88 + 0.1 * rnd(), 1.0 - warm * 0.2);
      tint[i * 3] = _c.r; tint[i * 3 + 1] = _c.g; tint[i * 3 + 2] = _c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
    starMat = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uVis: { value: 0 }, uPx: { value: 1 } },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    stars = new THREE.Points(geo, starMat);
    stars.frustumCulled = false;
    stars.renderOrder = -2;
    stars.name = 'stars';
    G.scene.add(stars);
  }

  function buildClouds() {
    const rnd = mulberry(4242);
    const puffs = [];
    const addCloud = (stormOnly) => {
      const ang = rnd() * TAU;
      const dist = stormOnly ? 260 + rnd() * 520 : 380 + rnd() * 560;
      const hgt = stormOnly ? 95 + rnd() * 70 : 130 + rnd() * 130;
      const W = stormOnly ? 130 + rnd() * 150 : 60 + rnd() * 90;
      const cx = Math.cos(ang) * dist, cz = Math.sin(ang) * dist;
      const tx = -Math.sin(ang), tz = Math.cos(ang);        // tangent (cloud long axis)
      const count = stormOnly ? 7 + Math.floor(rnd() * 3) : 5 + Math.floor(rnd() * 4);
      for (let i = 0; i < count; i++) {
        const u = (i / (count - 1)) * 2 - 1 + (rnd() - 0.5) * 0.25;
        const s = W * (0.2 + rnd() * 0.1) * (1 - 0.45 * Math.abs(u));
        const along = u * W * 0.5, depth = (rnd() - 0.5) * W * 0.25;
        puffs.push({
          x: cx + tx * along + Math.cos(ang) * depth, y: hgt + s * (0.15 + rnd() * 0.2) * (1 - Math.abs(u)),
          z: cz + tz * along + Math.sin(ang) * depth, s, rot: rnd() * TAU, storm: stormOnly ? 1 : 0,
          ccx: cx, ccy: hgt, ccz: cz,
        });
      }
    };
    for (let i = 0; i < 17; i++) addCloud(false);
    for (let i = 0; i < 13; i++) addCloud(true);
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const center = new Float32Array(puffs.length * 3), stormOnly = new Float32Array(puffs.length);
    cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: U.uZenith, uHorizon: U.uHorizon, uGlowCol: U.uGlowCol, uSunDir: U.uSunDir,
        uLightDir: U.uLightDir, uStorm: U.uStorm, uUnder: U.uUnder, uUnderCol: U.uUnderCol,
        uCloudLit: { value: new THREE.Color() }, uCloudShade: { value: new THREE.Color() },
        uFlash: { value: 0 }, uFlashCol: { value: FLASH_COL },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      toneMapped: false,
      fog: false,
    });
    clouds = new THREE.InstancedMesh(geo, cloudMat, puffs.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const e = new THREE.Euler();
    puffs.forEach((pf, i) => {
      e.set(0, pf.rot, 0);
      q.setFromEuler(e);
      sc.set(pf.s, pf.s * 0.58, pf.s * 0.8);
      p.set(pf.x, pf.y, pf.z);
      m.compose(p, q, sc);
      clouds.setMatrixAt(i, m);
      center[i * 3] = pf.ccx; center[i * 3 + 1] = pf.ccy; center[i * 3 + 2] = pf.ccz;
      stormOnly[i] = pf.storm;
    });
    geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(center, 3));
    geo.setAttribute('aStormOnly', new THREE.InstancedBufferAttribute(stormOnly, 1));
    clouds.instanceMatrix.needsUpdate = true;
    clouds.frustumCulled = false;
    clouds.renderOrder = -40;
    clouds.name = 'clouds';
    G.scene.add(clouds);
  }

  function buildRain() {
    const N = 2600;
    const rnd = mulberry(777);
    const seed = new Float32Array(N * 2 * 4), end = new Float32Array(N * 2), pos = new Float32Array(N * 2 * 3);
    for (let i = 0; i < N; i++) {
      const a = rnd(), b = rnd(), c = rnd(), d = rnd();
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 4;
        seed[o] = a; seed[o + 1] = b; seed[o + 2] = c; seed[o + 3] = d;
        end[i * 2 + k] = k;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    rainMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime, uRain: { value: 0 }, uFall: { value: new THREE.Vector3(0, -24, 0) },
        uBox: { value: 44 }, uHeight: { value: 26 }, uRainCol: { value: new THREE.Color(0xb8c6d4) },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    rain = new THREE.LineSegments(geo, rainMat);
    rain.frustumCulled = false;
    rain.renderOrder = 3;
    rain.visible = false;
    rain.name = 'rain';
    G.scene.add(rain);
  }

  // A few pre-built jagged lightning bolts (unit height, drawn as additive ribbons with a glow).
  function buildBolts() {
    const rnd = mulberry(31337);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      fog: false, toneMapped: false, side: THREE.DoubleSide,
    });
    for (let b = 0; b < 3; b++) {
      const pos = [], col = [];
      const ribbon = (pts, w, bright) => {
        for (let i = 0; i < pts.length - 1; i++) {
          const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
          const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
          const px = (-dy / l) * w * 0.5, py = (dx / l) * w * 0.5;
          const quad = [x0 - px, y0 - py, x0 + px, y0 + py, x1 + px, y1 + py, x1 - px, y1 - py];
          const order = [0, 1, 2, 0, 2, 3];
          for (const o of order) { pos.push(quad[o * 2], quad[o * 2 + 1], 0); col.push(bright * 0.85, bright * 0.9, bright); }
        }
      };
      const path = (x, y, segs, dropMin, dropMax, spread) => {
        const pts = [[x, y]];
        for (let i = 0; i < segs; i++) {
          y -= dropMin + rnd() * (dropMax - dropMin);
          x += (rnd() - 0.5) * spread;
          pts.push([x, Math.max(y, 0)]);
          if (y <= 0) break;
        }
        return pts;
      };
      const main = path(0, 1, 60, 0.015, 0.03, 0.035);
      ribbon(main, 0.0035, 1.0);
      ribbon(main, 0.018, 0.2);
      for (let k = 0; k < 3; k++) {
        const from = main[4 + Math.floor(rnd() * (main.length / 2))];
        const side = rnd() < 0.5 ? 1 : -1;
        const br = path(from[0], from[1], 10, 0.012, 0.025, 0.03);
        for (const pt of br) pt[0] += (from[1] - pt[1]) * side * (0.5 + rnd() * 0.3);
        ribbon(br, 0.0022, 0.75);
        ribbon(br, 0.01, 0.12);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      bolts.push(geo);
    }
    boltMesh = new THREE.Mesh(bolts[0], mat);
    boltMesh.visible = false;
    boltMesh.frustumCulled = false;
    boltMesh.renderOrder = -30;
    boltMesh.name = 'lightning';
    G.scene.add(boltMesh);
  }

  function buildLights() {
    sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.name = 'sun';
    sun.castShadow = true;
    const high = G.settings.quality !== 'low';
    sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
    const cam = sun.shadow.camera;
    cam.left = -18; cam.right = 18; cam.top = 18; cam.bottom = -18;
    cam.near = 1; cam.far = 160;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    sun.target.position.set(0, 0, 0);
    G.scene.add(sun);
    G.scene.add(sun.target);
    world.sun = sun;

    hemi = new THREE.HemisphereLight(0xd6eaff, 0x2e5c5c, 1.5);
    hemi.name = 'hemi';
    G.scene.add(hemi);
    world.hemi = hemi;

    // Pooled light for explosions: always in the scene (intensity 0) so shaders never recompile.
    fxLight = new THREE.PointLight(0xffa048, 0, 90, 2);
    fxLight.name = 'fxLight';
    G.scene.add(fxLight);

    G.scene.fog = new THREE.FogExp2(0xaed6ee, 0.0025);
  }

  // =============================================================================================
  // Particles — G.fx. Two pools (normal + additive blending) sharing one shader. Particles are
  // packed densely at the start of the buffers so only live ones are simulated and uploaded.
  // =============================================================================================
  const F_DIE_WATER = 1, F_SURFACE = 2, F_DIE_SURFACE = 4, F_WOBBLE = 8, F_WIND = 16;
  let poolN = null, poolA = null;

  function makePool(cap, additive) {
    const p = {
      cap, count: 0,
      pos: new Float32Array(cap * 3), col: new Float32Array(cap * 3), par: new Float32Array(cap * 4),
      vel: new Float32Array(cap * 3), age: new Float32Array(cap), life: new Float32Array(cap),
      s0: new Float32Array(cap), s1: new Float32Array(cap), a0: new Float32Array(cap),
      grav: new Float32Array(cap), drag: new Float32Array(cap), fin: new Float32Array(cap),
      spin: new Float32Array(cap), flags: new Uint8Array(cap),
      rPos: { start: 0, count: 0 }, rCol: { start: 0, count: 0 }, rPar: { start: 0, count: 0 },
    };
    const geo = new THREE.BufferGeometry();
    p.aPos = new THREE.BufferAttribute(p.pos, 3).setUsage(THREE.DynamicDrawUsage);
    p.aCol = new THREE.BufferAttribute(p.col, 3).setUsage(THREE.DynamicDrawUsage);
    p.aPar = new THREE.BufferAttribute(p.par, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', p.aPos);
    geo.setAttribute('aColor', p.aCol);
    geo.setAttribute('aParams', p.aPar);
    geo.setDrawRange(0, 0);
    p.geo = geo;
    p.mat = new THREE.ShaderMaterial({
      uniforms: {
        fogColor: { value: new THREE.Color() }, fogDensity: { value: 0.0025 }, fogNear: { value: 1 }, fogFar: { value: 1000 },
        uScale: { value: 400 }, uLight: { value: 1 },
      },
      vertexShader: FX_VERT,
      fragmentShader: FX_FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
      fog: true,
    });
    p.points = new THREE.Points(geo, p.mat);
    p.points.frustumCulled = false;
    p.points.renderOrder = additive ? 6 : 5;
    p.points.name = additive ? 'fxAdditive' : 'fxNormal';
    G.scene.add(p.points);
    return p;
  }

  function add(p, x, y, z, vx, vy, vz, life, s0, s1, a0, r, g, b, shape, grav, drag, fin, flags, spin) {
    if (!p) return;
    let i;
    if (p.count < p.cap) i = p.count++;
    else i = (Math.random() * p.cap) | 0;
    const i3 = i * 3, i4 = i * 4;
    p.pos[i3] = x; p.pos[i3 + 1] = y; p.pos[i3 + 2] = z;
    p.vel[i3] = vx; p.vel[i3 + 1] = vy; p.vel[i3 + 2] = vz;
    p.col[i3] = r; p.col[i3 + 1] = g; p.col[i3 + 2] = b;
    p.par[i4] = s0; p.par[i4 + 1] = 0; p.par[i4 + 2] = shape; p.par[i4 + 3] = Math.random() * TAU;
    p.age[i] = 0; p.life[i] = Math.max(0.05, life);
    p.s0[i] = s0; p.s1[i] = s1; p.a0[i] = a0;
    p.grav[i] = grav; p.drag[i] = drag; p.fin[i] = Math.max(0.001, fin);
    p.flags[i] = flags; p.spin[i] = spin;
  }

  function kill(p, i) {
    const last = --p.count;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3, i4 = i * 4, l4 = last * 4;
    for (let k = 0; k < 3; k++) {
      p.pos[i3 + k] = p.pos[l3 + k]; p.vel[i3 + k] = p.vel[l3 + k]; p.col[i3 + k] = p.col[l3 + k];
    }
    for (let k = 0; k < 4; k++) p.par[i4 + k] = p.par[l4 + k];
    p.age[i] = p.age[last]; p.life[i] = p.life[last]; p.s0[i] = p.s0[last]; p.s1[i] = p.s1[last];
    p.a0[i] = p.a0[last]; p.grav[i] = p.grav[last]; p.drag[i] = p.drag[last]; p.fin[i] = p.fin[last];
    p.flags[i] = p.flags[last]; p.spin[i] = p.spin[last];
  }

  function simulate(p, dt) {
    const dvx = world.driftVelocity.x, dvz = world.driftVelocity.z;
    const pos = p.pos, vel = p.vel, par = p.par;
    let i = 0;
    while (i < p.count) {
      const age = p.age[i] + dt;
      const life = p.life[i];
      if (age >= life) { kill(p, i); continue; }
      p.age[i] = age;
      const i3 = i * 3, i4 = i * 4, fl = p.flags[i];
      const dr = Math.max(0, 1 - p.drag[i] * dt);
      let vx = vel[i3] * dr, vy = vel[i3 + 1] * dr + p.grav[i] * dt, vz = vel[i3 + 2] * dr;
      if (fl & F_WOBBLE) {
        vx += Math.sin(age * 9 + i) * dt * 1.6;
        vz += Math.cos(age * 8 + i * 1.7) * dt * 1.6;
      }
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
      let x = pos[i3] + vx * dt, y = pos[i3 + 1] + vy * dt, z = pos[i3 + 2] + vz * dt;
      if (fl & F_WIND) { x += dvx * 0.45 * dt; z += dvz * 0.45 * dt; }
      if (fl & F_SURFACE) {
        x += dvx * dt; z += dvz * dt;
        y = waveHeight(x, z) + 0.06;
      } else if ((fl & F_DIE_WATER) && vy < 0 && y < 1.8 && y < waveHeight(x, z)) {
        kill(p, i); continue;
      } else if ((fl & F_DIE_SURFACE) && y > waveHeight(x, z) - 0.04) {
        kill(p, i); continue;
      }
      pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
      const t = age / life;
      const grow = 1 - (1 - t) * (1 - t);
      par[i4] = p.s0[i] + (p.s1[i] - p.s0[i]) * grow;
      const fin = p.fin[i];
      const fo = t < 0.45 ? 1 : 1 - smooth(0.45, 1, t);
      par[i4 + 1] = p.a0[i] * (t < fin ? t / fin : 1) * fo;
      par[i4 + 3] += p.spin[i] * dt;
      i++;
    }
    const n = p.count;
    p.geo.setDrawRange(0, n);
    if (n > 0) {
      p.rPos.count = n * 3; p.aPos.updateRanges.push(p.rPos); p.aPos.needsUpdate = true;
      p.rCol.count = n * 3; p.aCol.updateRanges.push(p.rCol); p.aCol.needsUpdate = true;
      p.rPar.count = n * 4; p.aPar.updateRanges.push(p.rPar); p.aPar.needsUpdate = true;
    }
  }

  // palette (linear) for effects
  const FXC = {
    water: new THREE.Color(0xdaf0f6), mist: new THREE.Color(0xeaf6fa), foam: new THREE.Color(0xf2fbfb),
    wood: new THREE.Color(0x9c7a50), smoke: new THREE.Color(0x8a8a88), smokeDark: new THREE.Color(0x3a3634),
    steam: new THREE.Color(0xf4f7f8), fire: new THREE.Color(0xff8a2a), fireHot: new THREE.Color(0xffd070),
    flash: new THREE.Color(0xfff2c0), spark: new THREE.Color(0xffc860), bubble: new THREE.Color(0xcff4ff),
    gold: new THREE.Color(0xffe08a), blood: new THREE.Color(0x8a0c0c), bloodCloud: new THREE.Color(0x6a1010),
  };
  const R = (a, b) => a + Math.random() * (b - a);

  function readColor(c, def) {
    if (c === undefined || c === null) return _c.copy(def);
    if (c.isColor) return _c.copy(c);
    if (typeof c === 'number' || typeof c === 'string') { _c.copy(def); try { _c.set(c); } catch (e) { /* keep default */ } return _c; }
    if (typeof c.r === 'number') return _c.setRGB(c.r, c.g, c.b);
    return _c.copy(def);
  }
  function ok(pos) { return poolN && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z); }

  const fx = (G.fx = {
    splash(pos, scale = 1) {
      if (!ok(pos)) return;
      const s = clamp(scale || 1, 0.2, 5), ss = Math.sqrt(s);
      const x = pos.x, y = pos.y, z = pos.z, W = FXC.water;
      const n = Math.round(10 + 11 * s);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, hs = R(0.3, 2.0) * ss, k = R(0.85, 1.05);
        add(poolN, x + Math.cos(a) * 0.15 * s, y + 0.05, z + Math.sin(a) * 0.15 * s,
          Math.cos(a) * hs, R(2.2, 5.0) * ss, Math.sin(a) * hs, R(0.7, 1.2),
          R(0.07, 0.15) * ss, R(0.04, 0.08) * ss, 0.95, W.r * k, W.g * k, W.b * k, 1, -11, 0.4, 0.02, F_DIE_WATER, 0);
      }
      for (let i = 0; i < 2 + Math.round(2 * s); i++) {
        add(poolN, x + R(-0.3, 0.3) * s, y + R(0.1, 0.4), z + R(-0.3, 0.3) * s, R(-0.4, 0.4), R(0.8, 1.6) * ss, R(-0.4, 0.4),
          R(0.6, 1.0), 0.5 * s, 1.5 * s, 0.35, FXC.mist.r, FXC.mist.g, FXC.mist.b, 0, -1.2, 1.5, 0.1, F_WIND, 0);
      }
      const m = 8 + Math.round(5 * s);
      for (let i = 0; i < m; i++) {
        const a = (i / m) * TAU + R(-0.2, 0.2), sp = R(0.7, 1.5) * ss;
        add(poolN, x + Math.cos(a) * 0.3 * s, y, z + Math.sin(a) * 0.3 * s, Math.cos(a) * sp, 0, Math.sin(a) * sp,
          R(1.3, 2.2), 0.35 * s, 0.9 * s, 0.55, FXC.foam.r, FXC.foam.g, FXC.foam.b, 0, 0, 1.3, 0.05, F_SURFACE, 0);
      }
    },

    debris(pos, color, count = 10) {
      if (!ok(pos)) return;
      const c = readColor(color, FXC.wood);
      const cr = c.r, cg = c.g, cb = c.b;
      const n = clamp(Math.round(count || 10), 1, 80);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, hs = R(1.0, 3.2), k = R(0.7, 1.15);
        add(poolN, pos.x + R(-0.25, 0.25), pos.y + R(0, 0.25), pos.z + R(-0.25, 0.25), Math.cos(a) * hs, R(2.5, 5.5), Math.sin(a) * hs,
          R(0.9, 1.5), R(0.12, 0.22), R(0.1, 0.18), 1, cr * k, cg * k, cb * k, 2, -14, 0.3, 0.01, F_DIE_WATER, R(-14, 14));
      }
    },

    smoke(pos, scale = 1) {
      if (!ok(pos)) return;
      const s = clamp(scale || 1, 0.1, 6), C = FXC.smoke;
      for (let i = 0; i < 2; i++) {
        const k = R(0.75, 1.1);
        add(poolN, pos.x + R(-0.12, 0.12) * s, pos.y + R(0, 0.1), pos.z + R(-0.12, 0.12) * s, R(-0.15, 0.15), R(0.6, 1.1) * Math.sqrt(s), R(-0.15, 0.15),
          R(2.0, 3.2), 0.5 * s, 1.8 * s, 0.5, C.r * k, C.g * k, C.b * k, 0, 0.25, 0.5, 0.08, F_WIND, R(-0.6, 0.6));
      }
    },

    explosion(pos, scale = 1) {
      if (!ok(pos)) return;
      const s = clamp(scale || 1, 0.2, 5), ss = Math.sqrt(s);
      const x = pos.x, y = pos.y, z = pos.z;
      // flash
      add(poolA, x, y, z, 0, 0, 0, 0.2, 4.5 * s, 7 * s, 1, FXC.flash.r, FXC.flash.g, FXC.flash.b, 0, 0, 0, 0.01, 0, 0);
      // fireballs
      for (let i = 0; i < Math.round(14 * s); i++) {
        _v.set(R(-1, 1), R(-0.3, 1), R(-1, 1)).normalize().multiplyScalar(R(1.5, 6) * ss);
        const hot = Math.random() < 0.4 ? FXC.fireHot : FXC.fire;
        add(poolN, x, y, z, _v.x, _v.y, _v.z, R(0.35, 0.8), R(0.9, 1.6) * s, R(0.2, 0.5) * s, 0.95,
          hot.r, hot.g, hot.b, 10, 2.2, 2.6, 0.02, 0, 0);
      }
      // sparks
      for (let i = 0; i < Math.round(14 * s); i++) {
        _v.set(R(-1, 1), R(0, 1.2), R(-1, 1)).normalize().multiplyScalar(R(7, 14) * ss);
        add(poolA, x, y, z, _v.x, _v.y, _v.z, R(0.5, 1.1), 0.12, 0.05, 1, FXC.spark.r, FXC.spark.g, FXC.spark.b, 1, -9.8, 0.6, 0.01, F_DIE_WATER, 0);
      }
      // smoke
      for (let i = 0; i < Math.round(10 * s); i++) {
        const k = R(0.7, 1.2);
        add(poolN, x + R(-0.5, 0.5) * s, y + R(0, 0.6) * s, z + R(-0.5, 0.5) * s, R(-1, 1) * ss, R(1, 2.6) * ss, R(-1, 1) * ss,
          R(2.5, 4.2), R(1.0, 1.6) * s, R(3.2, 4.5) * s, 0.6, FXC.smokeDark.r * k, FXC.smokeDark.g * k, FXC.smokeDark.b * k,
          0, 0.35, 0.9, 0.12, F_WIND, R(-0.5, 0.5));
      }
      fx.debris(pos, 0x4a3a2a, Math.round(8 * s));
      if (y < 1.2) fx.splash(pos, s * 1.1);
      // light
      fxLight.position.set(x, y + 0.5, z);
      fxLightPeak = 420 * s;
      fxLightAge = 0;
      fxLight.intensity = fxLightPeak;
    },

    bubbles(pos, count = 8) {
      if (!ok(pos)) return;
      const n = clamp(Math.round(count || 8), 1, 40), C = FXC.bubble;
      for (let i = 0; i < n; i++) {
        add(poolN, pos.x + R(-0.25, 0.25), pos.y + R(-0.2, 0.2), pos.z + R(-0.25, 0.25), R(-0.2, 0.2), R(0.6, 1.3), R(-0.2, 0.2),
          R(1.0, 2.2), R(0.05, 0.14), R(0.08, 0.18), 0.85, C.r, C.g, C.b, 3, 0.8, 0.8, 0.1, F_WOBBLE | F_DIE_SURFACE, 0);
      }
    },

    sparkle(pos, color) {
      if (!ok(pos)) return;
      const c = readColor(color, FXC.gold);
      const cr = c.r, cg = c.g, cb = c.b;
      for (let i = 0; i < 12; i++) {
        _v.set(R(-1, 1), R(-0.2, 1), R(-1, 1)).normalize().multiplyScalar(R(0.8, 2.4));
        const w = R(0, 0.4);
        add(poolA, pos.x, pos.y, pos.z, _v.x, _v.y, _v.z, R(0.45, 0.9), R(0.18, 0.34), 0.04, 1,
          cr + (1 - cr) * w, cg + (1 - cg) * w, cb + (1 - cb) * w, 4, -1.2, 2.2, 0.05, 0, R(-5, 5));
      }
      add(poolA, pos.x, pos.y, pos.z, 0, 0.3, 0, 0.35, 0.5, 1.1, 0.55, cr, cg, cb, 0, 0, 0, 0.05, 0, 0);
    },

    blood(pos) {
      if (!ok(pos)) return;
      const C = FXC.blood;
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * TAU, hs = R(0.4, 1.5);
        add(poolN, pos.x, pos.y, pos.z, Math.cos(a) * hs, R(1.2, 3.2), Math.sin(a) * hs, R(0.5, 0.9),
          R(0.06, 0.11), 0.05, 0.95, C.r, C.g, C.b, 1, -10, 0.3, 0.02, F_DIE_WATER, 0);
      }
      const onWater = pos.y < waveHeight(pos.x, pos.z) + 0.6;
      if (onWater) {
        const B = FXC.bloodCloud;
        for (let i = 0; i < 3; i++) {
          add(poolN, pos.x + R(-0.3, 0.3), pos.y, pos.z + R(-0.3, 0.3), R(-0.25, 0.25), 0, R(-0.25, 0.25),
            R(1.5, 2.4), 0.4, 1.4, 0.35, B.r, B.g, B.b, 0, 0, 0.8, 0.1, F_SURFACE, 0);
        }
      }
    },

    // ---- extras (not in the original contract) ----
    fire(pos, scale = 1) {
      if (!ok(pos)) return;
      const s = clamp(scale || 1, 0.1, 6);
      for (let i = 0; i < 2; i++) {
        const hot = Math.random() < 0.35 ? FXC.fireHot : FXC.fire;
        add(poolN, pos.x + R(-0.12, 0.12) * s, pos.y, pos.z + R(-0.12, 0.12) * s, R(-0.1, 0.1), R(0.9, 1.6) * Math.sqrt(s), R(-0.1, 0.1),
          R(0.35, 0.65), R(0.3, 0.45) * s, 0.06 * s, 0.9, hot.r, hot.g, hot.b, 10, 0.8, 0.8, 0.12, F_WIND, 0);
        if (Math.random() < 0.5) {
          add(poolA, pos.x, pos.y + 0.1, pos.z, 0, R(0.6, 1.0), 0, R(0.3, 0.5), 0.5 * s, 0.2 * s, 0.35,
            hot.r, hot.g * 0.8, hot.b * 0.5, 0, 0.5, 0.8, 0.1, F_WIND, 0);
        }
      }
    },
    steam(pos, scale = 1) {
      if (!ok(pos)) return;
      const s = clamp(scale || 1, 0.1, 4), C = FXC.steam;
      add(poolN, pos.x + R(-0.08, 0.08) * s, pos.y, pos.z + R(-0.08, 0.08) * s, R(-0.1, 0.1), R(0.5, 0.9) * Math.sqrt(s), R(-0.1, 0.1),
        R(1.2, 2.0), 0.2 * s, 0.9 * s, 0.38, C.r, C.g, C.b, 0, 0.2, 0.6, 0.2, F_WIND, R(-0.5, 0.5));
    },
    ripple(pos, scale = 1) {
      if (!ok(pos)) return;
      const s = clamp(scale || 1, 0.1, 4), m = 10, C = FXC.foam;
      for (let i = 0; i < m; i++) {
        const a = (i / m) * TAU, sp = 0.7 * Math.sqrt(s);
        add(poolN, pos.x + Math.cos(a) * 0.12 * s, pos.y, pos.z + Math.sin(a) * 0.12 * s, Math.cos(a) * sp, 0, Math.sin(a) * sp,
          R(0.8, 1.2), 0.12 * s, 0.3 * s, 0.5, C.r, C.g, C.b, 0, 0, 1.4, 0.05, F_SURFACE, 0);
      }
    },
    // Generic emitter for one-off effects: o = { pos, vel?, life, size, sizeEnd?, alpha?, color?, shape?
    //   ('soft'|'drop'|'chip'|'bubble'|'star'), gravity?, drag?, additive?, count?, spread?, speed? }
    emit(o) {
      if (!o || !ok(o.pos)) return;
      const shapes = { soft: 0, drop: 1, chip: 2, bubble: 3, star: 4 };
      const c = readColor(o.color, FXC.mist);
      const cr = c.r, cg = c.g, cb = c.b;
      const n = clamp(o.count || 1, 1, 200);
      for (let i = 0; i < n; i++) {
        const sp = o.speed || 0;
        _v.set(R(-1, 1), R(-1, 1), R(-1, 1)).normalize().multiplyScalar(sp);
        if (o.vel) _v.add(o.vel);
        const spread = o.spread || 0;
        add(o.additive ? poolA : poolN, o.pos.x + R(-spread, spread), o.pos.y + R(-spread, spread), o.pos.z + R(-spread, spread),
          _v.x, _v.y, _v.z, o.life || 1, o.size || 0.2, o.sizeEnd !== undefined ? o.sizeEnd : o.size || 0.2,
          o.alpha !== undefined ? o.alpha : 1, cr, cg, cb, shapes[o.shape] || 0, o.gravity || 0, o.drag || 0, 0.05, 0, 0);
      }
    },
    clear() {
      if (poolN) poolN.count = 0;
      if (poolA) poolA.count = 0;
    },
  });

  // =============================================================================================
  // Raft occupancy map (32×32 tiles around the origin) for the under-raft clamp and foam fringe.
  // =============================================================================================
  function refreshRaftMap() {
    if (!raftTex) return;
    occNext.fill(0);
    const raft = G.raft;
    const tiles = raft && raft.tiles;
    if (tiles && typeof tiles.forEach === 'function') {
      tiles.forEach((t) => {
        if (!t) return;
        const i = (t.i | 0) + 16, j = (t.j | 0) + 16;
        if (i >= 0 && i < 32 && j >= 0 && j < 32) occNext[j * 32 + i] = 255;
      });
    }
    let changed = false;
    for (let k = 0; k < 1024; k++) {
      if (occData[k * 4] !== occNext[k]) { occData[k * 4] = occNext[k]; changed = true; }
    }
    if (changed) raftTex.needsUpdate = true;
  }

  // =============================================================================================
  // Weather
  // =============================================================================================
  function startStorm(duration) {
    if (stormTarget > 0) { stormRemain = Math.max(stormRemain, duration || 0); return; }
    stormTarget = 1;
    stormRemain = duration || G.rand(60, 120);
    lightningT = G.rand(5, 10);
    stormHitT = G.rand(14, 24);
    G.events.emit('world:storm', { active: true });
  }
  function endStorm() {
    if (stormTarget === 0) return;
    stormTarget = 0;
    stormCalm = G.rand(200, 420);
    G.events.emit('world:storm', { active: false });
  }

  function strikeLightning() {
    if (!boltMesh) return;
    const ang = world.windAngle + G.rand(-1.4, 1.4) + (Math.random() < 0.5 ? 0 : Math.PI);
    const dist = G.rand(170, 480);
    G.camera.getWorldPosition(_cam);
    const bx = _cam.x + Math.cos(ang) * dist, bz = _cam.z + Math.sin(ang) * dist;
    const H = G.rand(120, 160);
    boltMesh.geometry = bolts[(Math.random() * bolts.length) | 0];
    boltMesh.position.set(bx, -1, bz);
    boltMesh.scale.set(H * (Math.random() < 0.5 ? 1 : -1), H, 1);
    boltMesh.rotation.set(0, Math.atan2(_cam.x - bx, _cam.z - bz), 0);
    boltMesh.visible = true;
    boltT = 0;
    flash = 1;
    flashAge = 0;
    thunderT = dist / 340 * 0.8 + G.rand(0.15, 0.5);
    thunderVol = clamp(1.15 - (dist - 170) / 450, 0.5, 1);
  }

  // =============================================================================================
  // Per-frame sky/light/water uniforms
  // =============================================================================================
  const cZen = U.uZenith.value, cHor = U.uHorizon.value, cGlow = U.uGlowCol.value, cLight = U.uLightCol.value;
  const cSunLight = new THREE.Color(), cHemiSky = new THREE.Color(), cHemiGnd = new THREE.Color();
  const cDeep = new THREE.Color(), cScat = new THREE.Color(), cLit = new THREE.Color(), cShade = new THREE.Color();
  const cFog = new THREE.Color(), cMoon = new THREE.Color(0xdfe8ff);
  const TILT = 0.5, MOON_TILT = 0.95;

  function updateSky() {
    const th = (world.dayFraction - 0.25) * TAU;
    const s = Math.sin(th);
    sunDir.set(Math.cos(th), s * Math.cos(TILT), s * Math.sin(TILT));
    moonDir.set(-Math.cos(th) * 0.9, -s * Math.cos(MOON_TILT), -s * Math.sin(MOON_TILT) + 0.1).normalize();
    const e = sunDir.y;
    seg(e);
    const morning = world.dayFraction < 0.5;
    lk(K.zen, cZen);
    lk(morning ? K.horDawn : K.horDusk, cHor);
    lk(morning ? K.glowDawn : K.glowDusk, cGlow).multiplyScalar(ln(K.glowI));
    lk(K.sun, cSunLight);
    let sunI = ln(K.sunI);
    lk(K.hemiSky, cHemiSky);
    lk(K.hemiGnd, cHemiGnd);
    let hemiI = ln(K.hemiI);
    let L = ln(K.light);
    lk(K.deep, cDeep);
    lk(K.scat, cScat);
    lk(morning ? K.cloudLitDawn : K.cloudLitDusk, cLit);
    lk(K.cloudShade, cShade);
    let moonI = 1.2 * smooth(-0.02, -0.2, e);

    // storm: overcast, dim, grey-green sea
    const st = world.storm;
    if (st > 0.001) {
      const k = st * 0.9, dim = 0.28 + 0.72 * L;
      cZen.lerp(_c.copy(STORM.zen).multiplyScalar(dim), k);
      cHor.lerp(_c.copy(STORM.hor).multiplyScalar(dim), k);
      cGlow.multiplyScalar(1 - k * 0.9);
      cHemiSky.lerp(_c.copy(STORM.hemi).multiplyScalar(dim), k);
      cDeep.lerp(_c.copy(STORM.deep).multiplyScalar(dim), k);
      cScat.lerp(_c.copy(STORM.scat).multiplyScalar(dim), k);
      cLit.lerp(_c.copy(STORM.cloudLit).multiplyScalar(dim), k);
      cShade.lerp(_c.copy(STORM.cloudShade).multiplyScalar(dim), k);
      sunI *= 1 - 0.72 * k;
      moonI *= 1 - 0.6 * k;
      hemiI *= 1 - 0.25 * k;
      L *= 1 - 0.3 * k;
    }
    world.lightLevel = L;

    // key light: the sun by day, the moon at night (the switch happens while both are ~0)
    if (sunI >= moonI) {
      lightDir.copy(sunDir);
      cLight.copy(cSunLight);
      sun.intensity = sunI;
      sun.color.copy(cSunLight);
      cLight.multiplyScalar(Math.min(1, sunI / 2.4 + 0.15));
    } else {
      lightDir.copy(moonDir);
      _c.setHex(0xa8c2f0);
      cLight.copy(_c).multiplyScalar(Math.min(1, moonI * 1.3));
      sun.intensity = moonI;
      sun.color.copy(_c);
    }
    if (lightDir.y < 0.05) { lightDir.y = 0.05; lightDir.normalize(); }
    sun.position.copy(lightDir).multiplyScalar(80);

    // lightning flash
    const fl = flash;
    hemi.color.copy(cHemiSky);
    hemi.groundColor.copy(cHemiGnd);
    hemi.intensity = hemiI + fl * 3.2;

    // fog = sky horizon
    cFog.copy(cHor);
    let density = 0.0024 + (1 - L) * 0.0006 + st * 0.0068;
    U.uUnderCol.value.copy(UNDER_COL).multiplyScalar(0.25 + 0.75 * L);
    if (world.underwater) { cFog.copy(U.uUnderCol.value); density = 0.085; }
    G.scene.fog.color.copy(cFog);
    G.scene.fog.density = density;

    // sky
    const su = skyMat.uniforms;
    const disc = smooth(-0.04, 0.02, e) * (1 - st * 0.95);
    su.uSunDisc.value.copy(cSunLight).multiplyScalar(disc);
    su.uMoonCol.value.copy(cMoon).multiplyScalar(smooth(0.05, -0.1, e) * (1 - st * 0.9) * 0.95);
    su.uFlash.value = fl;
    su.uAbyss.value.copy(cDeep).multiplyScalar(0.55);

    // stars
    starMat.uniforms.uVis.value = smooth(-0.02, -0.2, e) * (1 - st) * 0.95;
    starMat.uniforms.uPx.value = G.renderer.getPixelRatio();

    // clouds
    cloudMat.uniforms.uCloudLit.value.copy(cLit);
    cloudMat.uniforms.uCloudShade.value.copy(cShade);
    cloudMat.uniforms.uFlash.value = fl;

    // ocean
    const ou = oceanMat.uniforms;
    ou.uDeep.value.copy(cDeep);
    ou.uScat.value.copy(cScat);
    ou.uFoamCol.value.setRGB(0.62 + 0.28 * L, 0.74 + 0.21 * L, 0.96).multiplyScalar(0.06 + 0.94 * L * L);
    ou.uSpec.value = (1 - st * 0.75) * (sunI >= moonI ? 1 : 0.8);
    ou.uFogDensity.value = density;
    ou.uFlash.value = fl;

    // particles are dimmed at night
    const lit = 0.25 + 0.75 * L;
    if (poolN) {
      poolN.mat.uniforms.fogColor.value.copy(cFog);
      poolN.mat.uniforms.fogDensity.value = density;
      poolN.mat.uniforms.uLight.value = lit;
    }
    if (poolA) {
      poolA.mat.uniforms.fogColor.value.copy(cFog);
      poolA.mat.uniforms.fogDensity.value = density;
    }

    // rain
    const rainAmt = smooth(0.15, 0.75, st);
    rain.visible = rainAmt > 0.01 && !world.underwater;
    rainMat.uniforms.uRain.value = rainAmt;
    rainMat.uniforms.uFall.value.set(world.windDir.x * 5.5, -24, world.windDir.z * 5.5);
    rainMat.uniforms.uRainCol.value.setRGB(0.72, 0.78, 0.84).multiplyScalar(0.3 + 0.7 * L).addScalar(fl * 0.4);
  }

  function updateWaveUniforms() {
    const st = world.storm;
    U.uStorm.value = st;
    let sum = 0;
    for (let i = 0; i < NW; i++) { wA[i] = wA0[i] * (1 + st * wGain[i]); sum += wA[i]; }
    if (!oceanMat) return;
    const u = oceanMat.uniforms;
    const w = u.uWave.value;
    for (let i = 0; i < NW; i++) w[i].set(wKX[i], wKZ[i], wA[i], wPh[i]);
    u.uAmp.value = sum;
    u.uFoamThr.value = sum * (0.58 - 0.1 * st);
    u.uGo.value.set(wrap(world.groundOffset.x, 40), wrap(world.groundOffset.y, 40));
    u.uScroll.value.set(scrollUV[0], scrollUV[1], scrollUV[2], scrollUV[3]);
    u.uWind.value.set(world.windDir.x, world.windDir.z);
    u.uTime.value = clock;
    const sl = u.uShallow.value;
    for (let i = 0; i < 4; i++) {
      const h = shallows[i];
      if (!h || !h.target) { sl[i].w = 0; continue; }
      const t = h.target;
      if (t.isObject3D) { t.getWorldPosition(_v); sl[i].set(_v.x, _v.z, h.radius, h.strength); }
      else sl[i].set(t.x || 0, t.z || 0, h.radius, h.strength);
    }
    u.uShallowCol.value.setRGB(0.13, 0.72, 0.66).multiplyScalar(0.12 + 0.88 * world.lightLevel);
    const deck = G.raft && typeof G.raft.deckY === 'function' ? G.raft.deckY() : 0.35;
    u.uDeckY.value = Number.isFinite(deck) ? deck : 0.35;
  }

  // =============================================================================================
  // Module lifecycle
  // =============================================================================================
  function init() {
    buildLights();
    buildSky();
    buildStars();
    buildClouds();
    buildOcean();
    buildRain();
    buildBolts();
    poolN = makePool(1600, false);
    poolA = makePool(900, true);

    G.events.on('game:menu', () => {
      // the menu shows a calm golden afternoon; a saved game restores its own time and weather
      if (stormTarget > 0) endStorm();
      stormTarget = 0;
      world.storm = 0;
      flash = 0;
      setDayFraction(0.728);
      menuClock = 0;
    });
    G.events.on('game:start', (d) => {
      refreshRaftMap();
      if (d && d.fresh === false && stormTarget > 0) G.events.emit('world:storm', { active: true });
    });
    for (const ev of ['build:tile', 'tile:destroyed']) G.events.on(ev, () => { occTimer = 0; });
    G.events.on('settings:changed', (s) => {
      const q = s && s.quality === 'low' ? 'low' : 'high';
      if (q !== oceanQuality) {
        buildOcean();
        const size = q === 'low' ? 1024 : 2048;
        sun.shadow.mapSize.set(size, size);
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      }
    });

    G.debug.setTime = (f) => { setDayFraction(Number(f) || 0); updateSky(); };
    G.debug.storm = (on) => {
      if (on === undefined || on === true || (typeof on === 'number' && on > 0)) {
        startStorm(120);
        world.storm = typeof on === 'number' ? clamp(on, 0, 1) : 1;
      } else {
        endStorm();
        world.storm = 0;
      }
      updateWaveUniforms();
    };
    G.debug.lightning = () => strikeLightning();

    updateWind();
    updateDrift();
    updateWaveUniforms();
    updateSky();
  }

  function reset() {
    setDayFraction(0.30);
    world.day = 1;
    G.stats.days = 1;
    windAngle0 = Math.random() * TAU;
    windClock = 0;
    setWaveHeading(windAngle0);
    updateWind();
    world.groundOffset.set(0, 0);
    world.storm = 0;
    world.underwater = false;
    stormTarget = 0;
    stormRemain = 0;
    stormCalm = G.rand(60, 260);
    lightningT = 8;
    stormHitT = 18;
    thunderT = -1;
    flash = 0;
    flashAge = 10;
    rainSplashAcc = 0;
    if (boltMesh) boltMesh.visible = false;
    if (fxLight) fxLight.intensity = 0;
    fxLightAge = 10;
    fx.clear();
    shallows.length = 0;
    occTimer = 0;
    updateDrift();
    if (oceanMat) { updateWaveUniforms(); updateSky(); }
  }

  function save() {
    return {
      t: Math.round(world.time * 100) / 100,
      day: world.day,
      wind: Math.round(windAngle0 * 10000) / 10000,
      windClock: Math.round(windClock),
      storm: {
        level: Math.round(world.storm * 1000) / 1000,
        target: stormTarget,
        remain: Math.round(stormRemain),
        calm: Math.round(stormCalm),
      },
    };
  }

  function load(d) {
    if (!d || typeof d !== 'object') return;
    const num = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
    world.day = Math.max(1, Math.floor(num(d.day, 1)));
    G.stats.days = world.day;
    setDayFraction(num(d.t, 0.30 * G.C.DAY_LENGTH) / G.C.DAY_LENGTH);
    windAngle0 = num(d.wind, windAngle0);
    windClock = num(d.windClock, 0);
    setWaveHeading(windAngle0);
    updateWind();
    const s = d.storm || {};
    stormTarget = num(s.target, 0) > 0 ? 1 : 0;
    world.storm = clamp(num(s.level, 0), 0, 1);
    stormRemain = num(s.remain, stormTarget ? 60 : 0);
    stormCalm = num(s.calm, G.rand(60, 260));
    updateDrift();
    if (oceanMat) { updateWaveUniforms(); updateSky(); }
  }

  function update(dt) {
    const DAYLEN = G.C.DAY_LENGTH;
    // time of day
    world.time += dt;
    if (world.time >= DAYLEN) {
      world.time -= DAYLEN;
      world.day += 1;
      G.stats.days = world.day;
      G.events.emit('world:day', { day: world.day });
    }
    world.dayFraction = world.time / DAYLEN;

    // wind + drift
    windClock += dt;
    updateWind();
    updateDrift();

    // ground motion: the wave pattern (and detail texture) scroll with the ground
    const v = G.raft && G.raft.velocity;
    if (v && Number.isFinite(v.x) && Number.isFinite(v.z)) {
      const gx = -v.x * dt, gz = -v.z * dt;
      world.groundOffset.x += gx;
      world.groundOffset.y += gz;
      for (let i = 0; i < NW; i++) wPh[i] = wrap(wPh[i] - (wKX[i] * gx + wKZ[i] * gz), TAU);
    }

    // storms: from day 2
    if (stormTarget === 0) {
      if (world.day >= 2) {
        stormCalm -= dt;
        if (stormCalm <= 0) startStorm();
      }
    } else {
      stormRemain -= dt;
      if (stormRemain <= 0) endStorm();
    }
    const rate = stormTarget > world.storm ? 1 / 14 : 1 / 18;
    world.storm = stormTarget > world.storm ? Math.min(stormTarget, world.storm + rate * dt) : Math.max(stormTarget, world.storm - rate * dt);

    if (world.storm > 0.45) {
      lightningT -= dt;
      if (lightningT <= 0) { lightningT = G.rand(5, 13) / (0.5 + world.storm * 0.5); strikeLightning(); }
    }
    if (thunderT >= 0) {
      thunderT -= dt;
      if (thunderT < 0) G.sfx('thunder', { volume: thunderVol });
    }
    // big storm waves batter the raft edges now and then
    if (world.storm > 0.65 && G.raft && typeof G.raft.randomEdgeTile === 'function' && typeof G.raft.damageTile === 'function') {
      stormHitT -= dt;
      if (stormHitT <= 0) {
        stormHitT = G.rand(14, 24);
        const tile = G.raft.randomEdgeTile();
        if (tile) {
          if (typeof G.raft.tileCenter === 'function') {
            G.raft.tileCenter(tile, _v2);
            fx.splash(_v2, 2);
            G.sfx('splash_big', { position: _v2 });
          }
          G.raft.damageTile(tile, G.randInt(5, 9), 'storm');
        }
      }
    }
  }

  function frame(dt) {
    if (!oceanMat) return;
    clock = (clock + dt) % 3600;
    U.uTime.value = clock;

    // waves always move (menus and pause stay alive)
    for (let i = 0; i < NW; i++) wPh[i] = wrap(wPh[i] - wW[i] * dt, TAU);
    const sp = 1 + world.storm * 1.5;
    const wx = world.windDir.x, wz = world.windDir.z;
    scrollUV[0] = wrap(scrollUV[0] + dt * 0.018 * sp * wx, 1);
    scrollUV[1] = wrap(scrollUV[1] + dt * 0.018 * sp * wz, 1);
    scrollUV[2] = wrap(scrollUV[2] + dt * 0.011 * sp * -wz, 1);
    scrollUV[3] = wrap(scrollUV[3] + dt * 0.011 * sp * wx, 1);

    // clouds drift slowly across the sky (the layer turns around the camera), faster in storms
    clouds.rotation.y = (clouds.rotation.y + dt * (0.004 + world.storm * 0.01)) % TAU;

    // menu camera: slow cinematic orbit around the raft
    if (G.state === 'menu') {
      menuClock += dt;
      menuAngle = (menuAngle + dt * 0.045) % TAU;
      const ry = G.raft && G.raft.group ? G.raft.group.position.y : 0;
      const cam = G.camera;
      cam.position.set(Math.cos(menuAngle) * 11, ry + 4 + Math.sin(menuClock * 0.5) * 0.22, Math.sin(menuAngle) * 11);
      cam.lookAt(0, ry + 0.9 + Math.sin(menuClock * 0.37) * 0.08, 0);
    }

    // underwater?
    G.camera.getWorldPosition(_cam);
    const under = _cam.y < waveHeight(_cam.x, _cam.z) - 0.04;
    world.underwater = under;
    U.uUnder.value = under ? 1 : 0;

    // raft occupancy map
    occTimer -= dt;
    if (occTimer <= 0) { occTimer = 0.5; refreshRaftMap(); }

    // lightning flash envelope (a double flicker) and the bolt
    if (flashAge < 5) {
      flashAge += dt;
      const t = flashAge;
      flash = t < 0.07 ? 1 : t < 0.13 ? 0.25 : t < 0.22 ? 0.85 : Math.max(0, 0.85 * Math.exp(-(t - 0.22) * 7));
      boltT += dt;
      if (boltMesh) boltMesh.visible = boltT < 0.3 && flash > 0.2;
    } else flash = 0;

    updateWaveUniforms();
    updateSky();

    // explosion light
    if (fxLightAge < 1) {
      fxLightAge += dt;
      const k = Math.max(0, 1 - fxLightAge / 0.45);
      fxLight.intensity = fxLightPeak * k * k;
    } else if (fxLight.intensity !== 0) fxLight.intensity = 0;

    // particles (frozen while paused)
    if (!G.paused) {
      // rain dimples on the sea near the camera during storms
      if (world.storm > 0.3 && !under) {
        rainSplashAcc += dt * 45 * world.storm;
        while (rainSplashAcc >= 1) {
          rainSplashAcc -= 1;
          const a = Math.random() * TAU, r = 1.5 + Math.random() * 14;
          const x = _cam.x + Math.cos(a) * r, z = _cam.z + Math.sin(a) * r;
          const y = waveHeight(x, z);
          add(poolN, x, y + 0.02, z, 0, R(1.0, 1.8), 0, 0.35, 0.07, 0.03, 0.7, FXC.water.r, FXC.water.g, FXC.water.b, 1, -9, 0, 0.02, 0, 0);
        }
      }
      if (under) {
        bubbleT -= dt;
        if (bubbleT <= 0) {
          bubbleT = R(0.5, 1.1);
          G.camera.getWorldDirection(_v2);
          _v.copy(_cam).addScaledVector(_v2, R(0.6, 1.4));
          _v.y -= 0.3;
          fx.bubbles(_v, 3);
        }
      }
      const h = G.renderer.domElement.height || window.innerHeight;
      const scale = h / (2 * Math.tan((G.camera.fov * Math.PI) / 360));
      poolN.mat.uniforms.uScale.value = scale;
      poolA.mat.uniforms.uScale.value = scale;
      simulate(poolN, dt);
      simulate(poolA, dt);
    }
  }

  G.register({ name: 'world', order: 10, init, reset, save, load, update, frame });
})();
