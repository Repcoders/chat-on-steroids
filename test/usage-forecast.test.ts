import { describe, expect, it } from 'vitest';
import { usageLimitForecast, usageLimitSegment } from '../src/shared/usage.js';

const minute = 60000;
const at = (minutes: number, value: number) => ({ at: 1_800_000_000_000 + minutes * minute, value });

describe('limit pace estimate', () => {
  it('starts a limit\'s trend again when it goes up, after a reset or a refill', () => {
    expect(usageLimitSegment([at(0, 50), at(10, 40), at(20, 90), at(30, 90), at(40, 80)])).toEqual([at(20, 90), at(30, 90), at(40, 80)]);
    expect(usageLimitSegment([])).toEqual([]);
  });

  it('says when a limit runs out at the pace of about the last hour', () => {
    // 60 → 40 over the last hour: 20 an hour, so 40 more lasts two hours.
    const readings = [at(0, 90), at(60, 60), at(90, 50), at(120, 40)];
    expect(usageLimitForecast(readings, null)).toEqual({ runsOutAt: at(240, 0).at, beforeReset: true });
    expect(usageLimitForecast(readings, at(200, 0).at)).toEqual({ runsOutAt: at(240, 0).at, beforeReset: false });
  });

  it('measures a young window from its start', () => {
    expect(usageLimitForecast([at(0, 30), at(20, 20)], null)?.runsOutAt).toBe(at(60, 0).at);
  });

  it('gives no estimate with too little history, no use, or nothing left', () => {
    expect(usageLimitForecast([at(0, 30)], null)).toBeNull();
    expect(usageLimitForecast([at(0, 30), at(5, 20)], null)).toBeNull();
    expect(usageLimitForecast([at(0, 30), at(60, 30)], null)).toBeNull();
    expect(usageLimitForecast([at(0, 30), at(60, 0)], null)).toBeNull();
    // A refill twenty minutes ago leaves only the new window, which is too short to judge.
    expect(usageLimitForecast([at(0, 50), at(40, 20), at(100, 90), at(105, 80)], null)).toBeNull();
  });
});
