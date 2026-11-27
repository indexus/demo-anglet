// Traces need equality/identity, not another full radial plan per event. Keep
// this dictionary bounded; evicted plans receive a new identity if revisited.
export class TraceReferences {
  constructor(limit = 64) {
    this.limit = limit;
    this.ids = new Map();
    this.serial = 0;
  }
  get(value) {
    if (typeof value !== "string" || value.length < 120) return value;
    let id = this.ids.get(value);
    if (!id) {
      id = "plan#" + ++this.serial;
      this.ids.set(value, id);
      if (this.ids.size > this.limit) this.ids.delete(this.ids.keys().next().value);
    }
    return id;
  }
}
