import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Helper to normalize any date to the starting Monday of that week
const getMondayOfDate = (date: Date) => {
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(date.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
};

async function main() {
  console.log('🌱 Starting database seeding...');

  // 1. Clean out existing data
  await prisma.standingOrder.deleteMany({});
  await prisma.weeklyMenuProduct.deleteMany({});
  await prisma.weeklyMenu.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.batch.deleteMany({});
  await prisma.recipe.deleteMany({});
  await prisma.productVariant.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});

  // 2. Create Users
  const adminPassword = await bcrypt.hash('admin123', 10);
  const customerPassword = await bcrypt.hash('customer123', 10);
  const pendingPassword = await bcrypt.hash('pending123', 10);

  const admin = await prisma.user.create({
    data: {
      name: 'Marie Antoinette (Admin)',
      email: 'admin@bakery.com',
      password: adminPassword,
      role: 'ADMIN',
      status: 'APPROVED',
      phone: '+33612345678',
    },
  });

  const approvedCustomer = await prisma.user.create({
    data: {
      name: 'John Doe (Approved)',
      email: 'customer@bakery.com',
      password: customerPassword,
      role: 'CUSTOMER',
      status: 'APPROVED',
      phone: '+385994460717',
    },
  });

  const pendingCustomer = await prisma.user.create({
    data: {
      name: 'Alice Springs (Pending)',
      email: 'newbie@pending.com',
      password: pendingPassword,
      role: 'CUSTOMER',
      status: 'PENDING',
      phone: '+33699999999',
    },
  });

  console.log(`👤 Created Users:`);
  console.log(`   - Admin: ${admin.email} (password: admin123)`);
  console.log(`   - Customer (Approved): ${approvedCustomer.email} (password: customer123)`);
  console.log(`   - Customer (Pending): ${pendingCustomer.email} (password: pending123)`);

  // 3. Create Products, Variants and Recipes with specific Flour breakdowns

  // Product 1: Country Sourdough (Multi-flour: 70% Manitoba, 20% Whole Wheat, 10% Rye)
  const sourdoughFlours = [
    { name: 'Manitoba', percentage: 70 },
    { name: 'Whole Wheat', percentage: 20 },
    { name: 'Rye', percentage: 10 },
  ];

  const sourdough = await prisma.product.create({
    data: {
      name: 'Country Sourdough',
      description: 'Slow-fermented wild yeast loaf with a blistered crust and custard-like crumb.',
      variants: {
        create: [
          {
            size: 'Small (500g)',
            price: 6.5,
            recipe: {
              create: {
                flour: 250,
                water: 175,
                starter: 50,
                salt: 5,
                extraIngredients: [],
                floursBreakdown: sourdoughFlours,
              },
            },
          },
          {
            size: 'Medium (800g)',
            price: 9.0,
            recipe: {
              create: {
                flour: 400,
                water: 280,
                starter: 80,
                salt: 8,
                extraIngredients: [],
                floursBreakdown: sourdoughFlours,
              },
            },
          },
          {
            size: 'Large (1200g)',
            price: 13.5,
            recipe: {
              create: {
                flour: 600,
                water: 420,
                starter: 120,
                salt: 12,
                extraIngredients: [],
                floursBreakdown: sourdoughFlours,
              },
            },
          },
        ],
      },
    },
    include: { variants: true },
  });

  // Product 2: French Baguette (100% Type 00)
  const baguetteFlours = [
    { name: 'Type 00', percentage: 100 },
  ];

  const baguette = await prisma.product.create({
    data: {
      name: 'French Baguette',
      description: 'Traditional thin loaf of French bread, crisp crust, airy interior.',
      variants: {
        create: [
          {
            size: 'Standard (350g)',
            price: 3.5,
            recipe: {
              create: {
                flour: 220,
                water: 145,
                starter: 0,
                salt: 4.5,
                extraIngredients: [{ name: 'Instant Yeast', grams: 2 }],
                floursBreakdown: baguetteFlours,
              },
            },
          },
        ],
      },
    },
    include: { variants: true },
  });

  // Product 3: Butter Croissant (100% Manitoba)
  const croissantFlours = [
    { name: 'Manitoba', percentage: 100 },
  ];

  const croissant = await prisma.product.create({
    data: {
      name: 'Butter Croissant',
      description: 'Flaky, laminated French pastry enriched with grass-fed European butter.',
      variants: {
        create: [
          {
            size: 'Single',
            price: 4.0,
            recipe: {
              create: {
                flour: 55,
                water: 20,
                starter: 0,
                salt: 1.2,
                extraIngredients: [
                  { name: 'Butter (Lamination)', grams: 30 },
                  { name: 'Sugar', grams: 6 },
                  { name: 'Milk Powder', grams: 2 },
                  { name: 'Yeast', grams: 1.5 },
                ],
                floursBreakdown: croissantFlours,
              },
            },
          },
          {
            size: 'Box of 4',
            price: 14.0,
            recipe: {
              create: {
                flour: 220,
                water: 80,
                starter: 0,
                salt: 4.8,
                extraIngredients: [
                  { name: 'Butter (Lamination)', grams: 120 },
                  { name: 'Sugar', grams: 24 },
                  { name: 'Milk Powder', grams: 8 },
                  { name: 'Yeast', grams: 6 },
                ],
                floursBreakdown: croissantFlours,
              },
            },
          },
        ],
      },
    },
    include: { variants: true },
  });

  // Product 4: Cinnamon Bun (Standard flat flour)
  const cinnamonBun = await prisma.product.create({
    data: {
      name: 'Cinnamon Bun',
      description: 'Soft brioche bun rolled with sweet cinnamon sugar and topped with vanilla bean glaze.',
      variants: {
        create: [
          {
            size: 'Single',
            price: 4.5,
            recipe: {
              create: {
                flour: 65,
                water: 10,
                starter: 0,
                salt: 1.0,
                extraIngredients: [
                  { name: 'Butter', grams: 15 },
                  { name: 'Milk', grams: 20 },
                  { name: 'Sugar', grams: 12 },
                  { name: 'Cinnamon Sugar Filling', grams: 18 },
                  { name: 'Glaze', grams: 10 },
                  { name: 'Yeast', grams: 1.5 },
                ],
                floursBreakdown: undefined, // Test flat flour fallback (Bread Flour 100%)
              },
            },
          },
        ],
      },
    },
    include: { variants: true },
  });

  console.log(`🍞 Created Products with Variants, Recipes, and Flour Breakdowns:`);
  console.log(`   - Country Sourdough (Small, Medium, Large) -> 70% Manitoba, 20% Whole Wheat, 10% Rye`);
  console.log(`   - French Baguette (Standard) -> 100% Type 00`);
  console.log(`   - Butter Croissant (Single, Box of 4) -> 100% Manitoba`);
  console.log(`   - Cinnamon Bun (Single) -> 100% Fallback Bread Flour`);

  // 4. Create Weekly Menu for current week
  const currentMonday = getMondayOfDate(new Date());
  const weeklyMenu = await prisma.weeklyMenu.create({
    data: {
      weekStartDate: currentMonday,
    },
  });

  // Link products to weekly menu
  await prisma.weeklyMenuProduct.createMany({
    data: [
      { weeklyMenuId: weeklyMenu.id, productId: sourdough.id },
      { weeklyMenuId: weeklyMenu.id, productId: baguette.id },
      { weeklyMenuId: weeklyMenu.id, productId: croissant.id },
      { weeklyMenuId: weeklyMenu.id, productId: cinnamonBun.id },
    ],
  });

  console.log(`📅 Created Weekly Menu starting on: ${currentMonday.toDateString()}`);

  // 5. Create Sample Orders with Pickup Slots
  const sourdoughMediumVariant = (sourdough as any).variants.find((v: any) => v.size.includes('Medium'))!;
  const sourdoughSmallVariant = (sourdough as any).variants.find((v: any) => v.size.includes('Small'))!;
  const baguetteVariant = (baguette as any).variants[0];
  const croissantBoxVariant = (croissant as any).variants.find((v: any) => v.size.includes('Box of 4'))!;
  const cinnamonBunVariant = (cinnamonBun as any).variants[0];

  // Order 1: Sourdough + Baguette (Saturday slot)
  await prisma.order.create({
    data: {
      userId: approvedCustomer.id,
      status: 'PENDING',
      pickupSlot: 'Saturday 09:00 - 10:30',
      createdAt: new Date(),
      items: {
        create: [
          { productVariantId: sourdoughMediumVariant.id, quantity: 2 },
          { productVariantId: baguetteVariant.id, quantity: 3 },
        ],
      },
    },
  });

  // Order 2: Croissants + Cinnamon Bun (Saturday slot)
  await prisma.order.create({
    data: {
      userId: approvedCustomer.id,
      status: 'PENDING',
      pickupSlot: 'Saturday 10:30 - 12:00',
      createdAt: new Date(),
      items: {
        create: [
          { productVariantId: croissantBoxVariant.id, quantity: 1 },
          { productVariantId: cinnamonBunVariant.id, quantity: 4 },
        ],
      },
    },
  });

  // Order 3: Mix of Sourdough Small and Cinnamon Bun (Sunday slot)
  await prisma.order.create({
    data: {
      userId: approvedCustomer.id,
      status: 'PENDING',
      pickupSlot: 'Sunday 10:00 - 12:00',
      createdAt: new Date(),
      items: {
        create: [
          { productVariantId: sourdoughSmallVariant.id, quantity: 1 },
          { productVariantId: cinnamonBunVariant.id, quantity: 2 },
        ],
      },
    },
  });

  console.log(`📦 Seeded 3 Custom Orders with Pickup Slots assigned.`);

  // 6. Create active Standing Order (Subscription template) for the approved customer
  await prisma.standingOrder.create({
    data: {
      userId: approvedCustomer.id,
      productVariantId: sourdoughMediumVariant.id,
      quantity: 1,
      pickupSlot: 'Saturday 09:00 - 10:30',
      active: true,
    },
  });

  console.log(`🔄 Seeded active repeating Standing Order (Country Sourdough Medium - Qty: 1) for John Doe.`);
  console.log('🎉 Database Seeding Completed Successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
