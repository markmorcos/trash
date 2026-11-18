# WhatsApp bridge: bundle whatsapp/index.ts (and the shared code it uses)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Baileys fixes applied on install (see patches/README.md)
COPY patches ./patches
RUN npm ci
COPY . .
RUN npm run build:bridge

# Runtime: production dependencies + the bundle only
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8081
COPY package.json package-lock.json ./
# Baileys fixes applied on install (see patches/README.md)
COPY patches ./patches
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/whatsapp.js ./dist/whatsapp.js
USER node
EXPOSE 8081
CMD ["node", "dist/whatsapp.js"]
