// Cloud shapes stay immutable in world space. Camera movement only selects
// conservative bank spheres; a stable selection reuses its GPU instance buffer.
export class CloudVisibility {
  constructor(clouds, { margin = 1.15 } = {}) {
    this.clouds = clouds;
    this.margin = margin;
    this.matrix = new Float64Array(16);
    this.planes = new Float64Array(24);
    this.selected = [];
    this.data = new Float32Array(clouds.instances.length);
    this.count = 0;
    this.evaluations = 0;
    this.uploads = 0;
    this.valid = false;
  }
  update(matrix, radius = 0) {
    if (this.valid && radius === this.radius && this.matrix.every((v, i) => v === matrix[i]))
      return false;
    this.valid = true;
    this.radius = radius;
    this.matrix.set(matrix);
    this.evaluations++;
    // Six clip planes, column-major matrix. A guard band retains banks just
    // outside the viewport so entering clouds do not pop at the visible edge.
    for (let p = 0; p < 6; p++) {
      const axis = p >> 1,
        sign = p % 2 ? -1 : 1,
        margin = axis < 2 ? this.margin : 1,
        o = p * 4;
      let length = 0;
      for (let k = 0; k < 4; k++) {
        const v = margin * matrix[k * 4 + 3] + sign * matrix[k * 4 + axis];
        this.planes[o + k] = v;
        if (k < 3) length += v * v;
      }
      length = Math.sqrt(length);
      if (length > 0) for (let k = 0; k < 4; k++) this.planes[o + k] /= length;
    }
    let count = 0,
      changed = false;
    for (let id = 0; id < this.clouds.banks.length; id++) {
      const bank = this.clouds.banks[id],
        c = bank.centre,
        r = bank.radius;
      if (radius > 0 && Math.hypot(c[0], c[1]) > radius + r) continue;
      let visible = true;
      for (let p = 0; p < 24; p += 4)
        if (
          this.planes[p] * c[0] +
            this.planes[p + 1] * c[1] +
            this.planes[p + 2] * c[2] +
            this.planes[p + 3] <
          -r
        ) {
          visible = false;
          break;
        }
      if (!visible) continue;
      if (this.selected[count] !== id) changed = true;
      this.selected[count++] = id;
    }
    changed ||= count !== this.selected.length;
    this.selected.length = count;
    if (!changed) return false;
    let offset = 0;
    for (const id of this.selected) {
      const bank = this.clouds.banks[id],
        start = bank.start * 7,
        end = (bank.start + bank.count) * 7;
      this.data.set(this.clouds.instances.subarray(start, end), offset);
      offset += end - start;
    }
    this.count = offset / 7;
    this.uploads++;
    return true;
  }
  get stats() {
    return {
      banks: this.clouds.banks.length,
      visibleBanks: this.selected.length,
      instances: this.clouds.count,
      visibleInstances: this.count,
      evaluations: this.evaluations,
      uploads: this.uploads,
    };
  }
}
