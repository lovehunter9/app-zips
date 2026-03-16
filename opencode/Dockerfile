FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai@latest && npm cache clean --force

RUN useradd -m -s /bin/bash -u 1000 opencode

USER 1000
WORKDIR /home/opencode/workspace
ENV HOME=/home/opencode
ENV TERM=xterm-256color

EXPOSE 3000

CMD ["opencode", "web", "--hostname", "0.0.0.0", "--port", "3000"]
