FROM node:18-alpine

WORKDIR /app

# 拷贝 package 文件并安装依赖
COPY package*.json ./
RUN npm install --production

# 拷贝源代码
COPY . .

EXPOSE 3000


CMD ["node", "index.js"]