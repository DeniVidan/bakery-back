const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const settings = await prisma.setting.findMany();
  console.log('--- DB Settings ---');
  for (const s of settings) {
    console.log(`Key: ${s.key}`);
    console.log(`Value: ${s.value}\n`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
