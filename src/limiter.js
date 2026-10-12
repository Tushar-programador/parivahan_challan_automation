// Runs async tasks with at most `max` in flight; extra tasks wait in submission order.
function createLimiter(max) {
  const limit = Number.isInteger(max) && max >= 1 ? max : 1;
  let active = 0;
  const waiting = [];

  function next() {
    if (active >= limit || waiting.length === 0) return;
    active += 1;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  }

  return (task) => new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    next();
  });
}

module.exports = { createLimiter };
