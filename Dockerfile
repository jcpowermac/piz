FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      git jq make gcc g++ python3 python3-pip tree ripgrep gh \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @earendil-works/pi-coding-agent@0.85.1
WORKDIR /workspace
