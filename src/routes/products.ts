import { Router, Response } from 'express';
import prisma from '../prisma';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// 1. Get all products (Public to authenticated, approved users and admins)
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const products = await prisma.product.findMany({
      include: {
        variants: {
          include: {
            recipe: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    return res.json({ products });
  } catch (error) {
    console.error('Error fetching products:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Create a Product with Variants and Optional Recipes (Admin only)
router.post('/', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { name, description, active, variants } = req.body;

  if (!name || !description || !Array.isArray(variants) || variants.length === 0) {
    return res.status(400).json({ error: 'Name, description, and at least one variant are required' });
  }

  try {
    const product = await prisma.product.create({
      data: {
        name,
        description,
        active: active !== undefined ? active : true,
        variants: {
          create: variants.map((v: any) => ({
            size: v.size,
            price: parseFloat(v.price) || 0.0,
            recipe: v.recipe
              ? {
                  create: {
                    flour: parseFloat(v.recipe.flour) || 0,
                    water: parseFloat(v.recipe.water) || 0,
                    salt: parseFloat(v.recipe.salt) || 0,
                    starter: parseFloat(v.recipe.starter) || 0,
                    starterName: v.recipe.starterName || "default",
                    extraIngredients: v.recipe.extraIngredients || [],
                    floursBreakdown: v.recipe.floursBreakdown || [],
                  },
                }
              : undefined,
          })),
        },
      },
      include: {
        variants: {
          include: {
            recipe: true,
          },
        },
      },
    });

    return res.status(201).json({ message: 'Product created successfully', product });
  } catch (error) {
    console.error('Error creating product:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Update Product details (Admin only)
router.put('/:id', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { name, description, active, variants } = req.body;

  try {
    // Basic product fields update
    const updatedProduct = await prisma.product.update({
      where: { id },
      data: {
        name,
        description,
        active: active !== undefined ? active : undefined,
      },
    });

    // If variants are supplied, we synchronize them (add, update, delete)
    if (Array.isArray(variants)) {
      // Fetch existing variants to see who to keep/delete
      const existingVariants = await prisma.productVariant.findMany({
        where: { productId: id },
      });

      const existingIds = existingVariants.map((ev) => ev.id);
      const incomingIds = variants.map((v: any) => v.id).filter(Boolean);

      // 1. Delete variants that aren't in the incoming list
      const toDelete = existingIds.filter((id) => !incomingIds.includes(id));
      if (toDelete.length > 0) {
        await prisma.productVariant.deleteMany({
          where: { id: { in: toDelete } },
        });
      }

      // 2. Add or update incoming variants
      for (const v of variants) {
        if (v.id) {
          // Update existing variant
          await prisma.productVariant.update({
            where: { id: v.id },
            data: {
              size: v.size,
              price: parseFloat(v.price) || 0.0,
            },
          });

          // Sync recipe
          if (v.recipe) {
            await prisma.recipe.upsert({
              where: { variantId: v.id },
              update: {
                flour: parseFloat(v.recipe.flour) || 0,
                water: parseFloat(v.recipe.water) || 0,
                salt: parseFloat(v.recipe.salt) || 0,
                starter: parseFloat(v.recipe.starter) || 0,
                starterName: v.recipe.starterName || "default",
                extraIngredients: v.recipe.extraIngredients || [],
                floursBreakdown: v.recipe.floursBreakdown || [],
              },
              create: {
                variantId: v.id,
                flour: parseFloat(v.recipe.flour) || 0,
                water: parseFloat(v.recipe.water) || 0,
                salt: parseFloat(v.recipe.salt) || 0,
                starter: parseFloat(v.recipe.starter) || 0,
                starterName: v.recipe.starterName || "default",
                extraIngredients: v.recipe.extraIngredients || [],
                floursBreakdown: v.recipe.floursBreakdown || [],
              },
            });
          }
        } else {
          // Create new variant
          await prisma.productVariant.create({
            data: {
              productId: id,
              size: v.size,
              price: parseFloat(v.price) || 0.0,
              recipe: v.recipe
                ? {
                    create: {
                      flour: parseFloat(v.recipe.flour) || 0,
                      water: parseFloat(v.recipe.water) || 0,
                      salt: parseFloat(v.recipe.salt) || 0,
                      starter: parseFloat(v.recipe.starter) || 0,
                      starterName: v.recipe.starterName || "default",
                      extraIngredients: v.recipe.extraIngredients || [],
                      floursBreakdown: v.recipe.floursBreakdown || [],
                    },
                  }
                : undefined,
            },
          });
        }
      }
    }

    const finalProduct = await prisma.product.findUnique({
      where: { id },
      include: {
        variants: {
          include: {
            recipe: true,
          },
        },
      },
    });

    return res.json({ message: 'Product updated successfully', product: finalProduct });
  } catch (error) {
    console.error('Error updating product:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Delete Product (Admin only)
router.delete('/:id', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    await prisma.product.delete({
      where: { id },
    });
    return res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Error deleting product:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Update Recipe for a Variant Directly (Admin only)
router.put('/variants/:variantId/recipe', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { variantId } = req.params;
  const { flour, water, salt, starter, starterName, extraIngredients, floursBreakdown } = req.body;

  try {
    const updatedRecipe = await prisma.recipe.upsert({
      where: { variantId },
      update: {
        flour: parseFloat(flour) || 0,
        water: parseFloat(water) || 0,
        salt: parseFloat(salt) || 0,
        starter: parseFloat(starter) || 0,
        starterName: starterName || "default",
        extraIngredients: extraIngredients || [],
        floursBreakdown: floursBreakdown || [],
      },
      create: {
        variantId,
        flour: parseFloat(flour) || 0,
        water: parseFloat(water) || 0,
        salt: parseFloat(salt) || 0,
        starter: parseFloat(starter) || 0,
        starterName: starterName || "default",
        extraIngredients: extraIngredients || [],
        floursBreakdown: floursBreakdown || [],
      },
    });

    return res.json({ message: 'Recipe updated successfully', recipe: updatedRecipe });
  } catch (error) {
    console.error('Error updating recipe:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
