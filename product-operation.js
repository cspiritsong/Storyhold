/**
 * Shares one in-flight product operation among automatic and manual callers.
 *
 * Product ingestion owns a chat's metadata and prompt state for the duration of
 * a model call. A single gate prevents two event sources from creating separate
 * queues and racing those writes.
 */
export function captureProductOperationIdentity({
  generation,
  chatId,
  chatUid,
  responder,
  metadata = undefined,
} = {}) {
  const identity = {
    generation,
    chatId,
    chatUid,
    responder,
  };
  if (metadata !== undefined) identity.metadata = metadata;
  return Object.freeze(identity);
}

export function createProductOperationGate() {
  let active = null;
  const pending = new Map();

  function startNext() {
    if (active || pending.size === 0) return;
    const [key, entry] = pending.entries().next().value;
    pending.delete(key);

    const operationPromise = Promise.resolve().then(entry.operation);
    active = { key, result: entry.promise, operationPromise };
    operationPromise.then(entry.resolve, entry.reject);
    operationPromise.then(
      () => finish(operationPromise),
      () => finish(operationPromise),
    );
  }

  function finish(operationPromise) {
    if (active?.operationPromise !== operationPromise) return;
    active = null;
    startNext();
  }

  return {
    isRunning(key = undefined) {
      if (key === undefined) return active !== null || pending.size > 0;
      return active?.key === key || pending.has(key);
    },

    run(operation, key = 'default') {
      if (typeof operation !== 'function') throw new TypeError('operation must be a function');
      if (active?.key === key) return active.result;
      const queued = pending.get(key);
      if (queued) return queued.promise;

      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pending.set(key, { operation, promise, resolve, reject });
      startNext();
      return promise;
    },
  };
}
