'use strict';

class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(task) {
    const next = this.tail.then(task, task);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

module.exports = { Mutex };
