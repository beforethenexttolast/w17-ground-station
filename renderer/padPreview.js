// SEAT FIT layout preview: a schematic gamepad showing which physical
// buttons the HUD mirrors for the chosen preset (shared/inputPresets.mjs).
// INFORMATIONAL ONLY — it draws the mirrored actions and nothing else. The
// right stick / camera is deliberately absent: pan/tilt mapping is outside
// this app's authority (safety boundaries) and must not be drawn or added
// here. Styling lives in hud.css (.pp-* classes).

import { getPreset } from '../shared/inputPresets.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The pills and action circles carry data-role hooks so SEAT FIT can light
// up pressed buttons live (class toggles from shared/inputPresets.mjs
// pressedRoles — still display only; the left stick and dim circle have no
// role on purpose).
export function padPreviewSvg(presetKey) {
  const n = getPreset(presetKey).buttonNames;
  const pill = (x, y, name, dataRole) =>
    `<rect class="pp-pill" data-role="${dataRole}" x="${x}" y="${y}" width="56" height="18" rx="5"/>` +
    `<text class="pp-name" x="${x + 28}" y="${y + 13}" text-anchor="middle">${esc(name)}</text>`;
  const caption = (x, y, anchor, role, name) =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}">` +
    `<tspan class="pp-role">${esc(role)} </tspan><tspan class="pp-name">${esc(name)}</tspan></text>`;
  return `<svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="controller layout preview">
    ${pill(46, 8, n.brake, 'brake')}<text class="pp-role" x="110" y="21">BRAKE</text>
    ${pill(46, 32, n.gearDown, 'gearDown')}<text class="pp-role" x="110" y="45">GEAR &#9660;</text>
    ${pill(298, 8, n.throttle, 'throttle')}<text class="pp-role" x="290" y="21" text-anchor="end">THROTTLE</text>
    ${pill(298, 32, n.gearUp, 'gearUp')}<text class="pp-role" x="290" y="45" text-anchor="end">GEAR &#9650;</text>
    <rect class="pp-body" x="40" y="64" width="320" height="100" rx="50"/>
    <circle class="pp-ctl" cx="110" cy="114" r="20"/><circle class="pp-dot" cx="110" cy="114" r="6"/>
    ${caption(110, 152, 'middle', 'LEFT STICK ·', 'STEER')}
    <circle class="pp-ctl" data-role="drs" cx="275" cy="88" r="12"/>
    ${caption(275, 72, 'middle', 'DRS', n.drs)}
    <circle class="pp-ctl" data-role="boost" cx="301" cy="114" r="12"/>
    ${caption(319, 118, 'start', 'BOOST', n.boost)}
    <circle class="pp-ctl" data-role="overtake" cx="249" cy="114" r="12"/>
    ${caption(231, 118, 'end', 'OVERTAKE', n.overtake)}
    <circle class="pp-ctl dim" cx="275" cy="140" r="12"/>
  </svg>`;
}
