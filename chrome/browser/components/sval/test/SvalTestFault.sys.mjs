/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Fails an engine's worker calls for a test, and fails the test when the
 * failure it asked for never happened. A task that injects a fault and then
 * asserts only that everything else went on passes as well when the call it
 * meant to break was never made, as after the worker method is renamed.
 */

/**
 * Makes `engine`'s worker calls named `method` reject while `when` holds for
 * their arguments, at most `times` times.
 *
 * @param {SvalEngine} engine The engine whose `post` to break.
 * @param {string} method The worker method to fail.
 * @param {object} [options]
 * @param {Function} [options.when] Takes the call's arguments; true fails it.
 * @param {number} [options.times] How many calls to fail.
 * @param {Function} [options.error] Makes the error each failed call rejects with.
 * @returns {{fired: number, mend: Function}} `fired` counts the failed calls.
 *   `mend()` restores `post` and throws if no call failed.
 */
export function failEngineCalls(
  engine,
  method,
  {
    when = () => true,
    times = Infinity,
    error = () => new Error(`injected failure of ${method}`),
  } = {}
) {
  const own = Object.hasOwn(engine, "post");
  const post = engine.post;
  const fault = {
    fired: 0,
    mend() {
      if (own) {
        engine.post = post;
      } else {
        delete engine.post;
      }
      if (!fault.fired) {
        throw new Error(`no ${method} call was made to fail`);
      }
    },
  };
  engine.post = (called, ...args) => {
    if (called === method && fault.fired < times && when(...args)) {
      fault.fired++;
      return Promise.reject(error());
    }
    return post.call(engine, called, ...args);
  };
  return fault;
}
