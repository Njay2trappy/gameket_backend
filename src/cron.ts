import cron from "node-cron";
import { getDB, getWalletsDB, getCatalogsDB } from "./db.js";
import type { Order, Balance, Transaction, PromotedProduct, PromotedStore, Premium, Product, Store, User } from "./types.js";
import { randomBytes } from "crypto";

function getRankFromSales(totalSales: number): number {
  if (totalSales >= 10000) return 10;
  if (totalSales >= 9000) return 9;
  if (totalSales >= 7500) return 8;
  if (totalSales >= 5000) return 7;
  if (totalSales >= 3500) return 6;
  if (totalSales >= 2500) return 5;
  if (totalSales >= 1000) return 4;
  if (totalSales >= 500) return 3;
  if (totalSales >= 100) return 2;
  return 1;
}

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
        .find({ isReleased: false, status: { $in: ["completed", "pending"] }, releasedAt: { $lte: now } })
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

  // Run every hour — expire stale billed manual orders
  cron.schedule("0 * * * *", async () => {
    const now = new Date().toISOString();
    const db = getDB();
    const walletsDB = getWalletsDB();
    const catalogsDB = getCatalogsDB();

    // A billed order expires 24 hours after it was created (createdAt + 24h)
    const expiryCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    try {
      const staleBilledOrders = await walletsDB
        .collection<Order>("Orders")
        .find({ status: "billed", createdAt: { $lte: expiryCutoff } })
        .toArray();

      for (const order of staleBilledOrders) {
        const isAnonBuyer = order.buyerId === "anon-gameket-id";

        // Refund registered buyer's wallet; guest refunds are manual
        if (!isAnonBuyer) {
          await walletsDB.collection<Balance>("Balances").updateOne(
            { userId: order.buyerId },
            { $inc: { availableBalance: order.totalAmount } }
          );
        }

        // Release seller's suspended balance back (no payout)
        await walletsDB.collection<Balance>("Balances").updateOne(
          { userId: order.sellerId },
          { $inc: { suspendedBalance: -order.amount } }
        );

        // Mark both transactions as refunded
        if (order.buyerTransactionId) {
          await walletsDB.collection<Transaction>("Transactions").updateOne(
            { id: order.buyerTransactionId },
            { $set: { status: "refunded" } }
          );
        }
        await walletsDB.collection<Transaction>("Transactions").updateOne(
          { id: order.sellerTransactionId },
          { $set: { status: "refunded" } }
        );

        // Create a Refund transaction for the buyer (registered only)
        if (!isAnonBuyer) {
          const refundTxnId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");
          await walletsDB.collection<Transaction>("Transactions").insertOne({
            userId: order.buyerId,
            id: refundTxnId,
            type: "Refund",
            status: "completed",
            method: "balance",
            amount: order.totalAmount,
            createdAt: now,
          });
        }

        // Roll back product stock
        const product = await catalogsDB.collection<Product>("Products").findOne({ productId: order.productId });
        if (product) {
          await catalogsDB.collection<Product>("Products").updateOne(
            { productId: order.productId },
            {
              $inc: { available: order.quantity, sold: -order.quantity },
              $set: { isActive: true },
            }
          );
        }

        // Roll back store totalSales and seller rank
        const updatedStore = await catalogsDB.collection<Store>("Stores").findOneAndUpdate(
          { storeId: order.storeId },
          { $inc: { totalSales: -order.quantity } },
          { returnDocument: "after" }
        );

        if (updatedStore) {
          const newRank = getRankFromSales(updatedStore.totalSales);
          await db.collection<User>("users").updateOne(
            { id: order.sellerId },
            { $set: { rank: newRank } }
          );
        }

        // Mark order as refunded and finalized
        await walletsDB.collection<Order>("Orders").updateOne(
          { orderId: order.orderId },
          {
            $set: {
              status: "refunded",
              isReleased: true,
              declinedAt: now,
              declineReason: "Order expired: seller did not fulfil within 24 hours",
            },
          }
        );
      }

      if (staleBilledOrders.length > 0) {
        console.log(`[CRON] Auto-refunded ${staleBilledOrders.length} expired billed manual order(s).`);
      }
    } catch (err) {
      console.error("[CRON] Error expiring stale billed orders:", err);
    }
  });

  console.log("[CRON] Jobs scheduled (every hour).");
}
