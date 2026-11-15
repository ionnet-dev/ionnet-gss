# syntax=docker/dockerfile:1
# ionnet-gss-minecraft-server:java<N>: the base image plus a Temurin JRE (M2). One tag per Java line:
# java8, java17, java21, java25 (images/build.sh passes JAVA). game.yml picks it with `image: …:java{{vars.java}}`.

ARG BASE=ghcr.io/ionnet-dev/ionnet-gss-base:latest
FROM ${BASE}
ARG JAVA=21
# TODO(builder): A — Temurin from packages.adoptium.net (signed apt repo) or the release tarball with a pinned sha256,
# installed under /opt/java with `java` on PATH; verify with `java -version` at build time.
RUN echo "Temurin ${JAVA} goes here" > /dev/null
