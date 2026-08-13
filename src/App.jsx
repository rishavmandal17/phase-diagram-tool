import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';

/* ---------------------------------------------------------------------- */
/* Plot geometry (SVG viewBox is 0 0 700 460)                             */
/* ---------------------------------------------------------------------- */
const VB_W = 700, VB_H = 460;
const PLOT = { x0: 78, x1: 640, y0: 34, y1: 392 };
const xScale = (C) => PLOT.x0 + (C / 100) * (PLOT.x1 - PLOT.x0);
const cFromX = (x) => ((x - PLOT.x0) / (PLOT.x1 - PLOT.x0)) * 100;
const makeTScale = (tMin, tMax) => (T) =>
  PLOT.y1 - ((T - tMin) / (tMax - tMin)) * (PLOT.y1 - PLOT.y0);
const makeTFromY = (tMin, tMax) => (y) =>
  tMin + ((PLOT.y1 - y) / (PLOT.y1 - PLOT.y0)) * (tMax - tMin);

const COL_L = '#4F94C4';   // liquid
const COL_A = '#D97B3F';   // alpha phase
const COL_B = '#3F9E82';   // beta phase
const COL_LBG = '#DCEEFA'; // liquid backdrop tint
const COL_GRID = '#E4E7EB';

function lighten(hex, amt = 0.45) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r + (255 - r) * amt);
  g = Math.round(g + (255 - g) * amt);
  b = Math.round(b + (255 - b) * amt);
  return `rgb(${r},${g},${b})`;
}

/* ---------------------------------------------------------------------- */
/* Mode configuration                                                     */
/* ---------------------------------------------------------------------- */
const MODES = [
  {
    id: 'isomorphous',
    label: 'Isomorphous',
    subtitle: 'Complete solid & liquid solubility · e.g. Cu–Ni',
    elementA: 'Cu', elementB: 'Ni',
    tMin: 980, tMax: 1500,
    defaultC: 35, defaultT: 1250,
    TA: 1085, TB: 1453,
  },
  {
    id: 'eutectic-simple',
    label: 'Eutectic (negligible solubility)',
    subtitle: 'Pure A / pure B solids · e.g. Pb–Sn, simplified',
    elementA: 'Pb', elementB: 'Sn',
    tMin: 100, tMax: 350,
    defaultC: 30, defaultT: 230,
    TA: 327, TB: 232, TE: 183, CE: 61.9,
  },
  {
    id: 'eutectic-partial',
    label: 'Eutectic (partial solubility)',
    subtitle: 'α & β terminal solid solutions · e.g. Pb–Sn, realistic',
    elementA: 'Pb', elementB: 'Sn',
    tMin: 25, tMax: 350,
    defaultC: 30, defaultT: 230,
    TA: 327, TB: 232, TE: 183, CE: 61.9,
    CalphaE: 19.2, CbetaE: 97.5, CalphaRoom: 2, CbetaRoom: 99,
  },
];

/* ---------------------------------------------------------------------- */
/* Curve functions                                                        */
/* ---------------------------------------------------------------------- */
const isoLiquidus = (cfg, C) => {
  const base = cfg.TA + (cfg.TB - cfg.TA) * (C / 100);
  const gap = 55 * Math.sin((Math.PI * C) / 100);
  return base + gap * 0.5;
};
const isoSolidus = (cfg, C) => {
  const base = cfg.TA + (cfg.TB - cfg.TA) * (C / 100);
  const gap = 55 * Math.sin((Math.PI * C) / 100);
  return base - gap * 0.5;
};
function invertMonotonic(fn, T, lo, hi) {
  let a = lo, b = hi;
  const increasing = fn(hi) > fn(lo);
  for (let i = 0; i < 45; i++) {
    const m = (a + b) / 2;
    const fm = fn(m);
    if (increasing ? fm < T : fm > T) a = m; else b = m;
  }
  return (a + b) / 2;
}

const euLiquidus = (cfg, C) =>
  C <= cfg.CE
    ? cfg.TA + (cfg.TE - cfg.TA) * (C / cfg.CE)
    : cfg.TE + (cfg.TB - cfg.TE) * ((C - cfg.CE) / (100 - cfg.CE));
const euLiquidusLeftInv = (cfg, T) => cfg.CE * (T - cfg.TA) / (cfg.TE - cfg.TA);
const euLiquidusRightInv = (cfg, T) => cfg.CE + (100 - cfg.CE) * (T - cfg.TE) / (cfg.TB - cfg.TE);

const epSolidusAlpha = (cfg, C) => cfg.TA + (cfg.TE - cfg.TA) * (C / cfg.CalphaE);
const epSolidusAlphaInv = (cfg, T) => cfg.CalphaE * (T - cfg.TA) / (cfg.TE - cfg.TA);
const epSolidusBeta = (cfg, C) => cfg.TB + (cfg.TE - cfg.TB) * ((100 - C) / (100 - cfg.CbetaE));
const epSolidusBetaInv = (cfg, T) => 100 - (100 - cfg.CbetaE) * (T - cfg.TB) / (cfg.TE - cfg.TB);
const epSolvusAlphaInv = (cfg, T) =>
  cfg.CalphaE - (cfg.CalphaE - cfg.CalphaRoom) * (T - cfg.TE) / (cfg.tMin - cfg.TE);
const epSolvusBetaInv = (cfg, T) =>
  cfg.CbetaE + (cfg.CbetaRoom - cfg.CbetaE) * (T - cfg.TE) / (cfg.tMin - cfg.TE);
const epSolvusAlpha = (cfg, C) =>
  cfg.TE + (cfg.tMin - cfg.TE) * ((cfg.CalphaE - C) / (cfg.CalphaE - cfg.CalphaRoom));
const epSolvusBeta = (cfg, C) =>
  cfg.TE + (cfg.tMin - cfg.TE) * ((C - cfg.CbetaE) / (cfg.CbetaRoom - cfg.CbetaE));

/* ---------------------------------------------------------------------- */
/* Region / lever-rule computation                                        */
/* ---------------------------------------------------------------------- */
function computeStatus(mode, cfg, C0, T) {
  if (mode === 'isomorphous') {
    const Tl = isoLiquidus(cfg, C0), Ts = isoSolidus(cfg, C0);
    if (T >= Tl) return { region: 'L', phases: [{ key: 'L', label: 'Liquid', composition: C0, fraction: 1, color: COL_L }] };
    if (T <= Ts) return { region: 'α', phases: [{ key: 'alpha', label: 'α (solid solution)', composition: C0, fraction: 1, color: COL_A }] };
    const Cs = invertMonotonic((c) => isoSolidus(cfg, c), T, 0, 100);
    const Cl = invertMonotonic((c) => isoLiquidus(cfg, c), T, 0, 100);
    const fLiquid = (Cs - C0) / (Cs - Cl), fSolid = 1 - fLiquid;
    return {
      region: 'L+α', tieLine: { Cl, Cs },
      phases: [
        { key: 'L', label: 'Liquid (L)', composition: Cl, fraction: fLiquid, color: COL_L },
        { key: 'alpha', label: 'α (solid)', composition: Cs, fraction: fSolid, color: COL_A },
      ],
    };
  }

  if (mode === 'eutectic-simple') {
    const Tl = euLiquidus(cfg, C0);
    if (T >= Tl) return { region: 'L', phases: [{ key: 'L', label: 'Liquid', composition: C0, fraction: 1, color: COL_L }] };
    if (T > cfg.TE) {
      if (C0 <= cfg.CE) {
        if (C0 <= 0.05) return { region: 'α', phases: [{ key: 'alpha', label: `α (pure ${cfg.elementA})`, composition: 0, fraction: 1, color: COL_A }] };
        const Cl = euLiquidusLeftInv(cfg, T), Cs = 0;
        const fLiquid = (C0 - Cs) / (Cl - Cs), fSolid = 1 - fLiquid;
        return {
          region: 'L+α', tieLine: { Cl, Cs },
          phases: [
            { key: 'L', label: 'Liquid (L)', composition: Cl, fraction: fLiquid, color: COL_L },
            { key: 'alpha', label: `α (≈pure ${cfg.elementA})`, composition: Cs, fraction: fSolid, color: COL_A },
          ],
        };
      } else {
        if (C0 >= 99.95) return { region: 'β', phases: [{ key: 'beta', label: `β (pure ${cfg.elementB})`, composition: 100, fraction: 1, color: COL_B }] };
        const Cl = euLiquidusRightInv(cfg, T), Cs = 100;
        const fLiquid = (Cs - C0) / (Cs - Cl), fSolid = 1 - fLiquid;
        return {
          region: 'L+β', tieLine: { Cl, Cs },
          phases: [
            { key: 'L', label: 'Liquid (L)', composition: Cl, fraction: fLiquid, color: COL_L },
            { key: 'beta', label: `β (≈pure ${cfg.elementB})`, composition: Cs, fraction: fSolid, color: COL_B },
          ],
        };
      }
    }
    const fAlpha = (100 - C0) / 100, fBeta = C0 / 100;
    return {
      region: 'α+β', tieLine: { Cl: 0, Cs: 100, solidState: true },
      phases: [
        { key: 'alpha', label: `α (≈pure ${cfg.elementA})`, composition: 0, fraction: fAlpha, color: COL_A },
        { key: 'beta', label: `β (≈pure ${cfg.elementB})`, composition: 100, fraction: fBeta, color: COL_B },
      ],
    };
  }

  // eutectic-partial
  const Tl = euLiquidus(cfg, C0);
  if (T >= Tl) return { region: 'L', phases: [{ key: 'L', label: 'Liquid', composition: C0, fraction: 1, color: COL_L }] };
  if (T > cfg.TE) {
    if (C0 <= cfg.CE) {
      const c1 = epSolidusAlphaInv(cfg, T), c2 = euLiquidusLeftInv(cfg, T);
      if (C0 <= c1) return { region: 'α', phases: [{ key: 'alpha', label: 'α (solid solution)', composition: C0, fraction: 1, color: COL_A }] };
      const fLiquid = (C0 - c1) / (c2 - c1), fSolid = 1 - fLiquid;
      return {
        region: 'L+α', tieLine: { Cl: c2, Cs: c1 },
        phases: [
          { key: 'L', label: 'Liquid (L)', composition: c2, fraction: fLiquid, color: COL_L },
          { key: 'alpha', label: 'α (solid)', composition: c1, fraction: fSolid, color: COL_A },
        ],
      };
    } else {
      const c4 = epSolidusBetaInv(cfg, T), c3 = euLiquidusRightInv(cfg, T);
      if (C0 >= c4) return { region: 'β', phases: [{ key: 'beta', label: 'β (solid solution)', composition: C0, fraction: 1, color: COL_B }] };
      const fLiquid = (c4 - C0) / (c4 - c3), fSolid = 1 - fLiquid;
      return {
        region: 'L+β', tieLine: { Cl: c3, Cs: c4 },
        phases: [
          { key: 'L', label: 'Liquid (L)', composition: c3, fraction: fLiquid, color: COL_L },
          { key: 'beta', label: 'β (solid)', composition: c4, fraction: fSolid, color: COL_B },
        ],
      };
    }
  }
  const ca = epSolvusAlphaInv(cfg, T), cb = epSolvusBetaInv(cfg, T);
  if (C0 <= ca) return { region: 'α', phases: [{ key: 'alpha', label: 'α (solid solution)', composition: C0, fraction: 1, color: COL_A }] };
  if (C0 >= cb) return { region: 'β', phases: [{ key: 'beta', label: 'β (solid solution)', composition: C0, fraction: 1, color: COL_B }] };
  const fAlpha = (cb - C0) / (cb - ca), fBeta = 1 - fAlpha;
  return {
    region: 'α+β', tieLine: { Cl: ca, Cs: cb, solidState: true },
    phases: [
      { key: 'alpha', label: 'α', composition: ca, fraction: fAlpha, color: COL_A },
      { key: 'beta', label: 'β', composition: cb, fraction: fBeta, color: COL_B },
    ],
  };
}

/* proeutectic vs. eutectic-mixture split, used only for the microstructure
   panel when region === 'α+β' in a eutectic mode. Purely composition-based
   (qualitative simplification — doesn't track further solvus precipitation). */
function proeutecticSplit(mode, cfg, C0) {
  if (mode === 'eutectic-simple') {
    if (C0 < cfg.CE) {
      return { primary: 'alpha', fProEutectic: Math.max(0, Math.min(1, (cfg.CE - C0) / cfg.CE)) };
    }
    return { primary: 'beta', fProEutectic: Math.max(0, Math.min(1, (C0 - cfg.CE) / (100 - cfg.CE))) };
  }
  // eutectic-partial
  if (C0 < cfg.CE) {
    return { primary: 'alpha', fProEutectic: Math.max(0, Math.min(1, (cfg.CE - C0) / (cfg.CE - cfg.CalphaE))) };
  }
  return { primary: 'beta', fProEutectic: Math.max(0, Math.min(1, (C0 - cfg.CE) / (cfg.CbetaE - cfg.CE))) };
}

/* ---------------------------------------------------------------------- */
/* Curve sampling → SVG path                                              */
/* ---------------------------------------------------------------------- */
function pathFromFn(fn, cMin, cMax, tScale, n = 40) {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const C = cMin + ((cMax - cMin) * i) / n;
    const T = fn(C);
    d += `${i === 0 ? 'M' : 'L'} ${xScale(C).toFixed(2)} ${tScale(T).toFixed(2)} `;
  }
  return d;
}

/* ---------------------------------------------------------------------- */
/* Seeded random helpers for stable grain layout                          */
/* ---------------------------------------------------------------------- */
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function generateGrains(seed, cols, rows, w, h) {
  const rand = mulberry32(seed);
  const cw = w / cols, ch = h / rows;
  const grains = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = c * cw + cw / 2 + (rand() - 0.5) * cw * 0.55;
      const cy = r * ch + ch / 2 + (rand() - 0.5) * ch * 0.55;
      const rad = (Math.min(cw, ch) / 2) * (0.82 + rand() * 0.28);
      grains.push({ x: cx, y: cy, r: rad });
    }
  }
  return grains;
}
function seededPermutation(n, seed) {
  const arr = Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------------------------------------------------------------------- */
/* Region label positions (hand-placed per mode, in data coordinates)     */
/* ---------------------------------------------------------------------- */
const LABELS = {
  'isomorphous': [
    { text: 'L (liquid)', C: 50, T: 1478 },
    { text: 'α (solid solution)', C: 50, T: 1015 },
    { text: 'L + α', C: 50, T: 1268 },
  ],
  'eutectic-simple': [
    { text: 'L (liquid)', C: 50, T: 322 },
    { text: 'L + α', C: 18, T: 258 },
    { text: 'L + β', C: 85, T: 212 },
    { text: 'α + β (eutectic solid)', C: 50, T: 138 },
    { text: 'α', C: 3, T: 250, small: true },
    { text: 'β', C: 97, T: 210, small: true },
  ],
  'eutectic-partial': [
    { text: 'L (liquid)', C: 50, T: 322 },
    { text: 'α', C: 8, T: 195 },
    { text: 'β', C: 94, T: 195 },
    { text: 'L + α', C: 11, T: 280 },
    { text: 'L + β', C: 91, T: 280 },
    { text: 'α + β', C: 50, T: 85 },
  ],
};

/* ======================================================================== */

export default function PhaseDiagramTool() {
  const [modeId, setModeId] = useState('isomorphous');
  const cfg = useMemo(() => MODES.find((m) => m.id === modeId), [modeId]);
  const [composition, setComposition] = useState(cfg.defaultC);
  const [temperature, setTemperature] = useState(cfg.defaultT);
  const [showTieLines, setShowTieLines] = useState(true);
  const [cored, setCored] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);

  // reset sliders to sensible defaults on mode change
  useEffect(() => {
    setComposition(cfg.defaultC);
    setTemperature(cfg.defaultT);
  }, [modeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const tScale = useMemo(() => makeTScale(cfg.tMin, cfg.tMax), [cfg]);
  const tFromY = useMemo(() => makeTFromY(cfg.tMin, cfg.tMax), [cfg]);

  const status = useMemo(
    () => computeStatus(modeId, cfg, composition, temperature),
    [modeId, cfg, composition, temperature]
  );

  /* ---- dragging the crosshair handles -------------------------------- */
  useEffect(() => {
    if (!dragging) return;
    const move = (e) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const scaleX = VB_W / rect.width, scaleY = VB_H / rect.height;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const localX = (clientX - rect.left) * scaleX;
      const localY = (clientY - rect.top) * scaleY;
      if (dragging === 'C') {
        let c = cFromX(localX);
        c = Math.max(0, Math.min(100, c));
        setComposition(Math.round(c * 10) / 10);
      } else if (dragging === 'T') {
        let t = tFromY(localY);
        t = Math.max(cfg.tMin, Math.min(cfg.tMax, t));
        setTemperature(Math.round(t));
      }
    };
    const up = () => setDragging(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging, cfg, tFromY]);

  const handlePlotMouseMove = useCallback((e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = VB_W / rect.width, scaleY = VB_H / rect.height;
    const localX = (e.clientX - rect.left) * scaleX;
    const localY = (e.clientY - rect.top) * scaleY;
    if (localX < PLOT.x0 - 5 || localX > PLOT.x1 + 20 || localY < PLOT.y0 - 5 || localY > PLOT.y1 + 5) {
      setHover(null);
      return;
    }
    const c = Math.max(0, Math.min(100, cFromX(localX)));
    const t = Math.max(cfg.tMin, Math.min(cfg.tMax, tFromY(localY)));
    setHover({ x: localX, y: localY, c, t });
  }, [cfg, tFromY]);

  /* ---- curves for the current mode ------------------------------------ */
  const curves = useMemo(() => {
    const list = [];
    if (modeId === 'isomorphous') {
      list.push({ d: pathFromFn((c) => isoLiquidus(cfg, c), 0, 100, tScale), key: 'liquidus' });
      list.push({ d: pathFromFn((c) => isoSolidus(cfg, c), 0, 100, tScale), key: 'solidus' });
    } else if (modeId === 'eutectic-simple') {
      list.push({ d: pathFromFn((c) => euLiquidus(cfg, c), 0, cfg.CE, tScale), key: 'liquidus-l' });
      list.push({ d: pathFromFn((c) => euLiquidus(cfg, c), cfg.CE, 100, tScale), key: 'liquidus-r' });
      list.push({ d: `M ${xScale(0)} ${tScale(cfg.TA)} L ${xScale(0)} ${tScale(cfg.TE)}`, key: 'solidus-a' });
      list.push({ d: `M ${xScale(100)} ${tScale(cfg.TB)} L ${xScale(100)} ${tScale(cfg.TE)}`, key: 'solidus-b' });
      list.push({ d: `M ${xScale(0)} ${tScale(cfg.TE)} L ${xScale(100)} ${tScale(cfg.TE)}`, key: 'eutectic-iso', dashed: true });
    } else {
      list.push({ d: pathFromFn((c) => euLiquidus(cfg, c), 0, cfg.CE, tScale), key: 'liquidus-l' });
      list.push({ d: pathFromFn((c) => euLiquidus(cfg, c), cfg.CE, 100, tScale), key: 'liquidus-r' });
      list.push({ d: pathFromFn((c) => epSolidusAlpha(cfg, c), 0, cfg.CalphaE, tScale), key: 'solidus-a' });
      list.push({ d: pathFromFn((c) => epSolidusBeta(cfg, c), cfg.CbetaE, 100, tScale), key: 'solidus-b' });
      list.push({ d: pathFromFn((c) => epSolvusAlpha(cfg, c), cfg.CalphaRoom, cfg.CalphaE, tScale), key: 'solvus-a' });
      list.push({ d: pathFromFn((c) => epSolvusBeta(cfg, c), cfg.CbetaE, cfg.CbetaRoom, tScale), key: 'solvus-b' });
      list.push({ d: `M ${xScale(cfg.CalphaE)} ${tScale(cfg.TE)} L ${xScale(cfg.CbetaE)} ${tScale(cfg.TE)}`, key: 'eutectic-iso', dashed: true });
    }
    return list;
  }, [modeId, cfg, tScale]);

  /* ---- grain layout (stable per mode) ---------------------------------- */
  const grains = useMemo(() => generateGrains(modeId.length * 7 + 11, 9, 7, 300, 300), [modeId]);
  const order = useMemo(() => seededPermutation(grains.length, modeId.length * 3 + 5), [grains.length, modeId]);

  const yAxisTicks = useMemo(() => {
    const span = cfg.tMax - cfg.tMin;
    const step = span > 400 ? 100 : span > 150 ? 50 : 25;
    const ticks = [];
    let t = Math.ceil(cfg.tMin / step) * step;
    for (; t <= cfg.tMax; t += step) ticks.push(t);
    return ticks;
  }, [cfg]);

  const tieLine = showTieLines ? status.tieLine : null;

  return (
    <div className="w-full min-h-screen bg-slate-50 p-4 text-slate-800">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-xl font-bold mb-1">Binary Alloy Phase Diagrams & Microstructure</h1>
        <p className="text-sm text-slate-500 mb-3">
          Explore the lever rule, tie lines, and how microstructure evolves across three idealized binary systems.
        </p>

        {/* Mode tabs */}
        <div className="flex flex-wrap gap-2 mb-3">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setModeId(m.id)}
              className={`px-3 py-2 rounded-lg text-sm font-medium border transition ${
                modeId === m.id
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500 mb-4">
          {cfg.subtitle}
          {cfg.TE ? ` · Eutectic point: ${cfg.CE}% ${cfg.elementB}, ${cfg.TE} °C` : ''}
        </p>

        <div className="flex flex-col lg:flex-row gap-4">
          {/* ------------------------- Phase diagram ------------------------- */}
          <div className="flex-1 bg-white rounded-xl shadow-sm border border-slate-200 p-3">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${VB_W} ${VB_H}`}
              className="w-full h-auto select-none"
              onMouseMove={handlePlotMouseMove}
              onMouseLeave={() => setHover(null)}
            >
              <defs>
                <pattern id="eutecticPattern" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                  <rect width="6" height="6" fill={COL_A} />
                  <rect width="3" height="6" fill={COL_B} />
                </pattern>
                <radialGradient id="coredAlpha" cx="50%" cy="50%" r="55%">
                  <stop offset="0%" stopColor={lighten(COL_A, 0.55)} />
                  <stop offset="70%" stopColor={COL_A} />
                  <stop offset="100%" stopColor={lighten(COL_A, -0.1)} />
                </radialGradient>
              </defs>

              {/* grid + axes */}
              {[0, 20, 40, 60, 80, 100].map((c) => (
                <line key={c} x1={xScale(c)} y1={PLOT.y0} x2={xScale(c)} y2={PLOT.y1} stroke={COL_GRID} strokeWidth="1" />
              ))}
              {yAxisTicks.map((t) => (
                <line key={t} x1={PLOT.x0} y1={tScale(t)} x2={PLOT.x1} y2={tScale(t)} stroke={COL_GRID} strokeWidth="1" />
              ))}
              <rect x={PLOT.x0} y={PLOT.y0} width={PLOT.x1 - PLOT.x0} height={PLOT.y1 - PLOT.y0} fill="none" stroke="#94a3b8" strokeWidth="1.5" />

              {/* axis ticks/labels */}
              {[0, 20, 40, 60, 80, 100].map((c) => (
                <text key={c} x={xScale(c)} y={PLOT.y1 + 18} fontSize="11" textAnchor="middle" fill="#475569">{c}</text>
              ))}
              <text x={(PLOT.x0 + PLOT.x1) / 2} y={VB_H - 6} fontSize="12" textAnchor="middle" fill="#334155">
                Composition, wt% {cfg.elementB} →
              </text>
              {yAxisTicks.map((t) => (
                <text key={t} x={PLOT.x0 - 8} y={tScale(t) + 4} fontSize="11" textAnchor="end" fill="#475569">{t}</text>
              ))}
              <text x={16} y={(PLOT.y0 + PLOT.y1) / 2} fontSize="12" fill="#334155" transform={`rotate(-90 16 ${(PLOT.y0 + PLOT.y1) / 2})`} textAnchor="middle">
                Temperature (°C)
              </text>

              {/* pure component labels */}
              <text x={xScale(0)} y={PLOT.y1 + 34} fontSize="11" fontStyle="italic" textAnchor="middle" fill="#64748b">100% {cfg.elementA}</text>
              <text x={xScale(100)} y={PLOT.y1 + 34} fontSize="11" fontStyle="italic" textAnchor="middle" fill="#64748b">100% {cfg.elementB}</text>

              {/* curves */}
              {curves.map((c) => (
                <path key={c.key} d={c.d} fill="none" stroke="#1e293b" strokeWidth={c.dashed ? 1.4 : 2} strokeDasharray={c.dashed ? '4 3' : undefined} />
              ))}

              {/* region labels */}
              {LABELS[modeId].map((l, i) => (
                <text key={i} x={xScale(l.C)} y={tScale(l.T)} fontSize={l.small ? 10 : 12} textAnchor="middle" fill="#334155" fontWeight={l.small ? 400 : 500}>
                  {l.text}
                </text>
              ))}

              {/* eutectic point marker */}
              {cfg.TE && (
                <circle cx={xScale(cfg.CE)} cy={tScale(cfg.TE)} r="3.5" fill="#1e293b" />
              )}

              {/* tie line */}
              {tieLine && (
                <g>
                  <line
                    x1={xScale(tieLine.Cl)} y1={tScale(temperature)}
                    x2={xScale(tieLine.Cs)} y2={tScale(temperature)}
                    stroke="#b91c1c" strokeWidth="2"
                  />
                  <circle cx={xScale(tieLine.Cl)} cy={tScale(temperature)} r="4" fill={COL_L} stroke="#b91c1c" strokeWidth="1.5" />
                  <circle cx={xScale(tieLine.Cs)} cy={tScale(temperature)} r="4" fill={status.phases[1].color} stroke="#b91c1c" strokeWidth="1.5" />
                  <text x={xScale(tieLine.Cl)} y={tScale(temperature) - 8} fontSize="10" textAnchor="middle" fill="#b91c1c">
                    {tieLine.Cl.toFixed(1)}%
                  </text>
                  <text x={xScale(tieLine.Cs)} y={tScale(temperature) - 8} fontSize="10" textAnchor="middle" fill="#b91c1c">
                    {tieLine.Cs.toFixed(1)}%
                  </text>
                </g>
              )}

              {/* crosshair (current point) */}
              <line x1={xScale(composition)} y1={PLOT.y0 - 10} x2={xScale(composition)} y2={PLOT.y1} stroke="#334155" strokeDasharray="3 3" strokeWidth="1" />
              <line x1={PLOT.x0} y1={tScale(temperature)} x2={PLOT.x1 + 12} y2={tScale(temperature)} stroke="#334155" strokeDasharray="3 3" strokeWidth="1" />
              <circle cx={xScale(composition)} cy={tScale(temperature)} r="5.5" fill="white" stroke="#0f172a" strokeWidth="2" />

              {/* draggable handles */}
              <circle
                cx={xScale(composition)} cy={PLOT.y0 - 10} r="7"
                fill="#0f172a" style={{ cursor: 'ew-resize' }}
                onPointerDown={() => setDragging('C')}
              />
              <circle
                cx={PLOT.x1 + 12} cy={tScale(temperature)} r="7"
                fill="#0f172a" style={{ cursor: 'ns-resize' }}
                onPointerDown={() => setDragging('T')}
              />

              {/* hover tooltip */}
              {hover && (
                <g pointerEvents="none">
                  <rect x={Math.min(hover.x + 8, VB_W - 130)} y={Math.max(hover.y - 28, PLOT.y0)} width="122" height="24" rx="4" fill="#0f172a" opacity="0.9" />
                  <text x={Math.min(hover.x + 14, VB_W - 124)} y={Math.max(hover.y - 12, PLOT.y0 + 16)} fontSize="10.5" fill="white">
                    {hover.c.toFixed(1)}% {cfg.elementB}, {hover.t.toFixed(0)}°C
                  </text>
                </g>
              )}
            </svg>

            {/* Sliders */}
            <div className="mt-3 space-y-3 px-1">
              <div>
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span>Composition (wt% {cfg.elementB})</span>
                  <span className="font-mono">{composition.toFixed(1)}%</span>
                </div>
                <input
                  type="range" min="0" max="100" step="0.1" value={composition}
                  onChange={(e) => setComposition(parseFloat(e.target.value))}
                  className="w-full accent-slate-800"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span>Temperature</span>
                  <span className="font-mono">{temperature}°C</span>
                </div>
                <input
                  type="range" min={cfg.tMin} max={cfg.tMax} step="1" value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-full accent-slate-800"
                />
              </div>
              <div className="flex items-center justify-between pt-1">
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={showTieLines} onChange={(e) => setShowTieLines(e.target.checked)} />
                  Show tie line
                </label>
                {modeId === 'isomorphous' && (
                  <label className="flex items-center gap-2 text-sm text-slate-600">
                    <input type="checkbox" checked={cored} onChange={(e) => setCored(e.target.checked)} />
                    Cored (non-equilibrium) grains
                  </label>
                )}
              </div>
            </div>
          </div>

          {/* ------------------------- Right panel ------------------------- */}
          <div className="lg:w-96 flex flex-col gap-4">
            {/* Microstructure */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-3">
              <h2 className="text-sm font-semibold mb-2 text-slate-700">Schematic microstructure</h2>
              <Microstructure
                modeId={modeId} cfg={cfg} status={status} composition={composition}
                cored={cored} grains={grains} order={order}
              />
              <p className="text-[11px] text-slate-400 mt-2 leading-snug">
                Stylized, not to scale. Grain proportions follow the lever-rule result above.
                {status.region === 'α+β' && modeId !== 'isomorphous'
                  ? ' Below the eutectic isotherm, proeutectic phase vs. eutectic mixture is estimated from composition alone (qualitative).'
                  : ''}
              </p>
            </div>

            {/* Readouts */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-3">
              <h2 className="text-sm font-semibold mb-2 text-slate-700">Live readout</h2>
              <div className="text-sm mb-2">
                <span className="text-slate-500">Region: </span>
                <span className="font-semibold">{status.region}</span>
              </div>

              {status.phases.length === 1 ? (
                <p className="text-sm text-slate-600">
                  100% {status.phases[0].label}, composition = overall composition ({composition.toFixed(1)}% {cfg.elementB}).
                </p>
              ) : (
                <div className="space-y-2">
                  {status.phases.map((p) => (
                    <div key={p.key} className="text-sm flex justify-between">
                      <span style={{ color: p.color }} className="font-medium">{p.label}</span>
                      <span className="font-mono">
                        C = {p.composition.toFixed(1)}% &nbsp;|&nbsp; {(p.fraction * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
                  <div className="flex h-4 w-full rounded overflow-hidden border border-slate-200 mt-1">
                    {status.phases.map((p) => (
                      <div key={p.key} style={{ width: `${p.fraction * 100}%`, backgroundColor: p.color }} title={`${p.label}: ${(p.fraction * 100).toFixed(1)}%`} />
                    ))}
                  </div>
                </div>
              )}

              <div className="text-xs text-slate-400 mt-3 pt-2 border-t border-slate-100">
                Overall composition: {composition.toFixed(1)}% {cfg.elementB} · Temperature: {temperature}°C
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ======================================================================== */
/* Microstructure panel                                                     */
/* ======================================================================== */
function Microstructure({ modeId, cfg, status, composition, cored, grains, order }) {
  const N = grains.length;
  const region = status.region;

  let content = null;

  if (region === 'L') {
    content = (
      <>
        <rect x="0" y="0" width="300" height="300" fill={COL_LBG} />
        <path d="M0,90 C60,70 90,110 150,90 S 240,70 300,90 L300,300 L0,300 Z" fill={COL_L} opacity="0.5" />
        <path d="M0,180 C60,160 90,200 150,180 S 240,160 300,180 L300,300 L0,300 Z" fill={COL_L} opacity="0.5" />
      </>
    );
  } else if (region === 'α' || region === 'β') {
    const isAlpha = region === 'α';
    const color = isAlpha ? COL_A : COL_B;
    const useCored = modeId === 'isomorphous' && cored;
    content = (
      <>
        <rect x="0" y="0" width="300" height="300" fill="white" />
        {grains.map((g, i) => (
          <circle key={i} cx={g.x} cy={g.y} r={g.r} fill={useCored ? (isAlpha ? 'url(#coredAlpha)' : color) : color} stroke="#ffffffaa" strokeWidth="1.5" />
        ))}
      </>
    );
  } else if (region === 'L+α' || region === 'L+β') {
    const solidPhase = status.phases.find((p) => p.key !== 'L');
    const color = solidPhase.color;
    const coloredCount = Math.round(solidPhase.fraction * N);
    const chosen = new Set(order.slice(0, coloredCount));
    const useCored = modeId === 'isomorphous' && cored;
    content = (
      <>
        <rect x="0" y="0" width="300" height="300" fill={COL_LBG} />
        {grains.map((g, i) =>
          chosen.has(i) ? (
            <circle key={i} cx={g.x} cy={g.y} r={g.r * 0.85} fill={useCored ? (solidPhase.key === 'alpha' ? 'url(#coredAlpha)' : color) : color} stroke="white" strokeWidth="1.5" />
          ) : null
        )}
      </>
    );
  } else if (region === 'α+β') {
    if (modeId === 'isomorphous') {
      content = null; // unreachable
    } else {
      const { primary, fProEutectic } = proeutecticSplitSafe(modeId, cfg, composition);
      const primaryColor = primary === 'alpha' ? COL_A : COL_B;
      const coloredCount = Math.round(fProEutectic * N);
      const chosen = new Set(order.slice(0, coloredCount));
      content = (
        <>
          <rect x="0" y="0" width="300" height="300" fill="white" />
          {grains.map((g, i) => (
            <circle
              key={i} cx={g.x} cy={g.y} r={g.r}
              fill={chosen.has(i) ? primaryColor : 'url(#eutecticPattern)'}
              stroke="#ffffffaa" strokeWidth="1.5"
            />
          ))}
        </>
      );
    }
  }

  return (
    <svg viewBox="0 0 300 300" className="w-full h-auto rounded-lg border border-slate-200">
      <defs>
        <pattern id="eutecticPattern" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <rect width="6" height="6" fill={COL_A} />
          <rect width="3" height="6" fill={COL_B} />
        </pattern>
        <radialGradient id="coredAlpha" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stopColor={lighten(COL_A, 0.55)} />
          <stop offset="70%" stopColor={COL_A} />
          <stop offset="100%" stopColor={lighten(COL_A, -0.1)} />
        </radialGradient>
      </defs>
      {content}
    </svg>
  );
}

function proeutecticSplitSafe(modeId, cfg, C0) {
  return proeutecticSplit(modeId, cfg, C0);
}
function proeutecticSplit(mode, cfg, C0) {
  if (mode === 'eutectic-simple') {
    if (C0 < cfg.CE) return { primary: 'alpha', fProEutectic: Math.max(0, Math.min(1, (cfg.CE - C0) / cfg.CE)) };
    return { primary: 'beta', fProEutectic: Math.max(0, Math.min(1, (C0 - cfg.CE) / (100 - cfg.CE))) };
  }
  if (C0 < cfg.CE) return { primary: 'alpha', fProEutectic: Math.max(0, Math.min(1, (cfg.CE - C0) / (cfg.CE - cfg.CalphaE))) };
  return { primary: 'beta', fProEutectic: Math.max(0, Math.min(1, (C0 - cfg.CE) / (cfg.CbetaE - cfg.CE))) };
}