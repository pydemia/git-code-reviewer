// Test-process instrumentation only. No URLs, headers, credentials or response
// bodies leave the HTTPS request; the production transport remains unchanged.
import https from 'node:https';

export function traceIdentityRequests(origin, observe) {
  const original = https.request;
  let nextRequest = 0;
  const traced = function (...args) {
    let url;
    try {
      url = new URL(args[0]);
    } catch {
      return Reflect.apply(original, this, args);
    }
    if (url.origin !== origin) return Reflect.apply(original, this, args);
    const requestId = ++nextRequest;
    const operation =
      url.pathname === '/realms/master/protocol/openid-connect/token'
        ? 'bootstrap-token'
        : url.pathname === '/realms/master/protocol/openid-connect/logout'
          ? 'bootstrap-logout'
          : url.pathname.startsWith('/admin/realms/')
            ? 'admin-request'
            : 'realm-request';
    const started = performance.now();
    const emit = (phase, fields = {}) => {
      try {
        observe({
          requestId,
          operation,
          phase,
          elapsedMs: Math.round(performance.now() - started),
          ...fields,
        });
      } catch {
        // Diagnostics must not change authentication, request outcomes or cleanup.
      }
    };
    emit('start');
    const outgoing = Reflect.apply(original, this, args);
    outgoing.once('socket', (socket) => {
      emit('socket', { reused: outgoing.reusedSocket === true });
      socket.once('lookup', (error) => emit(error ? 'dns-failed' : 'dns-resolved'));
      socket.once('connect', () => emit('tcp-connected'));
      socket.once('secureConnect', () => emit('tls-connected'));
    });
    outgoing.once('finish', () => emit('request-sent'));
    outgoing.once('response', (response) => {
      emit('response-headers', { status: response.statusCode });
      response.once('end', () => emit('response-end'));
      response.once('aborted', () => emit('response-aborted'));
      response.once('error', () => emit('response-error'));
    });
    outgoing.once('error', () => emit('request-error'));
    outgoing.once('close', () => emit('request-close'));
    return outgoing;
  };
  https.request = traced;
  return () => {
    if (https.request === traced) https.request = original;
  };
}
