# Promoters Performance System

Professional branch sales performance, target allocation and invoice tracking platform.

## Departments
TV-AC · MDA · MOBILE · SDA

## Stack
Next.js 15 · React 19 · TypeScript · Prisma · PostgreSQL

## Environment
Set DATABASE_URL, DIRECT_URL, ADMIN_PASSWORD and a strong AUTH_SECRET in Vercel/server environment variables.

## Live
https://promoters-performance-system-eta.vercel.app

## Database
Run `npx prisma generate`, then `npx prisma db push` for a new database. Seed with `npm run db:seed`.

## Production rules
Never commit .env files. Manager authentication is server-side. Historical months remain isolated from current target allocation.

<!-- deployment trigger: prisma-schema-fix -->