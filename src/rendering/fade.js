// Fades in time: a value that goes from where it is to a target over
// `duration` ms, eased (smoothstep: no step at either end). Read with
// value(now) on every frame that draws it; active(now) says whether the
// frames must go on being asked for (none once it has arrived: a page at rest
// draws nothing). No allocation: a frame reads numbers only.

/** 0 at t <= 0, 1 at t >= 1, the cubic Hermite ease between. */
export function smoothstep(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

export class Fade {
  /** value: where it starts (and stays until set()); duration: ms of a whole fade. */
  constructor(value = 1, duration = 400) {
    this.from = this.to = value;
    this.at = -Infinity;
    this.duration = duration;
  }
  /**
   * Go to `target` from the value at `now` (a fade under way turns back from
   * where it is, never from its end). false when it was going there already.
   */
  set(target, now) {
    if (target === this.to) return false;
    this.from = this.value(now);
    this.to = target;
    this.at = now;
    // a short way takes its share of the time: the same speed as a whole fade
    this.span = this.duration * Math.min(1, Math.abs(this.to - this.from) || 1);
    return true;
  }
  /** At `target` at once (no fade). */
  jump(target) {
    this.from = this.to = target;
    this.at = -Infinity;
  }
  value(now) {
    const t = (now - this.at) / (this.span ?? this.duration);
    return t >= 1 ? this.to : this.from + (this.to - this.from) * smoothstep(t);
  }
  /** Still on its way at `now`: the frames are asked for until it is not. */
  active(now) {
    return now - this.at < (this.span ?? this.duration);
  }
}
