// SEAT FIT wheel input preview: a schematic steering wheel + pedal bars showing
// which mirrored wheel controls the HUD observes (shared/wheelProfile.mjs).
//
// DISPLAY / INPUT-MIRROR ONLY — the sibling of renderer/padPreview.js, built to
// the same conventions. Driving stays with elrs-joystick-control, which reads
// the device itself; NOTHING here reaches a control output (the no-control-path
// sweep covers this file automatically). The vocabulary is deliberately the same
// as the pad preview: it shows observed INPUT, never "camera aim"/"measured"/a
// gimbal position — a wheel has no aim stick, so no camera-motion claim is made.
//
// Live hooks (updated by renderer/setupFlow.js seatfitTick, never re-rendered
// per tick): the steering needle carries data-wheel="steer" (rotated from the
// observed steering axis); the two pedal fills carry data-wheel="thr"/"brk"
// (height driven by the calibrated 0..1 travel); each button pill carries a
// data-role hook so a pressed mirrored button lights up. Styling lives in
// hud.css (.wp-* classes).

// The steering wheel geometry: the needle pivots on (cx, cy) and its rotation is
// applied by seatfitTick via a `rotate(deg cx cy)` transform, so the pivot must
// travel with the SVG in data-cx/data-cy (mirrors padPreview's stick dots).
const WHEEL = { cx: 66, cy: 74, rim: 46, needleTop: 30 };
// Pedal bars anchor at the bottom (y0) and grow UP; seatfitTick sets each fill's
// height to travel*h and its y to y0 - travel*h. y0/h live in data-* so the
// renderer never re-derives the geometry.
const BAR = { y0: 122, h: 100, w: 24 };

export function wheelPreviewSvg() {
  // A button pill: role label inside, data-role hook for the live press mirror.
  // role is a trusted literal (may carry intentional entities e.g. &#9650;),
  // interpolated unescaped exactly like padPreview's pill role; there is no
  // dynamic/user text in this viz.
  const pill = (x, role, dataRole) =>
    `<rect class="wp-pill" data-role="${dataRole}" x="${x}" y="152" width="46" height="18" rx="4"/>` +
    `<text class="wp-btn" x="${x + 23}" y="165" text-anchor="middle">${role}</text>`;
  const bar = (x, key, label) =>
    `<rect class="wp-track" x="${x}" y="${BAR.y0 - BAR.h}" width="${BAR.w}" height="${BAR.h}" rx="3"/>` +
    `<rect class="wp-fill ${key}" data-wheel="${key}" data-y0="${BAR.y0}" data-h="${BAR.h}" ` +
    `x="${x}" y="${BAR.y0}" width="${BAR.w}" height="0"/>` +
    `<text class="wp-sub" x="${x + BAR.w / 2}" y="136" text-anchor="middle">${label}</text>`;
  return `<svg viewBox="0 0 260 214" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="steering wheel and pedal live input preview">
    <!-- STEERING wheel: rim + hub + a needle that rotates with the observed steer axis -->
    <circle class="wp-rim" cx="${WHEEL.cx}" cy="${WHEEL.cy}" r="${WHEEL.rim}"/>
    <line class="wp-cross" x1="${WHEEL.cx - WHEEL.rim}" y1="${WHEEL.cy}" x2="${WHEEL.cx + WHEEL.rim}" y2="${WHEEL.cy}"/>
    <line class="wp-needle" data-wheel="steer" data-cx="${WHEEL.cx}" data-cy="${WHEEL.cy}" transform="rotate(0 ${WHEEL.cx} ${WHEEL.cy})" x1="${WHEEL.cx}" y1="${WHEEL.cy}" x2="${WHEEL.cx}" y2="${WHEEL.needleTop}"/>
    <circle class="wp-hub" cx="${WHEEL.cx}" cy="${WHEEL.cy}" r="6"/>
    <text class="wp-sub" x="${WHEEL.cx}" y="136" text-anchor="middle">STEER</text>

    <!-- PEDAL bars: analog travel 0..1 through the calibrated rest/full endpoints -->
    ${bar(150, 'thr', 'THR')}
    ${bar(196, 'brk', 'BRK')}

    <!-- mirrored BUTTON roles (light on press) -->
    ${pill(4, 'GEAR &#9650;', 'gearUp')}
    ${pill(54, 'GEAR &#9660;', 'gearDown')}
    ${pill(104, 'DRS', 'drs')}
    ${pill(154, 'BOOST', 'boost')}
    ${pill(204, 'OT', 'overtake')}

    <!-- display-semantics label: observed INPUT, never a car/camera-motion claim -->
    <text class="wp-obs" x="130" y="188" text-anchor="middle">OBSERVED WHEEL INPUT</text>
    <text class="wp-obs" x="130" y="204" text-anchor="middle">NOT PROOF OF CAR / CAMERA MOTION</text>
  </svg>`;
}
