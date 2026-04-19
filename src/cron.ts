import cron from "node-cron";
import { getDB, getWalletsDB, getCatalogsDB } from "./db.js";
import type { Order, Balance, Transaction, PromotedProduct, PromotedStore, Premium, Product, Store, User } from "./types.js";

export function startCronJobs() {
  // Run every hour
  cron.schedule("0 * * * *", async () => {
    console.log("[CRON] Running scheduled jobs...");

    const now = new Date().toISOString();
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    // 1. Release suspended funds for completed orders past releasedAt
    try {
      const orders = await walletsDB
        .collection<Order>("Orders")
        .find({ isReleased: false, status: "completed", releasedAt: { $lte: now } })
        .toArray();

      for (const order of orders) {
        await walletsDB.collection<Order>("Orders").updateOne(
          { orderId: order.orderId },
          { $set: { isReleased: true } }
        );

        await walletsDB.collection<Balance>("Balances").updateOne(
          { userId: order.sellerId },
          {
            $inc: {
              suspendedBalance: -order.amount,
              availableBalance: order.amount,
            },
          }
        );

        // Mark seller's transaction as completed
        await walletsDB.collection<Transaction>("Transactions").updateOne(
          { id: order.sellerTransactionId },
          { $set: { status: "completed" } }
        );
      }

      if (orders.length > 0) {
        console.log(`[CRON] Released funds for ${orders.length} order(s).`);
      }
    } catch (err) {
      console.error("[CRON] Error releasing funds:", err);
    }

    // 2. Remove expired promoted products
    try {
      const expiredPromotions = await catalogsDB
        .collection<PromotedProduct>("PromotedProducts")
        .find({ campaignEnd: { $lte: now } })
        .toArray();

      for (const promo of expiredPromotions) {
        await catalogsDB.collection<PromotedProduct>("PromotedProducts").deleteOne(
          { productId: promo.productId }
        );

        await catalogsDB.collection<Product>("Products").updateOne(
          { productId: promo.productId },
          { $set: { isPromoted: false } }
        );
      }

      if (expiredPromotions.length > 0) {
        console.log(`[CRON] Removed ${expiredPromotions.length} expired product promotion(s).`);
      }
    } catch (err) {
      console.error("[CRON] Error removing expired product promotions:", err);
    }

    // 3. Remove expired promoted stores
    try {
      const expiredStorePromos = await catalogsDB
        .collection<PromotedStore>("PromotedStores")
        .find({ campaignEnd: { $lte: now } })
        .toArray();

      for (const promo of expiredStorePromos) {
        await catalogsDB.collection<PromotedStore>("PromotedStores").deleteOne(
          { storeId: promo.storeId }
        );

        await catalogsDB.collection<Store>("Stores").updateOne(
          { storeId: promo.storeId },
          { $set: { isPromoted: false } }
        );
      }

      if (expiredStorePromos.length > 0) {
        console.log(`[CRON] Removed ${expiredStorePromos.length} expired store promotion(s).`);
      }
    } catch (err) {
      console.error("[CRON] Error removing expired store promotions:", err);
    }

    // 4. Expire premium subscriptions
    try {
      const expiredPremiums = await db
        .collection<Premium>("Premium")
        .find({ isActive: true, expiresAt: { $lte: now } })
        .toArray();

      for (const premium of expiredPremiums) {
        await db.collection<Premium>("Premium").updateOne(
          { userId: premium.userId, isActive: true },
          { $set: { isActive: false } }
        );

        await db.collection<User>("users").updateOne(
          { id: premium.userId },
          { $set: { isPremium: false } }
        );

        await catalogsDB.collection<Store>("Stores").updateOne(
          { userId: premium.userId },
          { $set: { type: "basic" } }
        );
      }

      if (expiredPremiums.length > 0) {
        console.log(`[CRON] Expired ${expiredPremiums.length} premium subscription(s).`);
      }
    } catch (err) {
      console.error("[CRON] Error expiring premium subscriptions:", err);
    }

    console.log("[CRON] Scheduled jobs complete.");
  });

  console.log("[CRON] Jobs scheduled (every hour).");
}
