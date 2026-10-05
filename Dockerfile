FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.ts tsconfig.json ./

ENV HOME=/tmp
USER 33:0

CMD ["npm", "run", "watch"]
