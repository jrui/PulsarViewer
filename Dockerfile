FROM node:22.15.0-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . ./
EXPOSE 3000
CMD ["npm", "run", "dev"]
