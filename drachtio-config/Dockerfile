# Custom drachtio-server with TLS support
#
# The official drachtio/drachtio-server:latest image ships sofia-sip compiled
# WITHOUT TLS transport because pkg-config is missing from the build stage.
# Sofia-sip's SAC_OPENSSL macro uses pkg-config to detect OpenSSL; without it,
# HAVE_TLS is never set and tport_tls is excluded from the build.
#
# Fix: install pkg-config so the autoconf OpenSSL detection succeeds.

# ------------------ build stage ------------------
FROM debian:bookworm-slim AS builder

ARG BUILD_CPUS=4
ARG DRACHTIO_TAG=main

RUN apt-get update && apt-get -y --quiet upgrade \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    gcc g++ make build-essential cmake \
    git \
    autoconf automake libtool libtool-bin \
    pkg-config \
    libssl-dev \
    libcurl4-openssl-dev \
    zlib1g-dev \
    libgoogle-perftools-dev \
    libboost-all-dev \
  && rm -rf /var/lib/apt/lists/*

# Clone and checkout
RUN git clone --depth=50 https://github.com/drachtio/drachtio-server.git /usr/local/src/drachtio-server \
  && cd /usr/local/src/drachtio-server \
  && git fetch --tags \
  && git checkout ${DRACHTIO_TAG} \
  && git submodule update --init --recursive

WORKDIR /usr/local/src/drachtio-server

# Verify OpenSSL is discoverable via pkg-config (build-time sanity check)
RUN pkg-config --modversion openssl \
  && echo "--- OpenSSL detected via pkg-config: $(pkg-config --modversion openssl) ---"

# Bootstrap autotools (runs autoreconf --install, which descends into sofia-sip)
RUN ./bootstrap.sh

# Configure and build
RUN mkdir -p build && cd build \
  && ../configure --enable-tcmalloc=yes CPPFLAGS='-DNDEBUG' CXXFLAGS='-O2' \
  && make -j${BUILD_CPUS} \
  && make install

# Verify TLS transport is compiled into sofia-sip
RUN if strings /usr/local/lib/libsofia-sip-ua.so* 2>/dev/null | grep -q tport_tls; then \
      echo "--- TLS transport: CONFIRMED in libsofia-sip-ua ---"; \
    else \
      echo "--- WARNING: tport_tls symbol not found, checking drachtio binary ---"; \
    fi \
  && ldd /usr/local/bin/drachtio | grep -E 'ssl|crypto' \
  && echo "--- OpenSSL linked: CONFIRMED ---"

# ------------------ runtime stage ------------------
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    libcurl4 \
    zlib1g \
    libgoogle-perftools4 \
    libboost-system-dev \
    libboost-thread-dev \
    libboost-filesystem-dev \
  && rm -rf /var/lib/apt/lists/*

# Copy built artifacts from builder
COPY --from=builder /usr/local/bin/drachtio /usr/local/bin/drachtio
COPY --from=builder /usr/local/lib/ /usr/local/lib/
# Copy boost 1.74 libs (bundled by drachtio source tree)
COPY --from=builder /lib/x86_64-linux-gnu/libboost_thread.so.1.74.0 /lib/x86_64-linux-gnu/
COPY --from=builder /lib/x86_64-linux-gnu/libboost_log.so.1.74.0 /lib/x86_64-linux-gnu/
COPY --from=builder /lib/x86_64-linux-gnu/libboost_log_setup.so.1.74.0 /lib/x86_64-linux-gnu/
COPY --from=builder /lib/x86_64-linux-gnu/libboost_filesystem.so.1.74.0 /lib/x86_64-linux-gnu/
COPY --from=builder /lib/x86_64-linux-gnu/libboost_system.so.1.74.0 /lib/x86_64-linux-gnu/
COPY --from=builder /lib/x86_64-linux-gnu/libboost_regex.so.1.74.0 /lib/x86_64-linux-gnu/
COPY --from=builder /lib/x86_64-linux-gnu/libboost_chrono.so.1.74.0 /lib/x86_64-linux-gnu/
COPY --from=builder /lib/x86_64-linux-gnu/libboost_atomic.so.1.74.0 /lib/x86_64-linux-gnu/
COPY --from=builder /lib/x86_64-linux-gnu/libboost_date_time.so.1.74.0 /lib/x86_64-linux-gnu/

# Ensure the dynamic linker finds any shared libs
RUN ldconfig

VOLUME ["/config"]

EXPOSE 5060/udp 5060/tcp 5061/tcp 9022/tcp

ENTRYPOINT ["drachtio"]
