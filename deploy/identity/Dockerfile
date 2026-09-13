# The upstream index is also used by the SAML and administration contract tests.
FROM quay.io/keycloak/keycloak:26.7.3@sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54 AS builder
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=true
# Bound build-time JVM allocation independently of the builder host's RAM/CPUs.
RUN JAVA_OPTS_KC_HEAP="-Xms128m -Xmx768m" \
    JAVA_OPTS_APPEND="-XX:ActiveProcessorCount=2" /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7.3@sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54
COPY --from=builder --chown=1000:1000 /opt/keycloak/ /opt/keycloak/
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=true
ARG REVISION=unreleased
LABEL org.opencontainers.image.title="GCR Identity" \
      org.opencontainers.image.version="26.7.3-gcr.1" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.base.name="quay.io/keycloak/keycloak:26.7.3" \
      org.opencontainers.image.base.digest="sha256:ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54"
USER 1000:1000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized"]
