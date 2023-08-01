FROM ghcr.io/onedr0p/ubuntu:jammy-20230624

ARG VERSION

ENV NVIDIA_DRIVER_CAPABILITIES="compute,video,utility"

# hadolint ignore=DL3008,DL3015,SC2086
RUN \
    apt-get -qq update \
    && \
    apt-get -qq install -y \
        gnupg2 curl \
    && \
    curl -sL https://repositories.intel.com/graphics/intel-graphics.key | apt-key add - \
    && \
    echo 'deb [arch=amd64] https://repositories.intel.com/graphics/ubuntu jammy main' > /etc/apt/sources.list.d/intel.list \
    && \
    export EXTRA_INSTALL_ARG='intel-media-va-driver-non-free nvidia-opencl-icd-340 i965-va-driver mesa-va-drivers' \
    && \
    apt-get -qq update \
    && \
    apt-get -qq install -y \
        intel-media-va-driver-non-free i965-va-driver mesa-va-drivers \
        ca-certificates libnvidia-compute-525-server libnvidia-decode-525-server libnvidia-encode-525-server \
        ${EXTRA_INSTALL_ARG} \
    && \
    curl -fsSL "https://repo.jellyfin.org/ubuntu/jellyfin_team.gpg.key" | apt-key add -  \
    && \
    echo "deb [arch=amd64] https://repo.jellyfin.org/ubuntu jammy main" | tee /etc/apt/sources.list.d/jellyfin.list && \
    apt-get -qq update && \
    apt-get -qq install -y \
        jellyfin-server="${VERSION}*" \
        jellyfin-web \
        jellyfin-ffmpeg5 \
    && \
    apt-get remove -y gnupg2 \
    && apt-get purge -y --auto-remove \
    && apt-get autoremove -y \
    && apt-get clean \
    && \
    rm -rf \
        /tmp/* \
        /var/lib/apt/lists/* \
        /var/tmp/ \
    && printf "umask %d\n" "${UMASK}" >> /etc/bash.bashrc

COPY ./entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]

LABEL org.opencontainers.image.source="https://github.com/jellyfin/jellyfin"
