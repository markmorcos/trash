FROM node:20-alpine
WORKDIR /app
COPY . .
EXPOSE 8080
ENV PORT=8080
CMD ["node", "index.js"]
