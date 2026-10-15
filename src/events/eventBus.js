
const EventEmitter = require('events');

class NSPEventBus extends EventEmitter {
  constructor() {
    super();

    // Prevent unhandled "error" events and centralize listener error logging.
    this.on('error', (error) => {
      console.error('[EventBus] Listener error:', error);
    });
  }

  /**
   * Emit an event without allowing a listener failure to stop other listeners.
   *
   * @param {string | symbol} eventName - Event name to emit.
   * @param {*} payload - Data passed to each listener.
   * @returns {boolean} True if all listeners completed without a synchronous
   * error; false if any listener threw synchronously.
   *
   * Note: Async listener failures are caught and logged, but they cannot
   * change the boolean return value because Promise rejections happen later.
   */
  emitSafely(eventName, payload) {
    const listeners = this.rawListeners(eventName);
    let success = true;

    for (const listener of listeners) {
      try {
        // Calling raw listeners preserves EventEmitter behavior for once().
        const result = listener.call(this, payload);

        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch((error) => {
            this.reportListenerError(error, eventName);
          });
        }
      } catch (error) {
        success = false;
        this.reportListenerError(error, eventName);
      }
    }

    return success;
  }

  /**
   * Report listener errors without letting error reporting break event flow.
   */
  reportListenerError(error, eventName) {
    const listenerError =
      error instanceof Error ? error : new Error(String(error));

    listenerError.eventName = eventName;

    try {
      this.emit('error', listenerError);
    } catch (reportingError) {
      // Protect event delivery even if a custom "error" listener throws.
      console.error(
        '[EventBus] Error while reporting listener failure:',
        reportingError
      );
      console.error('[EventBus] Original listener error:', listenerError);
    }
  }
}

// Export one shared instance throughout the application.
const eventBus = new NSPEventBus();

module.exports = eventBus;
