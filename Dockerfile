FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      git fd-find jq make gcc g++ python3 python3-pip tree ripgrep gh \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @earendil-works/pi-coding-agent@0.85.1
WORKDIR /workspace
