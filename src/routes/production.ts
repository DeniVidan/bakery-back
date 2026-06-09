import { Router, Response } from 'express';
import prisma from '../prisma';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Helper to normalize any date to the starting Monday of that week
const getMondayOfDate = (dateStr?: string) => {
  const date = dateStr ? new Date(dateStr) : new Date();
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(date.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
};

// 1. AUTOMATIC INGREDIENT CALCULATION ENGINE
// Can calculate ingredients by:
//   - ?week=YYYY-MM-DD (sums up all CONFIRMED or PENDING orders for that week)
//   - ?batchId=uuid
//   - ?orderIds=id1,id2,id3
router.get('/calculations', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { week, batchId, orderIds } = req.query;

  try {
    // Fetch doughWasteFactor from settings
    const doughWasteSetting = await prisma.setting.findUnique({
      where: { key: 'doughWasteFactor' },
    });
    const doughWasteFactorStr = doughWasteSetting?.value;
    const doughWasteFactor = (doughWasteFactorStr && !isNaN(parseFloat(doughWasteFactorStr))) ? parseFloat(doughWasteFactorStr) : 5; // default 5%
    const multiplier = 1 + (doughWasteFactor / 100);

    let ordersToProcess: any[] = [];

    if (orderIds) {
      const ids = (orderIds as string).split(',').filter(Boolean);
      ordersToProcess = await prisma.order.findMany({
        where: { id: { in: ids } },
        include: {
          items: {
            include: {
              productVariant: {
                include: {
                  product: true,
                  recipe: true,
                },
              },
            },
          },
        },
      });
    } else if (batchId) {
      ordersToProcess = await prisma.order.findMany({
        where: { batchId: batchId as string },
        include: {
          items: {
            include: {
              productVariant: {
                include: {
                  product: true,
                  recipe: true,
                },
              },
            },
          },
        },
      });
    } else {
      // Default to the current week's orders if nothing specified
      const targetMonday = getMondayOfDate(week as string);
      const nextMonday = new Date(targetMonday);
      nextMonday.setDate(targetMonday.getDate() + 7);

      ordersToProcess = await prisma.order.findMany({
        where: {
          createdAt: {
            gte: targetMonday,
            lt: nextMonday,
          },
          status: { in: ['PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'BAKED'] },
        },
        include: {
          items: {
            include: {
              productVariant: {
                include: {
                  product: true,
                  recipe: true,
                },
              },
            },
          },
        },
      });
    }

    // Accumulators for ingredients
    let totalFlour = 0;
    let totalWater = 0;
    let totalSalt = 0;
    let totalStarter = 0;
    const extraIngredientsMap: Record<string, number> = {};
    const floursBreakdownMap: Record<string, number> = {};
    const startersMap: Record<string, number> = {}; // starterName -> grams

    const productBreakdown: Record<
      string,
      {
        productName: string;
        variantSize: string;
        quantity: number;
        flour: number;
        water: number;
        salt: number;
        starter: number;
        extraIngredients: Record<string, number>;
        floursBreakdown: Record<string, number>;
      }
    > = {};

    const missingRecipes: string[] = [];

    // Loop through all orders and calculate
    for (const order of ordersToProcess) {
      for (const item of order.items) {
        const variant = item.productVariant;
        const recipe = variant.recipe;
        const qty = item.quantity;
        const key = `${variant.product.name} (${variant.size})`;

        if (!recipe) {
          missingRecipes.push(key);
          continue;
        }

        const scaledQty = qty * multiplier;
        const flourWeightForThisItem = recipe.flour * scaledQty;

        // Add to main totals
        totalFlour += recipe.flour * scaledQty;
        totalWater += recipe.water * scaledQty;
        totalSalt += recipe.salt * scaledQty;
        totalStarter += recipe.starter * scaledQty;
        const sName = (!recipe.starterName || recipe.starterName === 'default') ? 'Standard Sourdough Starter' : recipe.starterName;
        startersMap[sName] = (startersMap[sName] || 0) + recipe.starter * scaledQty;

        // Process flours breakdown
        let floursBreakdown: any[] = [];
        if (recipe.floursBreakdown) {
          try {
            floursBreakdown = typeof recipe.floursBreakdown === 'string'
              ? JSON.parse(recipe.floursBreakdown)
              : (recipe.floursBreakdown as any);
          } catch (e) {
            floursBreakdown = [];
          }
        }

        if (Array.isArray(floursBreakdown) && floursBreakdown.length > 0) {
          for (const fb of floursBreakdown) {
            if (fb && fb.name && typeof fb.percentage === 'number') {
              const fbWeight = (fb.percentage / 100) * flourWeightForThisItem;
              floursBreakdownMap[fb.name] = (floursBreakdownMap[fb.name] || 0) + fbWeight;
            }
          }
        } else {
          floursBreakdownMap['Bread Flour'] = (floursBreakdownMap['Bread Flour'] || 0) + flourWeightForThisItem;
        }

        // Process extra ingredients
        let extras: any[] = [];
        if (recipe.extraIngredients) {
          try {
            extras = typeof recipe.extraIngredients === 'string' 
              ? JSON.parse(recipe.extraIngredients) 
              : (recipe.extraIngredients as any);
          } catch (e) {
            extras = [];
          }
        }

        if (Array.isArray(extras)) {
          for (const extra of extras) {
            if (extra && extra.name && typeof extra.grams === 'number') {
              extraIngredientsMap[extra.name] = (extraIngredientsMap[extra.name] || 0) + extra.grams * scaledQty;
            }
          }
        }

        // Add to product breakdown
        if (!productBreakdown[variant.id]) {
          productBreakdown[variant.id] = {
            productName: variant.product.name,
            variantSize: variant.size,
            quantity: 0,
            flour: 0,
            water: 0,
            salt: 0,
            starter: 0,
            extraIngredients: {},
            floursBreakdown: {},
          };
        }

        const pb = productBreakdown[variant.id];
        pb.quantity += qty;
        pb.flour += recipe.flour * scaledQty;
        pb.water += recipe.water * scaledQty;
        pb.salt += recipe.salt * scaledQty;
        pb.starter += recipe.starter * scaledQty;

        if (Array.isArray(floursBreakdown) && floursBreakdown.length > 0) {
          for (const fb of floursBreakdown) {
            if (fb && fb.name && typeof fb.percentage === 'number') {
              const fbWeight = (fb.percentage / 100) * (recipe.flour * scaledQty);
              pb.floursBreakdown[fb.name] = (pb.floursBreakdown[fb.name] || 0) + fbWeight;
            }
          }
        } else {
          pb.floursBreakdown['Bread Flour'] = (pb.floursBreakdown['Bread Flour'] || 0) + (recipe.flour * scaledQty);
        }

        if (Array.isArray(extras)) {
          for (const extra of extras) {
            if (extra && extra.name && typeof extra.grams === 'number') {
              pb.extraIngredients[extra.name] = (pb.extraIngredients[extra.name] || 0) + extra.grams * scaledQty;
            }
          }
        }
      }
    }

    const extrasList = Object.entries(extraIngredientsMap).map(([name, grams]) => ({
      name,
      grams,
    }));

    const floursBreakdownList = Object.entries(floursBreakdownMap).map(([name, grams]) => ({
      name,
      grams,
    }));

    const startersBreakdownList = Object.entries(startersMap).map(([name, grams]) => ({
      name,
      grams,
    }));

    return res.json({
      summary: {
        totalFlourGrams: totalFlour,
        totalWaterGrams: totalWater,
        totalSaltGrams: totalSalt,
        totalStarterGrams: totalStarter,
        totalDoughWeightGrams: totalFlour + totalWater + totalSalt + totalStarter + extrasList.reduce((acc, curr) => acc + curr.grams, 0),
        extras: extrasList,
        floursBreakdown: floursBreakdownList,
        startersBreakdown: startersBreakdownList,
      },
      productBreakdown: Object.values(productBreakdown),
      ordersCount: ordersToProcess.length,
      missingRecipes: Array.from(new Set(missingRecipes)),
    });
  } catch (error) {
    console.error('Error in calculation engine:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Generate a new Production Batch from confirmed orders or add to existing
router.post('/batches', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { date, orderIds, batchId } = req.body;

  if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: 'Order IDs are required' });
  }

  try {
    let targetBatchId = batchId;

    if (batchId) {
      const existingBatch = await prisma.batch.findUnique({
        where: { id: batchId },
      });

      if (!existingBatch) {
        return res.status(404).json({ error: 'Target batch not found' });
      }

      if (existingBatch.status !== 'DRAFT') {
        return res.status(400).json({ error: 'Cannot add orders to a locked or non-draft batch' });
      }
    } else {
      const batchDate = date ? new Date(date) : new Date();
      const batch = await prisma.batch.create({
        data: {
          date: batchDate,
          status: 'DRAFT',
        },
      });
      targetBatchId = batch.id;
    }

    // Link selected orders to this batch
    await prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: {
        batchId: targetBatchId,
        status: 'CONFIRMED', // Set to confirmed once batched
      },
    });

    const finalBatch = await prisma.batch.findUnique({
      where: { id: targetBatchId },
      include: {
        orders: {
          include: {
            user: { select: { name: true, email: true } },
            items: {
              include: {
                productVariant: {
                  include: {
                    product: true,
                    recipe: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    return res.status(201).json({
      message: batchId ? 'Orders added to existing batch successfully' : 'Production batch generated successfully',
      batch: finalBatch
    });
  } catch (error) {
    console.error('Error handling batch endpoint:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Get all batches
router.get('/batches', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const batches = await prisma.batch.findMany({
      include: {
        orders: {
          include: {
            items: {
              include: {
                productVariant: {
                  include: {
                    product: true,
                    recipe: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { date: 'desc' },
    });
    return res.json({ batches });
  } catch (error) {
    console.error('Error listing batches:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Get a single batch details & generate HTML thermal labels
router.get('/batches/:id', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const batch = await prisma.batch.findUnique({
      where: { id },
      include: {
        orders: {
          include: {
            user: { select: { name: true, email: true, phone: true } },
            items: {
              include: {
                productVariant: {
                  include: {
                    product: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    // Generate printable HTML and thermal roll codes for labels
    const labelItems: any[] = [];
    const formattedDate = new Date(batch.date).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

    batch.orders.forEach((order) => {
      order.items.forEach((item) => {
        for (let i = 0; i < item.quantity; i++) {
          labelItems.push({
            labelId: `${order.id.slice(0, 4)}-${item.id.slice(0, 4)}-${i + 1}`,
            productName: item.productVariant?.product?.name || 'Unknown Product',
            variantSize: item.productVariant?.size || 'Unknown Size',
            customerName: order.user?.name || 'Unknown Customer',
            bakeDate: formattedDate,
            batchId: batch.id.slice(0, 8),
            qrCodeValue: `BAKE-${batch.id.slice(0, 8)}-ORDER-${order.id.slice(0, 8)}`,
          });
        }
      });
    });

    return res.json({
      batch,
      labels: labelItems,
    });
  } catch (error) {
    console.error('Error fetching batch details:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper to adjust backend pantryStock when a batch is locked (deducted) or unlocked/deleted (restored)
async function adjustPantryStockForBatch(batchId: string, action: 'deduct' | 'restore') {
  try {
    // 1. Fetch the batch with orders and items
    const orders = await prisma.order.findMany({
      where: { batchId },
      include: {
        items: {
          include: {
            productVariant: {
              include: {
                recipe: true,
              },
            },
          },
        },
      },
    });

    // 2. Aggregate all ingredients used in this batch
    let saltGrams = 0;
    let starterGrams = 0;
    const floursMap: Record<string, number> = {}; // ingredientName -> grams
    const extrasMap: Record<string, number> = {}; // ingredientName -> grams

    for (const order of orders) {
      for (const item of order.items) {
        const recipe = item.productVariant?.recipe;
        if (!recipe) continue;

        const qty = item.quantity;
        saltGrams += (recipe.salt || 0) * qty;
        starterGrams += (recipe.starter || 0) * qty;

        // Total flour weight for this recipe variant
        const flourWeight = (recipe.flour || 0) * qty;

        // Flour breakdown
        let floursBreakdown: any[] = [];
        if (recipe.floursBreakdown) {
          try {
            floursBreakdown = typeof recipe.floursBreakdown === 'string'
              ? JSON.parse(recipe.floursBreakdown)
              : (recipe.floursBreakdown as any);
          } catch (e) {
            floursBreakdown = [];
          }
        }

        if (Array.isArray(floursBreakdown) && floursBreakdown.length > 0) {
          for (const fb of floursBreakdown) {
            if (fb && fb.name && typeof fb.percentage === 'number') {
              const fbWeight = (fb.percentage / 100) * flourWeight;
              floursMap[fb.name] = (floursMap[fb.name] || 0) + fbWeight;
            }
          }
        } else {
          floursMap['Bread Flour'] = (floursMap['Bread Flour'] || 0) + flourWeight;
        }

        // Extras
        let extras: any[] = [];
        if (recipe.extraIngredients) {
          try {
            extras = typeof recipe.extraIngredients === 'string'
              ? JSON.parse(recipe.extraIngredients)
              : (recipe.extraIngredients as any);
          } catch (e) {
            extras = [];
          }
        }

        if (Array.isArray(extras)) {
          for (const extra of extras) {
            if (extra && extra.name && typeof extra.grams === 'number') {
              extrasMap[extra.name] = (extrasMap[extra.name] || 0) + extra.grams * qty;
            }
          }
        }
      }
    }

    // 3. Retrieve current pantryStock from Settings
    const stockSetting = await prisma.setting.findUnique({
      where: { key: 'pantryStock' },
    });

    const defaultStock: Record<string, number> = {
      "Manitoba": 10.0,
      "Whole Wheat": 5.0,
      "Rye": 5.0,
      "Buckwheat/Heljda": 2.0,
      "Bread Flour": 10.0,
      "Salt": 2.0,
      "Sourdough Starter": 5.0
    };

    let currentStock: Record<string, number> = { ...defaultStock };
    if (stockSetting && stockSetting.value) {
      try {
        currentStock = { ...defaultStock, ...JSON.parse(stockSetting.value) };
      } catch (e) {
        console.error("Error parsing pantryStock setting:", e);
      }
    }

    // 4. Calculate modification factor
    const factor = action === 'deduct' ? -1 : 1;

    // Helper to adjust stock for an ingredient
    const adjustStock = (name: string, grams: number) => {
      if (grams <= 0) return;
      const kg = grams / 1000;
      
      // Match exact name, or fallback if "Buckwheat" maps to "Buckwheat/Heljda" etc.
      let targetName = name;
      if (name === "Buckwheat" || name === "Heljda" || name === "Buckwheat/Heljda" || name === "Heljda (Buckwheat)") {
        targetName = currentStock["Buckwheat/Heljda"] !== undefined ? "Buckwheat/Heljda" : name;
      } else if (name === "Salt" || name === "Fine Sea Salt") {
        targetName = "Salt";
      } else if (name === "Sourdough Starter" || name === "Starter") {
        targetName = "Sourdough Starter";
      }

      const current = currentStock[targetName] || 0;
      currentStock[targetName] = Math.max(0, current + factor * kg);
    };

    // Adjust Salt
    adjustStock("Salt", saltGrams);

    // Adjust Starter
    adjustStock("Sourdough Starter", starterGrams);

    // Adjust Flours
    for (const [flourName, grams] of Object.entries(floursMap)) {
      adjustStock(flourName, grams);
    }

    // Adjust Extras
    for (const [extraName, grams] of Object.entries(extrasMap)) {
      adjustStock(extraName, grams);
    }

    // 5. Save back to Setting
    await prisma.setting.upsert({
      where: { key: 'pantryStock' },
      update: { value: JSON.stringify(currentStock) },
      create: { key: 'pantryStock', value: JSON.stringify(currentStock) },
    });

    console.log(`Pantry stock successfully ${action === 'deduct' ? 'deducted' : 'restored'} for batch ${batchId}`);
  } catch (error) {
    console.error(`Error adjusting pantry stock for batch ${batchId}:`, error);
  }
}

// 5. Toggle lock batch status (Backward compatibility)
router.put('/batches/:id/lock', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { lock } = req.body; // boolean
  const targetStatus = lock ? 'IN_PRODUCTION' : 'DRAFT';
  
  // Re-route to status updating logic
  req.body = { status: targetStatus };
  return updateBatchStatus(req, res);
});

// Helper function for batch status transitions
async function updateBatchStatus(req: AuthenticatedRequest, res: Response) {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ['DRAFT', 'IN_PRODUCTION', 'BAKED', 'COMPLETED', 'LOCKED'];
  if (!status || !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Valid batch status is required' });
  }

  try {
    const existingBatch = await prisma.batch.findUnique({
      where: { id },
    });

    if (!existingBatch) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    const oldStatus = existingBatch.status;

    // Determine target order status based on batch status
    let targetOrderStatus: string | null = null;
    if (status === 'IN_PRODUCTION' || status === 'LOCKED') {
      targetOrderStatus = 'IN_PRODUCTION';
    } else if (status === 'BAKED') {
      targetOrderStatus = 'BAKED';
    } else if (status === 'COMPLETED') {
      targetOrderStatus = 'COMPLETED';
    } else if (status === 'DRAFT') {
      targetOrderStatus = 'CONFIRMED';
    }

    // Update batch
    const updatedBatch = await prisma.batch.update({
      where: { id },
      data: { status },
    });

    if (targetOrderStatus) {
      // Update all linked orders in bulk
      await prisma.order.updateMany({
        where: { batchId: id },
        data: { status: targetOrderStatus as any },
      });
    }

    // Deduct/Restore inventory based on transitioning to/from deducted statuses (BAKED or LOCKED)
    const isDeductedStatus = (s: string) => s === 'BAKED' || s === 'LOCKED';
    const oldDeducted = isDeductedStatus(oldStatus);
    const newDeducted = isDeductedStatus(status);

    if (newDeducted && !oldDeducted) {
      await adjustPantryStockForBatch(id, 'deduct');
    } else if (!newDeducted && oldDeducted) {
      await adjustPantryStockForBatch(id, 'restore');
    }

    return res.json({
      message: `Batch status has been successfully updated to ${status}`,
      batch: updatedBatch,
    });
  } catch (error) {
    console.error('Error updating batch status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// 5.5 Generic batch status transition
router.put('/batches/:id/status', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  return updateBatchStatus(req, res);
});

// 6. Delete a batch (Unbatches all orders and reverts active production order statuses to CONFIRMED)
router.delete('/batches/:id', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const batchToDelete = await prisma.batch.findUnique({
      where: { id },
    });

    const isDeductedStatus = (s: string) => s === 'BAKED' || s === 'LOCKED';
    if (batchToDelete && isDeductedStatus(batchToDelete.status)) {
      // Restore inventory stock if deleting an active/deducted batch
      await adjustPantryStockForBatch(id, 'restore');
    }

    // 1. Revert order statuses back to CONFIRMED
    await prisma.order.updateMany({
      where: {
        batchId: id,
        status: { in: ['IN_PRODUCTION', 'BAKED', 'COMPLETED'] },
      },
      data: {
        status: 'CONFIRMED',
      },
    });

    // 2. Unbatch all linked orders
    await prisma.order.updateMany({
      where: { batchId: id },
      data: {
        batchId: null,
      },
    });

    // 3. Delete the batch
    await prisma.batch.delete({
      where: { id },
    });

    return res.json({ message: 'Batch successfully deleted' });
  } catch (error) {
    console.error('Error deleting batch:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 7. Sales Forecasting and Ingredient Planning
router.get('/forecast', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const days = parseInt(req.query.days as string || '14', 10);
  
  try {
    // Fetch doughWasteFactor from settings
    const doughWasteSetting = await prisma.setting.findUnique({
      where: { key: 'doughWasteFactor' },
    });
    const doughWasteFactorStr = doughWasteSetting?.value;
    const doughWasteFactor = (doughWasteFactorStr && !isNaN(parseFloat(doughWasteFactorStr))) ? parseFloat(doughWasteFactorStr) : 5; // default 5%
    const multiplier = 1 + (doughWasteFactor / 100);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const limitDate = new Date();
    limitDate.setDate(today.getDate() + days);
    limitDate.setHours(23, 59, 59, 999);

    // 1. Get all batches scheduled in this range (today to limitDate)
    const batches = await prisma.batch.findMany({
      where: {
        date: {
          gte: today,
          lte: limitDate,
        }
      },
      include: {
        orders: {
          include: {
            items: {
              include: {
                productVariant: {
                  include: {
                    product: true,
                    recipe: true,
                  }
                }
              }
            }
          }
        }
      }
    });

    // 2. Get any unbatched draft/pending/confirmed orders in this range
    const unbatchedOrders = await prisma.order.findMany({
      where: {
        batchId: null,
        status: { in: ['PENDING', 'CONFIRMED'] },
        createdAt: {
          gte: today,
          lte: limitDate,
        }
      },
      include: {
        items: {
          include: {
            productVariant: {
              include: {
                product: true,
                recipe: true,
              }
            }
          }
        }
      }
    });

    // 3. Get active subscriptions (Standing Orders)
    const standingOrders = await prisma.standingOrder.findMany({
      where: { active: true },
      include: {
        productVariant: {
          include: {
            product: true,
            recipe: true,
          }
        }
      }
    });

    // Let's aggregate product quantities: productVariantId -> { productVariant, quantity }
    const productAggregates: Record<string, { productVariant: any; quantity: number }> = {};

    const addProducts = (variant: any, qty: number) => {
      if (!variant) return;
      if (!productAggregates[variant.id]) {
        productAggregates[variant.id] = { productVariant: variant, quantity: 0 };
      }
      productAggregates[variant.id].quantity += qty;
    };

    // Add items from batched orders
    batches.forEach(b => {
      b.orders.forEach(o => {
        o.items.forEach(item => {
          addProducts(item.productVariant, item.quantity);
        });
      });
    });

    // Add items from unbatched orders
    unbatchedOrders.forEach(o => {
      o.items.forEach(item => {
        addProducts(item.productVariant, item.quantity);
      });
    });

    // Add projected standing orders
    // If we forecast X days, that corresponds to (days / 7) weeks.
    const weeksFactor = Math.max(1, days / 7);
    standingOrders.forEach(so => {
      const projectedQty = Math.round(so.quantity * weeksFactor);
      addProducts(so.productVariant, projectedQty);
    });

    // Now, run the calculations on aggregated product variations
    let totalFlour = 0;
    let totalWater = 0;
    let totalSalt = 0;
    let totalStarter = 0;
    const extraIngredientsMap: Record<string, number> = {};
    const floursBreakdownMap: Record<string, number> = {};
    const productQuantities: Array<{ productName: string; size: string; quantity: number }> = [];

    Object.values(productAggregates).forEach(({ productVariant, quantity }) => {
      if (quantity <= 0) return;
      
      productQuantities.push({
        productName: productVariant.product.name,
        size: productVariant.size,
        quantity,
      });

      const recipe = productVariant.recipe;
      if (!recipe) return;

      const scale = quantity * multiplier;
      totalFlour += (recipe.flour || 0) * scale;
      totalWater += (recipe.water || 0) * scale;
      totalSalt += (recipe.salt || 0) * scale;
      totalStarter += (recipe.starter || 0) * scale;

      // Extra Ingredients breakdown
      if (recipe.extraIngredients) {
        let extras: any[] = [];
        try {
          extras = typeof recipe.extraIngredients === 'string' 
            ? JSON.parse(recipe.extraIngredients) 
            : recipe.extraIngredients as any[];
        } catch (e) {
          extras = [];
        }
        if (Array.isArray(extras)) {
          extras.forEach((ext: any) => {
            if (ext.name && ext.grams) {
              const name = ext.name.trim();
              extraIngredientsMap[name] = (extraIngredientsMap[name] || 0) + ext.grams * scale;
            }
          });
        }
      }

      // Flour types breakdown
      if (recipe.floursBreakdown) {
        let flours: any[] = [];
        try {
          flours = typeof recipe.floursBreakdown === 'string'
            ? JSON.parse(recipe.floursBreakdown)
            : recipe.floursBreakdown as any[];
        } catch (e) {
          flours = [];
        }
        if (Array.isArray(flours)) {
          flours.forEach((fl: any) => {
            if (fl.name && fl.percentage) {
              const name = fl.name.trim();
              const weight = (recipe.flour || 0) * (fl.percentage / 100) * scale;
              floursBreakdownMap[name] = (floursBreakdownMap[name] || 0) + weight;
            }
          });
        }
      } else {
        // Fallback to "Manitoba" if no specific breakdown is set
        const defaultFlourName = 'Manitoba';
        const weight = (recipe.flour || 0) * scale;
        floursBreakdownMap[defaultFlourName] = (floursBreakdownMap[defaultFlourName] || 0) + weight;
      }
    });

    // If floursBreakdownMap is empty but totalFlour > 0, fallback to Manitoba
    if (Object.keys(floursBreakdownMap).length === 0 && totalFlour > 0) {
      floursBreakdownMap['Manitoba'] = totalFlour;
    }

    return res.json({
      days,
      batchesCount: batches.length,
      ordersCount: batches.reduce((sum, b) => sum + b.orders.length, 0) + unbatchedOrders.length,
      subscriptionsCount: standingOrders.length,
      productQuantities,
      summary: {
        totalFlour,
        totalWater,
        totalSalt,
        totalStarter,
        floursBreakdown: Object.entries(floursBreakdownMap).map(([name, grams]) => ({ name, grams })),
        extrasBreakdown: Object.entries(extraIngredientsMap).map(([name, grams]) => ({ name, grams })),
      }
    });
  } catch (error) {
    console.error('Error in forecasting:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
