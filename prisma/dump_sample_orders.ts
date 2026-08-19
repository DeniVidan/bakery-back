import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const orders = await prisma.order.findMany({
    take: 10,
    include: {
      user: true,
      items: {
        include: {
          productVariant: {
            include: {
              product: true
            }
          }
        }
      }
    }
  });

  console.log('Sample orders:', JSON.stringify(orders, null, 2));
}

main().finally(() => prisma.$disconnect());
