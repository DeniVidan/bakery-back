import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environmental config
dotenv.config();

// Route modules
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import productsRouter from './routes/products';
import menuRouter from './routes/menu';
import ordersRouter from './routes/orders';
import productionRouter from './routes/production';
import standingOrdersRouter from './routes/standingOrders';
import settingsRouter from './routes/settings';
import loyaltyRouter from './routes/loyalty';

const app = express();
const PORT = process.env.PORT || 5000;

// Enable Cross-Origin Resource Sharing
const ALLOWED_ORIGINS = process.env.FRONTEND_URL 
  ? [process.env.FRONTEND_URL, 'http://localhost:3000']
  : '*';

app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Payload parsing
app.use(express.json());

// API route groups
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/products', productsRouter);
app.use('/api/menu', menuRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/production', productionRouter);
app.use('/api/standing-orders', standingOrdersRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/loyalty', loyaltyRouter);

import { runSubscriptionOrderGeneration } from './routes/standingOrders';

// Base health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date(), service: 'microbakery-core' });
});

// Boot up server with automated scheduled subscriptions process
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🍞 MICROBAKERY SYSTEM ENGINE IS ONLINE`);
  console.log(`🚀 Port: http://localhost:${PORT}`);
  console.log(`========================================`);

  // Run immediately on boot to catch up
  console.log('⏳ Running automated weekly subscription order check...');
  runSubscriptionOrderGeneration()
    .then(count => {
      console.log(`✅ Automated weekly subscription check done. Generated ${count} order(s).`);
    })
    .catch(err => {
      console.error('❌ Error during automated subscription check:', err);
    });

  // Schedule daily run (idempotent, no duplicates)
  setInterval(() => {
    console.log('⏳ Running scheduled weekly subscription order generation...');
    runSubscriptionOrderGeneration()
      .then(count => {
        console.log(`✅ Scheduled weekly subscription generation done. Generated ${count} order(s).`);
      })
      .catch(err => {
        console.error('❌ Error during scheduled subscription generation:', err);
      });
  }, 24 * 60 * 60 * 1000); // 24 hours
});
