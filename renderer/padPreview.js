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
  // A shoulder pill carries its live-highlight hook (data-role) with the mapped
  // button name AND its role BOTH inside the pill (e.g. "R2 · THR"), so no
  // floating caption is needed — the pills attach to the body's top corners.
  // The name is its own tspan so a per-preset label stays greppable as `>NAME<`.
  // BOTH name and role are esc()'d (Batch 7 / Batch-6 rider b): the glyphs are
  // literal Unicode (▲/▼), not HTML entities, so escaping is a no-op on today's
  // trusted literals yet closes the unescaped-interpolation trap for any future
  // label.
  const pill = (x, y, name, dataRole, role) =>
    `<rect class="pp-pill" data-role="${dataRole}" x="${x}" y="${y}" width="88" height="18" rx="5"/>` +
    `<text x="${x + 44}" y="${y + 13}" text-anchor="middle">` +
    `<tspan class="pp-name">${esc(name)}</tspan><tspan class="pp-role"> · ${esc(role)}</tspan></text>`;
  const caption = (x, y, anchor, role, name) =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}">` +
    `<tspan class="pp-role">${esc(role)} </tspan><tspan class="pp-name">${esc(name)}</tspan></text>`;
  return `<svg viewBox="0 0 440 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="controller layout and live input preview">
    <rect class="pp-body" x="40" y="40" width="360" height="132" rx="32"/>

    <!-- shoulder pills: mapped name + role INSIDE each pill, attached to the body's top corners -->
    ${pill(48, 50, n.brake, 'brake', 'BRAKE')}
    ${pill(48, 72, n.gearDown, 'gearDown', 'GEAR ▼')}
    ${pill(304, 50, n.throttle, 'throttle', 'THR')}
    ${pill(304, 72, n.gearUp, 'gearUp', 'GEAR ▲')}

    <!-- face-button cluster (centre): DRS above, OT + BOOST below with captions
         middle-anchored under each button. The lower pair is spread to cx186/256
         so the two captions never collide with each other, sit clear below their
         buttons, and the worst-case "BOOST B1" (centred at 256) still clears the
         right-stick well (x304+). -->
    <circle class="pp-ctl" data-role="drs" cx="220" cy="90" r="12"/>
    ${caption(220, 74, 'middle', 'DRS', n.drs)}
    <circle class="pp-ctl" data-role="overtake" cx="186" cy="116" r="12"/>
    ${caption(186, 142, 'middle', 'OT', n.overtake)}
    <circle class="pp-ctl" data-role="boost" cx="256" cy="116" r="12"/>
    ${caption(256, 142, 'middle', 'BOOST', n.boost)}

    <!-- LEFT stick = steering -->
    ${stick(112, 130, 24, 'left')}
    ${caption(112, 184, 'middle', 'LEFT STICK ·', 'STEERING')}

    <!-- RIGHT stick = camera pan/tilt · stick-input mirror only -->
    ${stick(328, 130, 24, 'right')}
    <text class="pp-dir" x="328" y="104" text-anchor="middle">&#9650;</text>
    <text class="pp-dir" x="328" y="162" text-anchor="middle">&#9660;</text>
    <text class="pp-dir" x="298" y="134" text-anchor="middle">&#9664;</text>
    <text class="pp-dir" x="358" y="134" text-anchor="middle">&#9654;</text>
    ${caption(328, 184, 'middle', 'RIGHT STICK ·', 'PAN / TILT')}
    <text class="pp-sub" x="328" y="196" text-anchor="middle">CAMERA · STICK INPUT</text>
  </svg>`;
}
