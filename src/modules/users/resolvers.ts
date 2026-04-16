
import crypto from "crypto";
import { GraphQLError } from "graphql";
import { getDB, getCatalogsDB, getWalletsDB } from "../../db.js";
import type { User, Account, Store, Balance, Premium, Transaction, Product } from "../../types.js";
import type { Context } from "../../index.js";

export const usersQueries = {
  getUserDetails: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;

    const db = getDB();
    const catalogsDB = getCatalogsDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });

    if (!user) {
      return {
        code: 404,
        success: false,
        message: "User not found",
        user: null,
      };
    }

    const account = await db.collection<Account>("accounts").findOne({ userId });

    const storeDoc = await catalogsDB
      .collection<Store>("Stores")
      .findOne({ userId });

    const store = storeDoc
      ? {
          storeId: storeDoc.storeId,
          storeName: storeDoc.storeName,
          isActive: storeDoc.isActive,
          type: storeDoc.type,
          totalSales: storeDoc.totalSales,
          positiveReviews: storeDoc.positiveReviews,
          negativeReviews: storeDoc.negativeReviews,
        }
      : null;

    const balanceDoc = await walletsDB
      .collection<Balance>("Balances")
      .findOne({ userId });

    const wallet = balanceDoc
      ? {
          availableBalance: parseFloat(balanceDoc.availableBalance.toFixed(2)),
          suspendedBalance: parseFloat(balanceDoc.suspendedBalance.toFixed(2)),
          methods: balanceDoc.methods,
        }
      : null;

    const premiumDoc = await db.collection<Premium>("Premium").findOne(
      { userId, isActive: true }
    );

    const premium = premiumDoc
      ? {
          subscribedAt: premiumDoc.subscribedAt,
          expiresAt: premiumDoc.expiresAt,
          isActive: premiumDoc.isActive,
        }
      : null;

    const productDocs = await catalogsDB
      .collection<Product>("Products")
      .find({ userId })
      .toArray();

    const products = productDocs.length
      ? productDocs.map((p) => ({
          productId: p.productId,
          catalog: p.catalog,
          category: p.category,
          region: p.region,
          name: p.name,
          description: p.description,
          marketPrice: p.marketPrice,
          price: p.price,
          discount: p.discount,
          isActive: p.isActive,
          available: p.available,
          sold: p.sold,
          createdAt: p.createdAt,
        }))
      : null;

    return {
      code: 200,
      success: true,
      message: "User details retrieved successfully",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        country: user.country,
        isActive: user.isActive,
        isVerified: user.isVerified,
        isPremium: user.isPremium,
        twoFactorAuth: account?.twoFactorAuth ?? false,
        rank: user.rank,
        registered: user.registered,
        isStore: user.isStore,
        avatar: user.avatar,
      },
      store,
      wallet,
      premium,
      products,
    };
  },

  getStoreDetails: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const catalogsDB = getCatalogsDB();

    const storeDoc = await catalogsDB
      .collection<Store>("Stores")
      .findOne({ userId });

    if (!storeDoc) {
      return { code: 404, success: false, message: "Store not found", store: null };
    }

    return {
      code: 200,
      success: true,
      message: "Store details retrieved successfully",
      store: {
        storeId: storeDoc.storeId,
        storeName: storeDoc.storeName,
        isActive: storeDoc.isActive,
        type: storeDoc.type,
        totalSales: storeDoc.totalSales,
        positiveReviews: storeDoc.positiveReviews,
        negativeReviews: storeDoc.negativeReviews,
      },
    };
  },

  getPremium: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();

    const premiumDoc = await db.collection<Premium>("Premium").findOne(
      { userId, isActive: true }
    );

    if (!premiumDoc) {
      return { code: 404, success: false, message: "No active premium subscription", premium: null };
    }

    return {
      code: 200,
      success: true,
      message: "Premium details retrieved successfully",
      premium: {
        subscribedAt: premiumDoc.subscribedAt,
        expiresAt: premiumDoc.expiresAt,
        isActive: premiumDoc.isActive,
      },
    };
  },
};

export const usersMutations = {
  buyPremium: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", premium: null };
    }

    if (!user.isVerified) {
      return { code: 403, success: false, message: "Account must be verified to subscribe to premium", premium: null };
    }

    if (!user.isActive) {
      return { code: 403, success: false, message: "Account is not active", premium: null };
    }

    const balance = await walletsDB.collection<Balance>("Balances").findOne({ userId });
    if (!balance || balance.availableBalance < 15) {
      return { code: 400, success: false, message: "Insufficient balance. 15 USDT required", premium: null };
    }

    const now = new Date();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    // If already premium, extend from current expiry date
    const existingPremium = await db.collection<Premium>("Premium").findOne(
      { userId, isActive: true }
    );

    let expiresAt: Date;
    if (existingPremium) {
      const currentExpiry = new Date(existingPremium.expiresAt);
      expiresAt = new Date(currentExpiry.getTime() + thirtyDays);

      await db.collection<Premium>("Premium").updateOne(
        { userId, isActive: true },
        { $set: { expiresAt: expiresAt.toISOString() } }
      );
    } else {
      expiresAt = new Date(now.getTime() + thirtyDays);

      const premiumRecord: Premium = {
        userId,
        subscribedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        isActive: true,
      };

      await db.collection<Premium>("Premium").insertOne(premiumRecord);

      await db.collection<User>("users").updateOne(
        { id: userId },
        { $set: { isPremium: true } }
      );
    }

    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId },
      { $inc: { availableBalance: -15 } }
    );

    const transaction: Transaction = {
      userId,
      id: crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, ""),
      type: "Premium subscription",
      status: "completed",
      method: "balance",
      amount: 15,
      createdAt: now.toISOString(),
    };

    await walletsDB.collection<Transaction>("Transactions").insertOne(transaction);

    return {
      code: 200,
      success: true,
      message: existingPremium
        ? "Premium subscription extended by 30 days"
        : "Premium subscription activated for 30 days",
      premium: {
        subscribedAt: existingPremium?.subscribedAt ?? now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        isActive: true,
      },
    };
  },
};
