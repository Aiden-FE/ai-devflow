import { describe, expect, it } from 'vitest';
import { laneToExpert } from '../expert-routing.js';

describe('laneToExpert', () => {
  it('执行泳道映射到执行专家', () => {
    expect(laneToExpert('in_progress')).toBe('dev');
    expect(laneToExpert('testing')).toBe('test');
  });

  it('非执行泳道返回 undefined（无 agent）', () => {
    expect(laneToExpert('ready')).toBeUndefined();
    expect(laneToExpert('in_review')).toBeUndefined();
    expect(laneToExpert('archived')).toBeUndefined();
  });
});
