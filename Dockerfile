FROM node:6.9.5

MAINTAINER gpaes@uolinc.com

WORKDIR /usr/src/app

# Instala dependências npm
COPY package.json /usr/src/app/
RUN npm install

# Copia todo o projeto para a imagem
COPY . /usr/src/app

# Comando de start do container
CMD ["npm", "start"]
