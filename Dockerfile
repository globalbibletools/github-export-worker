# syntax=docker/dockerfile:1

FROM public.ecr.aws/lambda/nodejs:18 AS base

FROM base AS build
WORKDIR /app
COPY package*.json .
RUN npm ci
COPY . .
RUN npm run build
 
FROM base
COPY package*.json ${LAMBDA_TASK_ROOT}
RUN npm ci --omit=dev
COPY --from=build /app/dist ${LAMBDA_TASK_ROOT}
CMD ["dist/index.handler"]

