import React, { useState, useMemo, useRef, useCallback } from "react";

/* =========================================================================
   MATH — bowed phase-boundary curves with exact inversion
   Every liquidus / solidus / solvus line is modelled as a quadratic "bow"
   between two known points (pure-metal points, eutectic point, solubility
   limits). curveVal gives value(param); curveParam inverts it exactly via
   the quadratic formula — no numerical search needed.
   ========================================================================= */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function curveVal(p0, v0, p1, v1, bow, p) {
  const t = (p - p0) / (p1 - p0);
  return v0 + (v1 - v0) * t + 4 * bow * t * (1 - t);
}
function curveParam(p0, v0, p1, v1, bow, v) {
  const a = 4 * bow;
  const b = -(4 * bow + (v1 - v0));
  const c = v - v0;
  let t;
  if (Math.abs(a) < 1e-9) {
    t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b + sq) / (2 * a);
    const t2 = (-b - sq) / (2 * a);
    t = t1 >= -1e-6 && t1 <= 1 + 1e-6 ? t1 : t2;
  }
  return p0 + (p1 - p0) * t;
}
function sampleCurve(p0, v0, p1, v1, bow, n = 48) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const p = p0 + ((p1 - p0) * i) / n;
    pts.push([p, curveVal(p0, v0, p1, v1, bow, p)]);
  }
  return pts;
}

/* seeded PRNG so grain geometry is stable across re-renders */
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =========================================================================
   ALLOY SYSTEM DEFINITIONS (idealized geometry, not thermodynamic data)
   ========================================================================= */
const MODES = {
  isomorphous: {
    id: "isomorphous",
    label: "Isomorphous",
    system: "Cu–Ni type",
    nameA: "Cu",
    nameB: "Ni",
    TA: 1085,
    TB: 1453,
    domain: [1000, 1500],
    liquidus: [0, 1085, 100, 1453, 40],
    solidus: [0, 1085, 100, 1453, -55],
    eutectic: null,
    default: { comp: 35, temp: 1200 },
  },
  eutecticInsoluble: {
    id: "eutecticInsoluble",
    label: "Eutectic — insoluble",
    system: "idealized, zero solid solubility",
    nameA: "A",
    nameB: "B",
    TA: 327,
    TB: 232,
    domain: [25, 350],
    liquidusLeft: [0, 327, 61.9, 183, -18],
    liquidusRight: [100, 232, 61.9, 183, -12],
    eutectic: { Ce: 61.9, Te: 183, CalphaE: 0, CbetaE: 100 },
    default: { comp: 40, temp: 200 },
  },
  eutecticPartial: {
    id: "eutecticPartial",
    label: "Eutectic — partial solubility",
    system: "Pb–Sn type",
    nameA: "Pb",
    nameB: "Sn",
    TA: 327,
    TB: 232,
    domain: [25, 350],
    liquidusLeft: [0, 327, 61.9, 183, -18],
    liquidusRight: [100, 232, 61.9, 183, -12],
    solidusLeft: [0, 327, 18.3, 183, -15],
    solidusRight: [100, 232, 97.5, 183, -10],
    solvusAlpha: [25, 2, 183, 18.3, 2],
    solvusBeta: [25, 99, 183, 97.5, -1],
    eutectic: { Ce: 61.9, Te: 183, CalphaE: 18.3, CbetaE: 97.5 },
    default: { comp: 40, temp: 200 },
  },
};

/* =========================================================================
   PHASE CLASSIFICATION + INVERSE LEVER RULE
   ========================================================================= */
function classify(mode, cfg, comp, temp) {
  if (mode === "isomorphous") {
    const Tliq = curveVal(...cfg.liquidus, comp);
    const Tsol = curveVal(...cfg.solidus, comp);
    if (temp > Tliq) return { region: "L", phases: [{ key: "L", label: "Liquid", comp, fraction: 1 }] };
    if (temp < Tsol) return { region: "alpha", phases: [{ key: "alpha", label: "α solid solution", comp, fraction: 1 }] };
    const xLiquid = curveParam(...cfg.liquidus, temp);
    const xSolid = curveParam(...cfg.solidus, temp);
    const denom = xSolid - xLiquid;
    const fLiquid = clamp(denom !== 0 ? (xSolid - comp) / denom : 0.5, 0, 1);
    return {
      region: "L+alpha",
      tie: { left: Math.min(xLiquid, xSolid), right: Math.max(xLiquid, xSolid) },
      phases: [
        { key: "L", label: "Liquid", comp: xLiquid, fraction: fLiquid },
        { key: "alpha", label: "α solid solution", comp: xSolid, fraction: 1 - fLiquid },
      ],
    };
  }

  const { Ce, Te, CalphaE, CbetaE } = cfg.eutectic;
  const isLeft = comp <= Ce;
  const liqBranch = isLeft ? cfg.liquidusLeft : cfg.liquidusRight;
  const Tliq = curveVal(...liqBranch, comp);

  if (temp > Tliq) return { region: "L", phases: [{ key: "L", label: "Liquid", comp, fraction: 1 }] };

  if (temp >= Te) {
    const xLiquid = curveParam(...liqBranch, temp);
    let xSolid;
    if (mode === "eutecticInsoluble") {
      xSolid = isLeft ? 0 : 100;
    } else {
      const solBranch = isLeft ? cfg.solidusLeft : cfg.solidusRight;
      xSolid = curveParam(...solBranch, temp);
    }
    const denom = xSolid - xLiquid;
    const fLiquid = clamp(denom !== 0 ? (xSolid - comp) / denom : 0.5, 0, 1);
    const solidKey = isLeft ? "alpha" : "beta";
    return {
      region: isLeft ? "L+alpha" : "L+beta",
      tie: { left: Math.min(xLiquid, xSolid), right: Math.max(xLiquid, xSolid) },
      phases: [
        { key: "L", label: "Liquid", comp: xLiquid, fraction: fLiquid },
        { key: solidKey, label: (isLeft ? "α" : "β") + " solid solution", comp: xSolid, fraction: 1 - fLiquid },
      ],
    };
  }

  // fully solid, temp < Te
  let xA, xB;
  if (mode === "eutecticInsoluble") {
    xA = 0;
    xB = 100;
  } else {
    xA = curveVal(...cfg.solvusAlpha, temp);
    xB = curveVal(...cfg.solvusBeta, temp);
  }

  let result;
  if (comp <= xA) {
    result = { region: "alpha", phases: [{ key: "alpha", label: "α solid solution", comp, fraction: 1 }] };
  } else if (comp >= xB) {
    result = { region: "beta", phases: [{ key: "beta", label: "β solid solution", comp, fraction: 1 }] };
  } else {
    const denom = xB - xA;
    const fAlpha = clamp(denom !== 0 ? (xB - comp) / denom : 0.5, 0, 1);
    result = {
      region: "alpha+beta",
      tie: { left: xA, right: xB },
      phases: [
        { key: "alpha", label: "α solid solution", comp: xA, fraction: fAlpha },
        { key: "beta", label: "β solid solution", comp: xB, fraction: 1 - fAlpha },
      ],
    };
  }

  if (comp > CalphaE && comp < CbetaE) {
    if (comp <= Ce) {
      const denom = Ce - CalphaE;
      const wEutectic = clamp(denom !== 0 ? (comp - CalphaE) / denom : 0, 0, 1);
      result.micro = { proeutectic: "alpha", wProeutectic: 1 - wEutectic, wEutectic };
    } else {
      const denom = CbetaE - Ce;
      const wEutectic = clamp(denom !== 0 ? (CbetaE - comp) / denom : 0, 0, 1);
      result.micro = { proeutectic: "beta", wProeutectic: 1 - wEutectic, wEutectic };
    }
  }
  return result;
}

/* =========================================================================
   CHART GEOMETRY
   ========================================================================= */
const CHART_W = 640;
const CHART_H = 460;
const MARGIN = { top: 26, right: 24, bottom: 54, left: 72 };
const PLOT_W = CHART_W - MARGIN.left - MARGIN.right;
const PLOT_H = CHART_H - MARGIN.top - MARGIN.bottom;
const xPix = (comp) => MARGIN.left + (comp / 100) * PLOT_W;
const yPix = (T, domain) => MARGIN.top + (1 - (T - domain[0]) / (domain[1] - domain[0])) * PLOT_H;
const pxToComp = (x) => clamp(((x - MARGIN.left) / PLOT_W) * 100, 0, 100);
const pxToTemp = (y, domain) => clamp(domain[0] + (1 - (y - MARGIN.top) / PLOT_H) * (domain[1] - domain[0]), domain[0], domain[1]);

function pathFromPx(pts) {
  return "M " + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L ") + " Z";
}
function lineFromPx(pts) {
  return "M " + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L ");
}

function buildRegions(mode, cfg) {
  const d = cfg.domain;
  const top = [xPix(0), yPix(d[1], d)];
  const topR = [xPix(100), yPix(d[1], d)];
  const bot = [xPix(0), yPix(d[0], d)];
  const botR = [xPix(100), yPix(d[0], d)];

  if (mode === "isomorphous") {
    const liqPx = sampleCurve(...cfg.liquidus).map(([x, T]) => [xPix(x), yPix(T, d)]);
    const solPx = sampleCurve(...cfg.solidus).map(([x, T]) => [xPix(x), yPix(T, d)]);
    return [
      { key: "L", cls: "liquid", d: pathFromPx([top, topR, ...liqPx.slice().reverse()]) },
      { key: "L+alpha", cls: "two", d: pathFromPx([...liqPx, ...solPx.slice().reverse()]) },
      { key: "alpha", cls: "alpha", d: pathFromPx([bot, botR, ...solPx.slice().reverse()]) },
    ];
  }

  const { Ce, Te, CalphaE, CbetaE } = cfg.eutectic;
  const liqLPx = sampleCurve(...cfg.liquidusLeft).map(([x, T]) => [xPix(x), yPix(T, d)]);
  const liqRPx = sampleCurve(...cfg.liquidusRight).map(([x, T]) => [xPix(x), yPix(T, d)]);
  const eutPt = [xPix(Ce), yPix(Te, d)];
  const regions = [
    {
      key: "L",
      cls: "liquid",
      d: pathFromPx([top, topR, ...liqRPx, ...liqLPx.slice().reverse()]),
    },
  ];

  if (mode === "eutecticInsoluble") {
    const teLeft = [xPix(0), yPix(Te, d)];
    const teRight = [xPix(100), yPix(Te, d)];
    regions.push({ key: "L+alpha", cls: "two", d: pathFromPx([[xPix(0), yPix(cfg.TA, d)], ...liqLPx, teLeft]) });
    regions.push({ key: "L+beta", cls: "two", d: pathFromPx([[xPix(100), yPix(cfg.TB, d)], ...liqRPx, teRight]) });
    regions.push({ key: "alpha+beta", cls: "twoSolid", d: pathFromPx([teLeft, teRight, botR, bot]) });
  } else {
    const solLPx = sampleCurve(...cfg.solidusLeft).map(([x, T]) => [xPix(x), yPix(T, d)]);
    const solRPx = sampleCurve(...cfg.solidusRight).map(([x, T]) => [xPix(x), yPix(T, d)]);
    const svAPx = sampleCurve(...cfg.solvusAlpha).map(([T, x]) => [xPix(x), yPix(T, d)]);
    const svBPx = sampleCurve(...cfg.solvusBeta).map(([T, x]) => [xPix(x), yPix(T, d)]);
    const aAtTe = [xPix(CalphaE), yPix(Te, d)];
    const bAtTe = [xPix(CbetaE), yPix(Te, d)];
    const aAtRoom = [xPix(cfg.solvusAlpha[1]), yPix(cfg.solvusAlpha[0], d)];
    const bAtRoom = [xPix(cfg.solvusBeta[1]), yPix(cfg.solvusBeta[0], d)];

    regions.push({ key: "L+alpha", cls: "two", d: pathFromPx([[xPix(0), yPix(cfg.TA, d)], ...liqLPx, aAtTe, ...solLPx.slice().reverse()]) });
    regions.push({ key: "L+beta", cls: "two", d: pathFromPx([[xPix(100), yPix(cfg.TB, d)], ...liqRPx, bAtTe, ...solRPx.slice().reverse()]) });
    regions.push({ key: "alpha", cls: "alpha", d: pathFromPx([[xPix(0), yPix(cfg.TA, d)], ...solLPx, ...svAPx.slice().reverse(), bot]) });
    regions.push({ key: "beta", cls: "beta", d: pathFromPx([[xPix(100), yPix(cfg.TB, d)], ...solRPx, ...svBPx.slice().reverse(), botR]) });
    regions.push({ key: "alpha+beta", cls: "twoSolid", d: pathFromPx([aAtTe, bAtTe, ...svBPx.slice().reverse(), ...svAPx]) });
  }
  return regions;
}

/* =========================================================================
   MICROSTRUCTURE — jittered-grid "grains" + eutectic lamellae pattern
   ========================================================================= */
const MICRO_W = 300;
const MICRO_H = 210;

function buildGrainField(seed, cols = 11, rows = 8) {
  const rand = mulberry32(seed);
  const cw = MICRO_W / cols;
  const ch = MICRO_H / rows;
  const grid = [];
  for (let j = 0; j <= rows; j++) {
    const row = [];
    for (let i = 0; i <= cols; i++) {
      let x = i * cw;
      let y = j * ch;
      if (i > 0 && i < cols) x += (rand() - 0.5) * cw * 0.75;
      if (j > 0 && j < rows) y += (rand() - 0.5) * ch * 0.75;
      row.push([x, y]);
    }
    grid.push(row);
  }
  const cells = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p00 = grid[j][i], p10 = grid[j][i + 1], p11 = grid[j + 1][i + 1], p01 = grid[j + 1][i];
      const cx = (p00[0] + p10[0] + p11[0] + p01[0]) / 4;
      const cy = (p00[1] + p10[1] + p11[1] + p01[1]) / 4;
      cells.push({ id: i + "-" + j, pts: [p00, p10, p11, p01], cx, cy });
    }
  }
  const seedsA = Array.from({ length: 5 }, () => [rand() * MICRO_W, rand() * MICRO_H]);
  const seedsB = Array.from({ length: 5 }, () => [rand() * MICRO_W, rand() * MICRO_H]);
  const scored = cells
    .map((c) => {
      const dA = Math.min(...seedsA.map((s) => Math.hypot(c.cx - s[0], c.cy - s[1])));
      const dB = Math.min(...seedsB.map((s) => Math.hypot(c.cx - s[0], c.cy - s[1])));
      return { ...c, score: dB - dA };
    })
    .sort((a, b) => b.score - a.score);
  // deterministic speckle positions for precipitate rendering, reused across fractions
  const speckles = Array.from({ length: 90 }, () => ({ x: rand() * MICRO_W, y: rand() * MICRO_H, r: 0.8 + rand() * 1.1 }));
  return { scored, speckles };
}

const CELL_KEY = (pts) => pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");

/* =========================================================================
   UI ATOMS
   ========================================================================= */
const COLORS = {
  L: "#ef6b3c",
  Ldark: "#c94e26",
  alpha: "#5b9bd9",
  alphaDark: "#33628f",
  alphaCore: "#274d73",
  beta: "#d9a441",
  betaDark: "#a97a26",
  signal: "#7fe0c4",
  grid: "#2b323c",
  paper: "#eef1f5",
  muted: "#8a94a3",
};

function Swatch({ color }) {
  return <span className="apx-swatch" style={{ background: color }} />;
}

/* =========================================================================
   MAIN COMPONENT
   ========================================================================= */
export default function AlloyPhaseExplorer() {
  const [modeKey, setModeKey] = useState("isomorphous");
  const cfg = MODES[modeKey];
  const [comp, setComp] = useState(cfg.default.comp);
  const [temp, setTemp] = useState(cfg.default.temp);
  const [showTie, setShowTie] = useState(true);
  const [cored, setCored] = useState(true);
  const [hover, setHover] = useState(null);
  const draggingRef = useRef(false);
  const svgRef = useRef(null);

  const switchMode = (key) => {
    setModeKey(key);
    setComp(MODES[key].default.comp);
    setTemp(MODES[key].default.temp);
  };

  const result = useMemo(() => classify(modeKey, cfg, comp, temp), [modeKey, cfg, comp, temp]);
  const regions = useMemo(() => buildRegions(modeKey, cfg), [modeKey, cfg]);
  const grainField = useMemo(() => buildGrainField(modeKey.length * 977 + 13), [modeKey]);

  const domain = cfg.domain;
  const pointPx = [xPix(comp), yPix(temp, domain)];

  const clientToData = useCallback(
    (evt) => {
      const rect = svgRef.current.getBoundingClientRect();
      const scaleX = CHART_W / rect.width;
      const scaleY = CHART_H / rect.height;
      const px = (evt.clientX - rect.left) * scaleX;
      const py = (evt.clientY - rect.top) * scaleY;
      return { comp: pxToComp(px), temp: pxToTemp(py, domain), px, py };
    },
    [domain]
  );

  const onPointerDown = (evt) => {
    draggingRef.current = true;
    evt.target.setPointerCapture(evt.pointerId);
    const d = clientToData(evt);
    setComp(d.comp);
    setTemp(d.temp);
    setHover(d);
  };
  const onPointerMove = (evt) => {
    const d = clientToData(evt);
    setHover(d);
    if (draggingRef.current) {
      setComp(d.comp);
      setTemp(d.temp);
    }
  };
  const onPointerUp = (evt) => {
    draggingRef.current = false;
    try {
      evt.target.releasePointerCapture(evt.pointerId);
    } catch (e) {}
  };
  const onPointerLeave = () => setHover(null);

  // axis ticks
  const compTicks = [0, 20, 40, 60, 80, 100];
  const tempSpan = domain[1] - domain[0];
  const tStep = tempSpan > 800 ? 100 : 50;
  const tempTicks = [];
  for (let t = Math.ceil(domain[0] / tStep) * tStep; t <= domain[1]; t += tStep) tempTicks.push(t);

  const phaseColor = (key) => (key === "L" ? COLORS.L : key === "alpha" ? COLORS.alpha : COLORS.beta);

  /* -------- microstructure render -------- */
  function renderMicrostructure() {
    const region = result.region;

    if (region === "L") {
      return (
        <g>
          <defs>
            <radialGradient id="liqGrad" cx="35%" cy="30%" r="80%">
              <stop offset="0%" stopColor="#ff8a56" />
              <stop offset="100%" stopColor={COLORS.Ldark} />
            </radialGradient>
          </defs>
          <rect width={MICRO_W} height={MICRO_H} fill="url(#liqGrad)" />
          <g className="apx-melt-flow" opacity="0.25">
            <path d="M10,150 Q80,120 150,150 T290,140" stroke="#fff" strokeWidth="6" fill="none" />
            <path d="M-10,60 Q70,90 140,60 T300,70" stroke="#fff" strokeWidth="5" fill="none" />
          </g>
        </g>
      );
    }

    if (region === "alpha" || region === "beta") {
      const isAlpha = region === "alpha";
      const base = isAlpha ? COLORS.alpha : COLORS.beta;
      const useCored = isAlpha && modeKey === "isomorphous" && cored;
      return (
        <g>
          <defs>
            <radialGradient id="coredGrad" cx="50%" cy="50%" r="65%" gradientUnits="objectBoundingBox">
              <stop offset="0%" stopColor={COLORS.alphaCore} />
              <stop offset="100%" stopColor={COLORS.alpha} />
            </radialGradient>
          </defs>
          {grainField.scored.map((c) => (
            <polygon
              key={c.id}
              points={CELL_KEY(c.pts)}
              fill={useCored ? "url(#coredGrad)" : base}
              stroke="#0d0f13"
              strokeWidth="1"
            />
          ))}
        </g>
      );
    }

    if (region === "L+alpha" || region === "L+beta") {
      const solidPhase = result.phases.find((p) => p.key !== "L");
      const liquidPhase = result.phases.find((p) => p.key === "L");
      const isAlpha = solidPhase.key === "alpha";
      const base = isAlpha ? COLORS.alpha : COLORS.beta;
      const useCored = isAlpha && modeKey === "isomorphous" && cored;
      const n = Math.round(solidPhase.fraction * grainField.scored.length);
      const solidCells = grainField.scored.slice(0, n);
      return (
        <g>
          <defs>
            <radialGradient id="liqGrad2" cx="35%" cy="30%" r="80%">
              <stop offset="0%" stopColor="#ff8a56" />
              <stop offset="100%" stopColor={COLORS.Ldark} />
            </radialGradient>
            <radialGradient id="coredGrad2" cx="50%" cy="50%" r="65%" gradientUnits="objectBoundingBox">
              <stop offset="0%" stopColor={COLORS.alphaCore} />
              <stop offset="100%" stopColor={COLORS.alpha} />
            </radialGradient>
          </defs>
          <rect width={MICRO_W} height={MICRO_H} fill="url(#liqGrad2)" opacity="0.9" />
          {solidCells.map((c) => (
            <polygon
              key={c.id}
              points={CELL_KEY(c.pts)}
              fill={useCored ? "url(#coredGrad2)" : base}
              stroke="#0d0f13"
              strokeWidth="1"
              opacity="0.96"
            />
          ))}
          <text x="8" y="20" className="apx-micro-caption">
            {Math.round(liquidPhase.fraction * 100)}% liquid · {Math.round(solidPhase.fraction * 100)}% {isAlpha ? "α" : "β"}
          </text>
        </g>
      );
    }

    if (region === "alpha+beta") {
      const { Ce, CalphaE, CbetaE } = cfg.eutectic;
      const alphaPhase = result.phases.find((p) => p.key === "alpha");
      const betaPhase = result.phases.find((p) => p.key === "beta");

      if (result.micro) {
        const proeutecticIsAlpha = result.micro.proeutectic === "alpha";
        const proColor = proeutecticIsAlpha ? COLORS.alpha : COLORS.beta;
        const fAlphaInEutectic = (CbetaE - Ce) / (CbetaE - CalphaE);
        const stripeTotal = 8;
        const wA = Math.max(1, stripeTotal * fAlphaInEutectic);
        const wB = Math.max(1, stripeTotal - wA);
        const n = Math.round(result.micro.wProeutectic * grainField.scored.length);
        const proCells = grainField.scored.slice(0, n);
        const eutCells = grainField.scored.slice(n);
        return (
          <g>
            <defs>
              <pattern id="lamellae" width={wA + wB} height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(34)">
                <rect width={wA} height="10" fill={COLORS.alpha} />
                <rect x={wA} width={wB} height="10" fill={COLORS.beta} />
              </pattern>
            </defs>
            {eutCells.map((c) => (
              <polygon key={c.id} points={CELL_KEY(c.pts)} fill="url(#lamellae)" stroke="#0d0f13" strokeWidth="0.6" />
            ))}
            {proCells.map((c) => (
              <polygon key={c.id} points={CELL_KEY(c.pts)} fill={proColor} stroke="#0d0f13" strokeWidth="1" />
            ))}
            <text x="8" y="20" className="apx-micro-caption">
              {Math.round(result.micro.wProeutectic * 100)}% proeutectic {proeutecticIsAlpha ? "α" : "β"} · {Math.round(result.micro.wEutectic * 100)}% eutectic (α+β)
            </text>
          </g>
        );
      }

      // fine two-phase mixture without a proeutectic/eutectic split (solid-state precipitation region)
      const majorityIsAlpha = alphaPhase.fraction >= betaPhase.fraction;
      const base = majorityIsAlpha ? COLORS.alpha : COLORS.beta;
      const speck = majorityIsAlpha ? COLORS.beta : COLORS.alpha;
      const minorFraction = majorityIsAlpha ? betaPhase.fraction : alphaPhase.fraction;
      const speckCount = Math.round(minorFraction * grainField.speckles.length * 3);
      return (
        <g>
          {grainField.scored.map((c) => (
            <polygon key={c.id} points={CELL_KEY(c.pts)} fill={base} stroke="#0d0f13" strokeWidth="1" />
          ))}
          {grainField.speckles.slice(0, speckCount).map((s, i) => (
            <circle key={i} cx={(s.x * 3) % MICRO_W} cy={(s.y * 2.4) % MICRO_H} r={s.r} fill={speck} opacity="0.9" />
          ))}
          <text x="8" y="20" className="apx-micro-caption">
            {majorityIsAlpha ? "α" : "β"} matrix with fine precipitated {majorityIsAlpha ? "β" : "α"}
          </text>
        </g>
      );
    }

    return null;
  }

  return (
    <div className="apx-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

        .apx-root {
          --ink: #12151a;
          --panel: #1a1f26;
          --panel2: #1f252d;
          --line: #2b323c;
          --paper: #eef1f5;
          --muted: #8a94a3;
          --liquid: #ef6b3c;
          --alpha: #5b9bd9;
          --beta: #d9a441;
          --signal: #7fe0c4;
          background: var(--ink);
          color: var(--paper);
          font-family: 'IBM Plex Sans', sans-serif;
          padding: 20px;
          border-radius: 10px;
          box-sizing: border-box;
        }
        .apx-root * { box-sizing: border-box; }

        .apx-header { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-bottom: 14px; border-bottom: 1px solid var(--line); padding-bottom: 14px; }
        .apx-title { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 20px; letter-spacing: 0.01em; margin: 0; }
        .apx-subtitle { color: var(--muted); font-size: 12.5px; margin-top: 3px; }

        .apx-tabs { display: flex; gap: 2px; background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 3px; }
        .apx-tab { font-family: 'Space Grotesk', sans-serif; font-size: 12.5px; font-weight: 600; padding: 7px 12px; border-radius: 6px; border: none; background: transparent; color: var(--muted); cursor: pointer; letter-spacing: 0.01em; transition: background 0.15s, color 0.15s; }
        .apx-tab.active { background: var(--ink); color: var(--paper); box-shadow: 0 0 0 1px var(--line) inset; }
        .apx-tab:hover:not(.active) { color: var(--paper); }

        .apx-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(260px, 1fr); gap: 16px; }
        @media (max-width: 860px) { .apx-grid { grid-template-columns: 1fr; } }

        .apx-panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
        .apx-panel + .apx-panel { margin-top: 12px; }
        .apx-panel-title { font-family: 'Space Grotesk', sans-serif; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 10px 0; }

        .apx-svg-wrap { position: relative; width: 100%; }
        .apx-svg { width: 100%; height: auto; display: block; touch-action: none; cursor: crosshair; }

        .apx-axis-label { fill: var(--muted); font-family: 'IBM Plex Sans', sans-serif; font-size: 11px; }
        .apx-tick-label { fill: var(--muted); font-family: 'IBM Plex Mono', monospace; font-size: 10px; }
        .apx-region-label { fill: rgba(238,241,245,0.55); font-family: 'Space Grotesk', sans-serif; font-size: 12px; font-weight: 600; pointer-events: none; }
        .apx-curve { fill: none; stroke: var(--paper); stroke-width: 1.4; }
        .apx-grid-line { stroke: var(--line); stroke-width: 1; }

        .apx-tie-line { stroke: var(--signal); stroke-width: 1.6; stroke-dasharray: 5 4; }
        .apx-tie-dot { fill: var(--signal); stroke: var(--ink); stroke-width: 1.5; }
        .apx-cross-line { stroke: rgba(238,241,245,0.35); stroke-width: 1; stroke-dasharray: 3 3; }
        .apx-cross-dot { fill: var(--paper); stroke: var(--ink); stroke-width: 2; }

        .apx-tooltip-box { fill: var(--ink); stroke: var(--line); }
        .apx-tooltip-text { fill: var(--paper); font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; }

        .apx-readout-row { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--line); }
        .apx-readout-row:last-child { border-bottom: none; }
        .apx-swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
        .apx-readout-label { font-size: 12.5px; color: var(--paper); flex: 1; }
        .apx-readout-value { font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: var(--signal); }

        .apx-bar { height: 8px; border-radius: 4px; overflow: hidden; display: flex; background: var(--panel2); border: 1px solid var(--line); margin-top: 4px; }
        .apx-bar-seg { height: 100%; }

        .apx-region-tag { display: inline-block; font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--signal); background: rgba(127,224,196,0.08); border: 1px solid rgba(127,224,196,0.25); padding: 3px 8px; border-radius: 5px; margin-bottom: 10px; }

        .apx-control { margin-bottom: 14px; }
        .apx-control:last-child { margin-bottom: 0; }
        .apx-control-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
        .apx-control-label b { color: var(--paper); font-family: 'IBM Plex Mono', monospace; font-weight: 500; }
        .apx-slider { width: 100%; accent-color: var(--signal); height: 4px; }

        .apx-toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; }
        .apx-toggle-label { font-size: 12.5px; color: var(--paper); }
        .apx-switch { position: relative; width: 36px; height: 20px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel2); cursor: pointer; flex: none; }
        .apx-switch.on { background: rgba(127,224,196,0.25); border-color: var(--signal); }
        .apx-switch-knob { position: absolute; top: 1px; left: 1px; width: 16px; height: 16px; border-radius: 50%; background: var(--muted); transition: transform 0.15s, background 0.15s; }
        .apx-switch.on .apx-switch-knob { transform: translateX(16px); background: var(--signal); }

        .apx-micro-caption { fill: rgba(18,21,26,0.85); font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; }

        .apx-footnote { font-size: 11px; color: var(--muted); margin-top: 14px; line-height: 1.5; }

        @media (prefers-reduced-motion: reduce) { .apx-melt-flow { display: none; } }
      `}</style>

      <div className="apx-header">
        <div>
          <p className="apx-title">Alloy phase &amp; microstructure explorer</p>
          <p className="apx-subtitle">
            {cfg.system} · idealized boundaries for teaching the lever rule, not a thermodynamic database
          </p>
        </div>
        <div className="apx-tabs">
          {Object.values(MODES).map((m) => (
            <button
              key={m.id}
              className={"apx-tab" + (m.id === modeKey ? " active" : "")}
              onClick={() => switchMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="apx-grid">
        {/* -------- LEFT: phase diagram -------- */}
        <div className="apx-panel">
          <p className="apx-panel-title">
            Phase diagram — drag the point, or use the sliders below
          </p>
          <div className="apx-svg-wrap">
            <svg
              ref={svgRef}
              className="apx-svg"
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              onPointerMove={onPointerMove}
              onPointerLeave={onPointerLeave}
            >
              {/* region fills */}
              {regions.map((r) => (
                <path key={r.key} d={r.d} className={"apx-region-" + r.cls} fill={regionFill(r.cls)} opacity="0.9" />
              ))}

              {/* gridlines */}
              {compTicks.map((c) => (
                <line key={"gx" + c} x1={xPix(c)} y1={MARGIN.top} x2={xPix(c)} y2={CHART_H - MARGIN.bottom} className="apx-grid-line" />
              ))}
              {tempTicks.map((t) => (
                <line key={"gy" + t} x1={MARGIN.left} y1={yPix(t, domain)} x2={CHART_W - MARGIN.right} y2={yPix(t, domain)} className="apx-grid-line" />
              ))}

              {/* boundary curves */}
              {modeKey === "isomorphous" ? (
                <>
                  <path d={lineFromPx(sampleCurve(...cfg.liquidus).map(([x, T]) => [xPix(x), yPix(T, domain)]))} className="apx-curve" />
                  <path d={lineFromPx(sampleCurve(...cfg.solidus).map(([x, T]) => [xPix(x), yPix(T, domain)]))} className="apx-curve" />
                </>
              ) : (
                <>
                  <path d={lineFromPx(sampleCurve(...cfg.liquidusLeft).map(([x, T]) => [xPix(x), yPix(T, domain)]))} className="apx-curve" />
                  <path d={lineFromPx(sampleCurve(...cfg.liquidusRight).map(([x, T]) => [xPix(x), yPix(T, domain)]))} className="apx-curve" />
                  {modeKey === "eutecticPartial" && (
                    <>
                      <path d={lineFromPx(sampleCurve(...cfg.solidusLeft).map(([x, T]) => [xPix(x), yPix(T, domain)]))} className="apx-curve" />
                      <path d={lineFromPx(sampleCurve(...cfg.solidusRight).map(([x, T]) => [xPix(x), yPix(T, domain)]))} className="apx-curve" />
                      <path d={lineFromPx(sampleCurve(...cfg.solvusAlpha).map(([T, x]) => [xPix(x), yPix(T, domain)]))} className="apx-curve" />
                      <path d={lineFromPx(sampleCurve(...cfg.solvusBeta).map(([T, x]) => [xPix(x), yPix(T, domain)]))} className="apx-curve" />
                    </>
                  )}
                  <line x1={xPix(0)} y1={yPix(cfg.eutectic.Te, domain)} x2={xPix(100)} y2={yPix(cfg.eutectic.Te, domain)} className="apx-curve" />
                </>
              )}

              {/* region labels */}
              <RegionLabels modeKey={modeKey} cfg={cfg} domain={domain} />

              {/* tie line */}
              {showTie && result.tie && (
                <g>
                  <line
                    x1={xPix(result.tie.left)}
                    y1={yPix(temp, domain)}
                    x2={xPix(result.tie.right)}
                    y2={yPix(temp, domain)}
                    className="apx-tie-line"
                  />
                  <circle cx={xPix(result.tie.left)} cy={yPix(temp, domain)} r="4" className="apx-tie-dot" />
                  <circle cx={xPix(result.tie.right)} cy={yPix(temp, domain)} r="4" className="apx-tie-dot" />
                </g>
              )}

              {/* crosshair */}
              <line x1={pointPx[0]} y1={MARGIN.top} x2={pointPx[0]} y2={CHART_H - MARGIN.bottom} className="apx-cross-line" />
              <line x1={MARGIN.left} y1={pointPx[1]} x2={CHART_W - MARGIN.right} y2={pointPx[1]} className="apx-cross-line" />

              {/* draggable overlay + point */}
              <rect
                x={MARGIN.left}
                y={MARGIN.top}
                width={PLOT_W}
                height={PLOT_H}
                fill="transparent"
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
              />
              <circle cx={pointPx[0]} cy={pointPx[1]} r="6.5" className="apx-cross-dot" onPointerDown={onPointerDown} onPointerUp={onPointerUp} />

              {/* axes */}
              <line x1={MARGIN.left} y1={CHART_H - MARGIN.bottom} x2={CHART_W - MARGIN.right} y2={CHART_H - MARGIN.bottom} stroke={COLORS.paper} strokeWidth="1.2" />
              <line x1={MARGIN.left} y1={MARGIN.top} x2={MARGIN.left} y2={CHART_H - MARGIN.bottom} stroke={COLORS.paper} strokeWidth="1.2" />
              {compTicks.map((c) => (
                <text key={"tx" + c} x={xPix(c)} y={CHART_H - MARGIN.bottom + 16} textAnchor="middle" className="apx-tick-label">
                  {c}
                </text>
              ))}
              {tempTicks.map((t) => (
                <text key={"ty" + t} x={MARGIN.left - 8} y={yPix(t, domain) + 3} textAnchor="end" className="apx-tick-label">
                  {t}
                </text>
              ))}
              <text x={MARGIN.left + PLOT_W / 2} y={CHART_H - 10} textAnchor="middle" className="apx-axis-label">
                Composition, wt% {cfg.nameB} ({cfg.nameA} — {cfg.nameB})
              </text>
              <text x={-(MARGIN.top + PLOT_H / 2)} y="16" textAnchor="middle" transform="rotate(-90)" className="apx-axis-label">
                Temperature (°C)
              </text>

              {/* hover tooltip */}
              {hover && (
                <g transform={`translate(${clamp(hover.px + 10, MARGIN.left, CHART_W - 118)}, ${clamp(hover.py - 30, MARGIN.top, CHART_H - 90)})`}>
                  <rect className="apx-tooltip-box" width="108" height="34" rx="5" />
                  <text x="8" y="14" className="apx-tooltip-text">{hover.comp.toFixed(1)} wt% {cfg.nameB}</text>
                  <text x="8" y="27" className="apx-tooltip-text">{hover.temp.toFixed(0)} °C</text>
                </g>
              )}
            </svg>
          </div>

          <div className="apx-control" style={{ marginTop: 14 }}>
            <div className="apx-control-label">
              <span>Overall composition</span>
              <b>{comp.toFixed(1)} wt% {cfg.nameB}</b>
            </div>
            <input
              className="apx-slider"
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={comp}
              onChange={(e) => setComp(parseFloat(e.target.value))}
            />
          </div>
          <div className="apx-control">
            <div className="apx-control-label">
              <span>Temperature</span>
              <b>{temp.toFixed(0)} °C</b>
            </div>
            <input
              className="apx-slider"
              type="range"
              min={domain[0]}
              max={domain[1]}
              step="1"
              value={temp}
              onChange={(e) => setTemp(parseFloat(e.target.value))}
            />
          </div>
        </div>

        {/* -------- RIGHT: readouts, controls, microstructure -------- */}
        <div>
          <div className="apx-panel">
            <p className="apx-panel-title">Live phase composition</p>
            <span className="apx-region-tag">{regionText(result.region)}</span>
            {result.phases.map((p) => (
              <div key={p.key}>
                <div className="apx-readout-row">
                  <Swatch color={phaseColor(p.key)} />
                  <span className="apx-readout-label">{p.label}</span>
                  <span className="apx-readout-value">{p.comp.toFixed(1)} wt% {cfg.nameB}</span>
                </div>
              </div>
            ))}
            <div className="apx-bar">
              {result.phases.map((p) => (
                <div key={p.key} className="apx-bar-seg" style={{ width: (p.fraction * 100).toFixed(1) + "%", background: phaseColor(p.key) }} />
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              {result.phases.map((p) => (
                <span key={p.key} className="apx-readout-value" style={{ fontSize: 11 }}>
                  {(p.fraction * 100).toFixed(1)}% {p.label.split(" ")[0]}
                </span>
              ))}
            </div>
            {result.micro && (
              <p className="apx-footnote" style={{ marginTop: 10 }}>
                Microconstituents (inverse lever rule at T<sub>E</sub>): {(result.micro.wProeutectic * 100).toFixed(1)}% proeutectic {result.micro.proeutectic === "alpha" ? "α" : "β"}, {(result.micro.wEutectic * 100).toFixed(1)}% eutectic mixture.
              </p>
            )}
          </div>

          <div className="apx-panel">
            <p className="apx-panel-title">Controls</p>
            <div className="apx-toggle-row">
              <span className="apx-toggle-label">Show tie lines</span>
              <div className={"apx-switch" + (showTie ? " on" : "")} onClick={() => setShowTie((v) => !v)}>
                <div className="apx-switch-knob" />
              </div>
            </div>
            {modeKey === "isomorphous" && (
              <div className="apx-toggle-row">
                <span className="apx-toggle-label">Cored grains (slow cooling off)</span>
                <div className={"apx-switch" + (cored ? " on" : "")} onClick={() => setCored((v) => !v)}>
                  <div className="apx-switch-knob" />
                </div>
              </div>
            )}
          </div>

          <div className="apx-panel">
            <p className="apx-panel-title">Microstructure schematic</p>
            <svg viewBox={`0 0 ${MICRO_W} ${MICRO_H}`} style={{ width: "100%", height: "auto", borderRadius: 6, border: "1px solid var(--line)" }}>
              {renderMicrostructure()}
            </svg>
            <p className="apx-footnote">
              Stylized grain field — solid color = single phase, striped fill = eutectic α+β lamellae, dots = fine precipitates. Not a literal micrograph.
            </p>
          </div>
        </div>
      </div>

      <p className="apx-footnote">
        All phase boundaries are idealized geometric curves chosen to illustrate the shape and behavior of {cfg.system} diagrams — use for building intuition about the lever rule and solidification microstructure, not for quantitative composition lookups.
      </p>
    </div>
  );
}

function regionFill(cls) {
  if (cls === "liquid") return "rgba(239,107,60,0.14)";
  if (cls === "alpha") return "rgba(91,155,217,0.14)";
  if (cls === "beta") return "rgba(217,164,65,0.14)";
  if (cls === "two") return "rgba(127,224,196,0.07)";
  if (cls === "twoSolid") return "rgba(127,224,196,0.05)";
  return "transparent";
}

function regionText(region) {
  const map = {
    L: "Region: Liquid (L)",
    alpha: "Region: α solid solution",
    beta: "Region: β solid solution",
    "L+alpha": "Region: Liquid + α (two-phase)",
    "L+beta": "Region: Liquid + β (two-phase)",
    "alpha+beta": "Region: α + β (two-phase)",
  };
  return map[region] || region;
}

function RegionLabels({ modeKey, cfg, domain }) {
  const label = (comp, T, text) => (
    <text x={xPix(comp)} y={yPix(T, domain)} textAnchor="middle" className="apx-region-label">
      {text}
    </text>
  );

  if (modeKey === "isomorphous") {
    const Tmid = (cfg.TA + cfg.TB) / 2;
    const xLiq = curveParam(...cfg.liquidus, Tmid);
    const xSol = curveParam(...cfg.solidus, Tmid);
    return (
      <>
        {label(50, domain[1] - (domain[1] - domain[0]) * 0.08, "L")}
        {label((xLiq + xSol) / 2, Tmid, "L + α")}
        {label(50, domain[0] + (domain[1] - domain[0]) * 0.08, "α")}
      </>
    );
  }

  const { Ce, Te, CalphaE, CbetaE } = cfg.eutectic;
  const TmidL = (cfg.TA + Te) / 2 + (cfg.TA - Te) * 0.12; // biased toward the pure-metal side, away from the crowded eutectic corner
  const TmidR = (cfg.TB + Te) / 2 + (cfg.TB - Te) * 0.12;
  const xLiqAtTmidL = curveParam(...cfg.liquidusLeft, TmidL);
  const xLiqAtTmidR = curveParam(...cfg.liquidusRight, TmidR);
  const xSolAtTmidL = modeKey === "eutecticPartial" ? curveParam(...cfg.solidusLeft, TmidL) : 0;
  const xSolAtTmidR = modeKey === "eutecticPartial" ? curveParam(...cfg.solidusRight, TmidR) : 100;
  const TmidSolid = domain[0] + (Te - domain[0]) * 0.45;

  return (
    <>
      {label(50, domain[1] - (domain[1] - domain[0]) * 0.08, "L")}
      {label((xLiqAtTmidL + xSolAtTmidL) / 2, TmidL, "L+α")}
      {label((xLiqAtTmidR + xSolAtTmidR) / 2, TmidR, "L+β")}
      {label((CalphaE + CbetaE) / 2, TmidSolid, "α + β")}
      {modeKey === "eutecticPartial" && label(CalphaE / 2, TmidSolid, "α")}
      {modeKey === "eutecticPartial" && label(CbetaE + (100 - CbetaE) / 2, TmidSolid, "β")}
    </>
  );
}