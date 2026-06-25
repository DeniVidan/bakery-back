import { PrismaClient } from '@prisma/client';

const localPrisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://postgres:3e4eeBpt@localhost:5432/bakery_db?schema=public'
    }
  }
});

const remotePrisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://postgres.vdrhzoojbxlhlceqxarl:3e4eeBpt32xGuzfn@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?schema=public'
    }
  }
});

async function main() {
  console.log('🔄 Starting full database migration from local to Supabase...');

  // 1. Fetch from Local
  console.log('📥 Reading data from local database...');
  const settings = await localPrisma.setting.findMany();
  const users = await localPrisma.user.findMany();
  const products = await localPrisma.product.findMany();
  const productVariants = await localPrisma.productVariant.findMany();
  const recipes = await localPrisma.recipe.findMany();
  const weeklyMenus = await localPrisma.weeklyMenu.findMany();
  const weeklyMenuProducts = await localPrisma.weeklyMenuProduct.findMany();
  const batches = await localPrisma.batch.findMany();
  const orders = await localPrisma.order.findMany();
  const orderItems = await localPrisma.orderItem.findMany();
  const standingOrders = await localPrisma.standingOrder.findMany();

  console.log(`\n✅ Loaded from local:
  - Settings: ${settings.length}
  - Users: ${users.length}
  - Products: ${products.length}
  - Variants: ${productVariants.length}
  - Recipes: ${recipes.length}
  - Weekly Menus: ${weeklyMenus.length}
  - Weekly Menu Products: ${weeklyMenuProducts.length}
  - Batches: ${batches.length}
  - Orders: ${orders.length}
  - Order Items: ${orderItems.length}
  - Standing Orders: ${standingOrders.length}
  `);

  // 2. Wipe Remote in reverse dependency order
  console.log('🧹 Clearing existing data on Supabase...');
  await remotePrisma.standingOrder.deleteMany();
  await remotePrisma.orderItem.deleteMany();
  await remotePrisma.order.deleteMany();
  await remotePrisma.batch.deleteMany();
  await remotePrisma.weeklyMenuProduct.deleteMany();
  await remotePrisma.weeklyMenu.deleteMany();
  await remotePrisma.recipe.deleteMany();
  await remotePrisma.productVariant.deleteMany();
  await remotePrisma.product.deleteMany();
  await remotePrisma.user.deleteMany();
  await remotePrisma.setting.deleteMany();
  console.log('✅ Supabase database cleared.\n');

  // 3. Write to Remote in dependency order
  console.log('📤 Writing data to Supabase...');

  if (settings.length > 0) {
    await remotePrisma.setting.createMany({ data: settings });
    console.log(`- Settings migrated: ${settings.length}`);
  }

  if (users.length > 0) {
    await remotePrisma.user.createMany({ data: users });
    console.log(`- Users migrated: ${users.length}`);
  }

  if (products.length > 0) {
    await remotePrisma.product.createMany({ data: products });
    console.log(`- Products migrated: ${products.length}`);
  }

  if (productVariants.length > 0) {
    await remotePrisma.productVariant.createMany({ data: productVariants });
    console.log(`- Product Variants migrated: ${productVariants.length}`);
  }

  if (recipes.length > 0) {
    // To be 100% safe with JSON fields across Prisma client versions, create individually in a transaction
    await remotePrisma.$transaction(
      recipes.map(recipe => remotePrisma.recipe.create({ data: recipe as any }))
    );
    console.log(`- Recipes migrated: ${recipes.length}`);
  }

  if (weeklyMenus.length > 0) {
    await remotePrisma.weeklyMenu.createMany({ data: weeklyMenus });
    console.log(`- Weekly Menus migrated: ${weeklyMenus.length}`);
  }

  if (weeklyMenuProducts.length > 0) {
    await remotePrisma.weeklyMenuProduct.createMany({ data: weeklyMenuProducts });
    console.log(`- Weekly Menu Products migrated: ${weeklyMenuProducts.length}`);
  }

  if (batches.length > 0) {
    await remotePrisma.batch.createMany({ data: batches });
    console.log(`- Batches migrated: ${batches.length}`);
  }

  if (orders.length > 0) {
    await remotePrisma.order.createMany({ data: orders });
    console.log(`- Orders migrated: ${orders.length}`);
  }

  if (orderItems.length > 0) {
    await remotePrisma.orderItem.createMany({ data: orderItems });
    console.log(`- Order Items migrated: ${orderItems.length}`);
  }

  if (standingOrders.length > 0) {
    await remotePrisma.standingOrder.createMany({ data: standingOrders });
    console.log(`- Standing Orders migrated: ${standingOrders.length}`);
  }

  console.log('\n🎉 Migration completed successfully! Your Supabase database is now completely synchronized with your local state.');
}

main()
  .catch(async (e) => {
    console.error('❌ Error migrating database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await localPrisma.$disconnect();
    await remotePrisma.$disconnect();
  });
