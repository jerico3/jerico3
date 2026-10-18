FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/sorteio.db
VOLUME /app/data
EXPOSE 3000
CMD ["npm", "start"]
