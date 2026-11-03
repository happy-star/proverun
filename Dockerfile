FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["npm", "start"]
