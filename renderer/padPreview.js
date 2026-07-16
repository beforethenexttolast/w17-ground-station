// SEAT FIT layout preview: a schematic gamepad showing which physical controls
// the HUD mirrors for the chosen preset (shared/inputPresets.mjs).
//
// DISPLAY / INPUT-MIRROR ONLY. It draws the mirrored buttons AND both sticks so
// the operator can see, on the controller screen, which stick steers and which
// stick aims the camera. Drawing the RIGHT stick here is the authorized
// relaxation of the earlier depiction convention (docs/camera_aim_display_semantics.md
// §2.1): the sticks are labelled as STICK INPUT, never as measured camera aim,
// and this file adds NO control path (the no-control-path sweep still covers it).
//
// The button pills/circles carry `data-role` hooks so SEAT FIT can light up
// pressed buttons live; the two stick live-dots carry `data-stick` hooks so
// SEAT FIT can position them from the observed axes (renderer/setupFlow.js
// seatfitTick). Styling lives in hud.css (.pp-* classes).

import { getPreset } from '../shared/inputPresets.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A stick well: outer field circle, a center crosshair, a clear NEUTRAL centre
// marker, and a live dot (positioned by seatfitTick via its data-stick hook).
// The live dot starts centred so a padless/first paint reads as neutral.
const stick = (cx, cy, r, sideKey) =>
  `<circle class="pp-stick" cx="${cx}" cy="${cy}" r="${r}"/>` +
  `<line class="pp-cross" x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}"/>` +
  `<line class="pp-cross" x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}"/>` +
  `<circle class="pp-neutral" cx="${cx}" cy="${cy}" r="3"/>` +
  `<circle class="pp-stickdot" data-stick="${sideKey}" data-cx="${cx}" data-cy="${cy}" cx="${cx}" cy="${cy}" r="5"/>`;

export function padPreviewSvg(presetKey) {
  const n = getPreset(presetKey).buttonNames;
  const pill = (x, y, name, dataRole) =>
    `<rect class="pp-pill" data-role="${dataRole}" x="${x}" y="${y}" width="56" height="18" rx="5"/>` +
    `<text class="pp-name" x="${x + 28}" y="${y + 13}" text-anchor="middle">${esc(name)}</text>`;
  const caption = (x, y, anchor, role, name) =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}">` +
    `<tspan class="pp-role">${esc(role)} </tspan><tspan class="pp-name">${esc(name)}</tspan></text>`;
  return `<svg viewBox="0 0 440 224" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="controller layout and live input preview">
    ${pill(50, 8, n.brake, 'brake')}<text class="pp-role" x="114" y="21">BRAKE</text>
    ${pill(50, 32, n.gearDown, 'gearDown')}<text class="pp-role" x="114" y="45">GEAR &#9660;</text>
    ${pill(334, 8, n.throttle, 'throttle')}<text class="pp-role" x="326" y="21" text-anchor="end">THROTTLE</text>
    ${pill(334, 32, n.gearUp, 'gearUp')}<text class="pp-role" x="326" y="45" text-anchor="end">GEAR &#9650;</text>
    <rect class="pp-body" x="40" y="64" width="360" height="120" rx="36"/>

    <!-- face-button cluster (centre) -->
    <circle class="pp-ctl" data-role="drs" cx="220" cy="86" r="12"/>
    ${caption(220, 74, 'middle', 'DRS', n.drs)}
    <circle class="pp-ctl" data-role="overtake" cx="198" cy="108" r="12"/>
    ${caption(180, 112, 'end', 'OT', n.overtake)}
    <circle class="pp-ctl" data-role="boost" cx="242" cy="108" r="12"/>
    ${caption(260, 112, 'start', 'BOOST', n.boost)}
    <circle class="pp-ctl dim" cx="220" cy="130" r="12"/>

    <!-- LEFT stick = steering -->
    ${stick(112, 138, 24, 'left')}
    ${caption(112, 200, 'middle', 'LEFT STICK ·', 'STEERING')}

    <!-- RIGHT stick = camera pan/tilt · stick-input mirror only -->
    ${stick(328, 138, 24, 'right')}
    <text class="pp-dir" x="328" y="110" text-anchor="middle">&#9650;</text>
    <text class="pp-dir" x="328" y="170" text-anchor="middle">&#9660;</text>
    <text class="pp-dir" x="298" y="142" text-anchor="middle">&#9664;</text>
    <text class="pp-dir" x="358" y="142" text-anchor="middle">&#9654;</text>
    ${caption(328, 200, 'middle', 'RIGHT STICK ·', 'PAN / TILT')}
    <text class="pp-sub" x="328" y="214" text-anchor="middle">CAMERA · STICK INPUT</text>
  </svg>`;
}
