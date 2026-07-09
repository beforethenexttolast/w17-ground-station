import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseTasklistCsv,
  parsePgrepOutput,
  imageNameFromPath,
} = require('../shared/processList.js');

describe('parseTasklistCsv — locale-proof CSV row counting', () => {
  const csv = [
    '"elrs-joystick-control.exe","4242","Console","1","58,124 K"',
    '"elrs-joystick-control.exe","4243","Console","1","12,004 K"',
  ].join('\r\n');

  it('counts rows whose first column equals the image (case-insensitive)', () => {
    expect(parseTasklistCsv(csv, 'elrs-joystick-control.exe')).toBe(2);
    expect(parseTasklistCsv(csv, 'ELRS-Joystick-Control.EXE')).toBe(2);
  });

  it('the localized "no tasks" info sentence counts as zero', () => {
    expect(parseTasklistCsv(
      'INFO: No tasks are running which match the specified criteria.',
      'elrs-joystick-control.exe',
    )).toBe(0);
    expect(parseTasklistCsv(
      'INFORMATION: Es werden keine Aufgaben mit den angegebenen Kriterien ausgeführt.',
      'elrs-joystick-control.exe',
    )).toBe(0);
  });

  it('a different image name does not match', () => {
    expect(parseTasklistCsv(csv, 'other.exe')).toBe(0);
  });
});

describe('parsePgrepOutput', () => {
  it('counts PID lines only', () => {
    expect(parsePgrepOutput('1234\n5678\n')).toBe(2);
    expect(parsePgrepOutput('')).toBe(0);
    expect(parsePgrepOutput('pgrep: invalid option')).toBe(0);
  });
});

describe('imageNameFromPath — both slash styles', () => {
  it('extracts the basename', () => {
    expect(imageNameFromPath('C:\\Tools\\elrs\\elrs-joystick-control.exe'))
      .toBe('elrs-joystick-control.exe');
    expect(imageNameFromPath('/opt/elrs/elrs-joystick-control'))
      .toBe('elrs-joystick-control');
    expect(imageNameFromPath('')).toBe('');
  });
});
