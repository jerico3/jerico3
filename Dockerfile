FROM node:22-alpine
WORKDIR /app
COPY package.json *.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/sorteio.db DB_PATH_DENTRO_DO_APP_OK=1
VOLUME /app/data
EXPOSE 3000
CMD ["npm", "start"]
