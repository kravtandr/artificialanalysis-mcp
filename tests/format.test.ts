import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION,
  finishText,
  fmtBool,
  fmtNum,
  fmtUsd,
  mdTable,
  quotaWarning,
  staleNotice,
} from '../src/format.js';

describe('formatting primitives', () => {
  it('renders null and undefined as an em dash, numbers compactly', () => {
    expect(fmtNum(null)).toBe('—');
    expect(fmtNum(undefined)).toBe('—');
    expect(fmtNum(3)).toBe('3');
    expect(fmtNum(3.14159)).toBe('3.14');
    expect(fmtUsd(0.06)).toBe('$0.06');
    expect(fmtUsd(null)).toBe('—');
    expect(fmtBool(true)).toBe('yes');
    expect(fmtBool(null)).toBe('—');
  });

  it('builds a markdown table and escapes pipes', () => {
    const table = mdTable(
      ['Model', 'Price'],
      [
        ['a|b', '$1'],
        ['c', '$2'],
      ],
    );
    expect(table.split('\n')).toEqual([
      '| Model | Price |',
      '| --- | --- |',
      '| a\\|b | $1 |',
      '| c | $2 |',
    ]);
  });
});

describe('finishText', () => {
  it('always ends with the attribution line', () => {
    const text = finishText(['body']);
    expect(text.split('\n').at(-1)).toBe(ATTRIBUTION);
  });

  it('injects warnings with a warning marker before the attribution', () => {
    const text = finishText(['body'], ['quota low', '⚠ already marked']);
    expect(text).toContain('⚠ quota low');
    expect(text).toContain('⚠ already marked');
    expect(text.indexOf('quota low')).toBeLessThan(text.indexOf(ATTRIBUTION));
  });
});

describe('notices', () => {
  it('mentions the UTC timestamp of stale data', () => {
    const notice = staleNotice(new Date('2026-07-10T06:00:00Z'));
    expect(notice).toContain('2026-07-10T06:00:00.000Z');
    expect(notice).toContain('UTC');
  });

  it('mentions the remaining quota', () => {
    expect(quotaWarning(3)).toContain('3');
  });
});
