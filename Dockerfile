FROM node:22-slim
RUN npm install -g pnpm tsx
WORKDIR /app

COPY . .
RUN pnpm install --no-frozen-lockfile && cd packages/web && npx vite build

ENV UICLAW_HOST=0.0.0.0
ENV UICLAW_PORT=3800
EXPOSE 3800

CMD ["tsx", "packages/server/src/index.ts"]
