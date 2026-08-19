import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Checking database table counts & columns...');
  
  // 1. Ensure priceOverride exists
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "priceOverride" DOUBLE PRECISION;
  `);

  // 2. Test model queries
  const userCount = await prisma.user.count();
  const productCount = await prisma.product.count();
  const orderCount = await prisma.order.count();
  const orderItemCount = await prisma.orderItem.count();
  const batchCount = await prisma.batch.count();
  const settingCount = await prisma.setting.count();

  console.log('--- DATABASE STATUS ---');
  console.log(`Users: ${userCount}`);
  console.log(`Products: ${productCount}`);
  console.log(`Orders: ${orderCount}`);
  console.log(`OrderItems: ${orderItemCount}`);
  console.log(`Batches: ${batchCount}`);
  console.log(`Settings: ${settingCount}`);
  console.log('-----------------------');

  // Test fetching sample order to ensure no missing column errors
  const sampleOrder = await prisma.order.findFirst({
    include: {
      items: {
        include: {
          productVariant: {
            include: {
              product: true
            }
          }
        }
      },
      user: true
    }
  });

  console.log('Sample Order query successful:', sampleOrder ? `ID: ${sampleOrder.id}, Items: ${sampleOrder.items.length}` : 'No orders found');
}

main()
  .catch((err) => {
    console.error('Error verifying database:', err);
  })
  .finally(() => prisma.$disconnect());
