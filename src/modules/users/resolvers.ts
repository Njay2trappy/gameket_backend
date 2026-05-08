
import crypto from "crypto";
import { GraphQLError } from "graphql";
import nodemailer from "nodemailer";
import { readFileSync } from "fs";
import { join } from "path";
import { getDB, getCatalogsDB, getWalletsDB } from "../../db.js";
import type { User, Account, Store, Balance, Premium, Transaction, Product, Order } from "../../types.js";
import type { Context } from "../../index.js";

const MERCHANT_LOCK_AMOUNT = 1000;
const MERCHANT_LOCK_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

const generateMerchantApiKeyCandidate = (): string => `gk_m_${crypto.randomBytes(24).toString("hex")}`;
const generateMerchantSecret = (): string => `gk_s_${crypto.randomBytes(32).toString("hex")}`;

const smtpTransporter = nodemailer.createTransport({
  host: "gameket.io",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

const escapeHtml = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\"/g, "&quot;")
  .replace(/'/g, "&#39;");

const formatDateTime = (iso: string): string => {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};

const shouldSendEmailForUser = (user: User): boolean => {
  return (user.deliveryOption || "email") === "email";
};

const normalizeImgbbImageInput = (input: string): { image: string; error: string | null } => {
  const raw = input.trim();
  if (!raw) {
    return { image: "", error: "Image is required" };
  }

  if (/^blob:/i.test(raw)) {
    return {
      image: "",
      error: "Blob URLs are not supported. Send a base64 image string or public image URL",
    };
  }

  const dataUriMatch = raw.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUriMatch) {
    const mimeType = dataUriMatch[1].toLowerCase();
    if (!mimeType.startsWith("image/")) {
      return { image: "", error: "Only image files are allowed" };
    }

    const base64Payload = dataUriMatch[2].replace(/\s+/g, "");
    if (!base64Payload) {
      return { image: "", error: "Image is required" };
    }

    return { image: base64Payload, error: null };
  }

  if (/^https?:\/\//i.test(raw)) {
    return { image: raw, error: null };
  }

  const base64Payload = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(base64Payload)) {
    return {
      image: "",
      error: "Invalid image payload. Send base64 image data or an https image URL",
    };
  }

  return { image: base64Payload, error: null };
};

const merchantBioTemplates = [
  "{{storeName}} is your trusted merchant store for instant digital delivery and dependable support.",
  "Welcome to {{storeName}}, a verified merchant store focused on speed, reliability, and secure transactions.",
  "{{storeName}} provides quality digital products with fast fulfillment and merchant-grade service.",
  "At {{storeName}}, we combine competitive prices with smooth delivery and consistent customer support.",
  "{{storeName}} is built for buyers who want reliable digital products from a dedicated merchant store.",
];

const generateMerchantStoreBio = (storeName: string): string => {
  const normalizedStoreName = storeName.trim() || "This store";
  const template = merchantBioTemplates[Math.floor(Math.random() * merchantBioTemplates.length)]
    || "{{storeName}} is a verified merchant store on Gameket.";

  return template.replace(/\{\{storeName\}\}/g, normalizedStoreName);
};

const mapStoreDetails = (storeDoc: Store) => {
  return {
    storeId: storeDoc.storeId,
    storeName: storeDoc.storeName,
    bio: storeDoc.bio ?? null,
    storeImage: storeDoc.storeImage ?? null,
    isActive: storeDoc.isActive,
    isApproved: storeDoc.isApproved,
    approveStatus: storeDoc.approveStatus ?? null,
    isPromoted: storeDoc.isPromoted,
    type: storeDoc.type,
    totalSales: storeDoc.totalSales,
    positiveReviews: storeDoc.positiveReviews,
    negativeReviews: storeDoc.negativeReviews,
    registered: storeDoc.createdAt?.split("T")[0] || storeDoc.createdAt,
    requestCount: storeDoc.requestCount ?? 0,
  };
};

const mapWalletDetails = (balanceDoc: Balance) => {
  return {
    availableBalance: parseFloat(balanceDoc.availableBalance.toFixed(2)),
    suspendedBalance: parseFloat(balanceDoc.suspendedBalance.toFixed(2)),
    methods: balanceDoc.methods,
  };
};

const mapMerchantCredentials = (storeDoc: Store | null) => {
  return {
    apiKey: storeDoc?.merchantApiKey ?? null,
    secret: storeDoc?.merchantSecret ?? null,
  };
};

const buildMerchantFundsStatus = (storeDoc: Store | null) => {
  const lockAmount = Number(storeDoc?.merchantLockedAmount ?? 0);
  const lockedAt = storeDoc?.merchantLockedAt ?? null;
  const lockedAtMs = lockedAt ? new Date(lockedAt).getTime() : NaN;
  const unlocksAtMs = Number.isFinite(lockedAtMs) ? (lockedAtMs + MERCHANT_LOCK_PERIOD_MS) : NaN;

  return {
    lockAmount,
    lockedAt,
    unlocksAt: Number.isFinite(unlocksAtMs) ? new Date(unlocksAtMs).toISOString() : null,
    canUnfreeze: Number.isFinite(unlocksAtMs) ? Date.now() >= unlocksAtMs && lockAmount > 0 : false,
  };
};

const renderPremiumSubscriptionEmail = (
  user: User,
  activatedOn: string,
  nextBillingDate: string
): string => {
  const template = readFileSync(join(process.cwd(), "src", "emails", "premium-subscription-email.html"), "utf-8");
  const firstName = user.username.trim() || "there";

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{activatedOn\}\}/g, escapeHtml(formatDateTime(activatedOn)))
    .replace(/\{\{nextBillingDate\}\}/g, escapeHtml(formatDateTime(nextBillingDate)))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const renderStoreMerchantUpgradeEmail = (
  user: User,
  store: Store,
  activatedOn: string
): string => {
  const template = readFileSync(join(process.cwd(), "src", "emails", "store-merchant-upgrade-email.html"), "utf-8");
  const firstName = user.username.trim() || "there";

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{storeName\}\}/g, escapeHtml(store.storeName))
    .replace(/\{\{storeId\}\}/g, escapeHtml(store.storeId))
    .replace(/\{\{activatedOn\}\}/g, escapeHtml(formatDateTime(activatedOn)))
    .replace(/\{\{merchantTier\}\}/g, "Merchant")
    .replace(/\{\{primaryCategory\}\}/g, "Digital Products")
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

export const userFieldResolvers = {
  deliveryOption: (parent: Record<string, unknown>) => {
    const value = String(parent.deliveryOption || "email").toLowerCase();
    return value === "telegram" ? "telegram" : "email";
  },

  isSuspended: (parent: Record<string, unknown>) => {
    return Boolean(parent.isSuspended);
  },

  twoFactorAuth: async (parent: Record<string, unknown>) => {
    if ("twoFactorAuth" in parent) return parent.twoFactorAuth;
    const db = getDB();
    const account = await db.collection<Account>("accounts").findOne({ userId: parent.id as string });
    return account?.twoFactorAuth ?? false;
  },
  store: async (parent: Record<string, unknown>) => {
    const catalogsDB = getCatalogsDB();
    const storeDoc = await catalogsDB.collection<Store>("Stores").findOne({ userId: parent.id as string });
    if (!storeDoc) return null;
    return mapStoreDetails(storeDoc);
  },
  wallet: async (parent: Record<string, unknown>) => {
    const walletsDB = getWalletsDB();
    const balanceDoc = await walletsDB.collection<Balance>("Balances").findOne({ userId: parent.id as string });
    if (!balanceDoc) return null;
    return mapWalletDetails(balanceDoc);
  },
  premium: async (parent: Record<string, unknown>) => {
    const db = getDB();
    const premiumDoc = await db.collection<Premium>("Premium").findOne({ userId: parent.id as string, isActive: true });
    if (!premiumDoc) return null;
    return {
      subscribedAt: premiumDoc.subscribedAt,
      expiresAt: premiumDoc.expiresAt,
      isActive: premiumDoc.isActive,
    };
  },
  products: async (parent: Record<string, unknown>) => {
    const catalogsDB = getCatalogsDB();
    const productDocs = await catalogsDB.collection<Product>("Products").find({ userId: parent.id as string }).toArray();
    if (!productDocs.length) return null;
    return productDocs.map((p) => ({
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
      isPromoted: p.isPromoted,
      available: p.available,
      sold: p.sold,
      type: p.type,
      createdAt: p.createdAt,
    }));
  },
  transactions: async (parent: Record<string, unknown>) => {
    const walletsDB = getWalletsDB();
    const txDocs = await walletsDB
      .collection<Transaction>("Transactions")
      .find({ userId: parent.id as string })
      .sort({ createdAt: -1 })
      .toArray();
    if (!txDocs.length) return null;
    return txDocs.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      method: t.method,
      amount: t.amount,
      createdAt: t.createdAt,
    }));
  },
};

export const usersQueries = {
  getUserDetails: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();

    const user = await db.collection<User>("users").findOne({ id: userId });

    if (!user) {
      return {
        code: 404,
        success: false,
        message: "User not found",
      };
    }

    return {
      code: 200,
      success: true,
      message: "User details retrieved successfully",
      user,
    };
  },

  getUserStoreDetails: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });

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
      user,
      store: mapStoreDetails(storeDoc),
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

    const user = await db.collection<User>("users").findOne({ id: userId });

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
      user,
      premium: {
        subscribedAt: premiumDoc.subscribedAt,
        expiresAt: premiumDoc.expiresAt,
        isActive: premiumDoc.isActive,
      },
    };
  },

  getMerchantDetails: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    if (context.user.role === "admin") {
      return {
        code: 403,
        success: false,
        message: "Admin token is not allowed for merchant details",
        user: null,
        store: null,
        wallet: null,
        merchantFunds: null,
        merchantCredentials: null,
        pendingOrders: null,
      };
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
        store: null,
        wallet: null,
        merchantFunds: null,
        merchantCredentials: null,
        pendingOrders: null,
      };
    }

    if (!user.isStore) {
      return {
        code: 403,
        success: false,
        message: "Only store users can access merchant details",
        user,
        store: null,
        wallet: null,
        merchantFunds: null,
        merchantCredentials: null,
        pendingOrders: null,
      };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return {
        code: 404,
        success: false,
        message: "Store not found",
        user,
        store: null,
        wallet: null,
        merchantFunds: null,
        merchantCredentials: null,
        pendingOrders: null,
      };
    }

    const walletDoc = await walletsDB.collection<Balance>("Balances").findOne({ userId });

    if (store.type !== "merchant") {
      return {
        code: 400,
        success: false,
        message: "Store is not currently a merchant",
        user,
        store: mapStoreDetails(store),
        wallet: walletDoc ? mapWalletDetails(walletDoc) : null,
        merchantFunds: buildMerchantFundsStatus(store),
        merchantCredentials: null,
        pendingOrders: null,
      };
    }

    const pendingReleaseOrders = await walletsDB
      .collection<Order>("Orders")
      .countDocuments({
        sellerId: userId,
        isReleased: false,
        status: { $in: ["completed", "pending"] },
      });

    return {
      code: 200,
      success: true,
      message: "Merchant details retrieved successfully",
      user,
      store: mapStoreDetails(store),
      wallet: walletDoc ? mapWalletDetails(walletDoc) : null,
      merchantFunds: buildMerchantFundsStatus(store),
      merchantCredentials: mapMerchantCredentials(store),
      pendingOrders: pendingReleaseOrders,
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

    if (user.isSuspended) {
      return { code: 403, success: false, message: "Your account is suspended. You cannot subscribe to premium.", premium: null };
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

      // Update store type to premium unless store is merchant/official
      const catalogsDB = getCatalogsDB();
      await catalogsDB.collection<Store>("Stores").updateOne(
        { userId, type: { $nin: ["merchant", "official"] } },
        { $set: { type: "premium" } }
      );
    }

    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId },
      { $inc: { availableBalance: -15 } }
    );

    const transaction: Transaction = {
      userId,
      id: crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, ""),
      type: "PremiumSubscription",
      status: "completed",
      method: "balance",
      amount: 15,
      createdAt: now.toISOString(),
    };

    await walletsDB.collection<Transaction>("Transactions").insertOne(transaction);

    if (shouldSendEmailForUser(user)) {
      try {
        const html = renderPremiumSubscriptionEmail(
          user,
          now.toISOString(),
          expiresAt.toISOString()
        );

        await smtpTransporter.sendMail({
          from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
          to: user.email,
          subject: "Premium Subscription Activated",
          html,
        });
      } catch (error) {
        console.error("Failed to send premium subscription email:", error);
      }
    }

    return {
      code: 200,
      success: true,
      message: existingPremium
        ? "Premium subscription extended by 30 days"
        : "Premium subscription activated for 30 days",
      user: { ...user, isPremium: true },
      premium: {
        subscribedAt: existingPremium?.subscribedAt ?? now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        isActive: true,
      },
    };
  },

  UpdateMerchantdetails: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        regenerateApiKey?: boolean | null;
        regenerateSecret?: boolean | null;
      };
    },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    if (context.user.role === "admin") {
      return {
        code: 403,
        success: false,
        message: "Admin token is not allowed for this action",
        user: null,
        store: null,
        merchantCredentials: null,
      };
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();
    const stores = catalogsDB.collection<Store>("Stores");

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return {
        code: 404,
        success: false,
        message: "User not found",
        user: null,
        store: null,
        merchantCredentials: null,
      };
    }

    if (!user.isStore) {
      return {
        code: 403,
        success: false,
        message: "Only store users can update merchant details",
        user,
        store: null,
        merchantCredentials: null,
      };
    }

    const store = await stores.findOne({ userId });
    if (!store) {
      return {
        code: 404,
        success: false,
        message: "Store not found",
        user,
        store: null,
        merchantCredentials: null,
      };
    }

    if (store.type !== "merchant") {
      return {
        code: 400,
        success: false,
        message: "Store is not currently a merchant",
        user,
        store: mapStoreDetails(store),
        merchantCredentials: null,
      };
    }

    const regenerateApiKey = Boolean(input.regenerateApiKey);
    const regenerateSecret = Boolean(input.regenerateSecret);

    const updateFields: Partial<Store> = {};
    const changeLabels: string[] = [];

    if (regenerateApiKey) {
      let nextApiKey: string | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = generateMerchantApiKeyCandidate();
        const existingStoreWithKey = await stores.findOne({ merchantApiKey: candidate });

        if (!existingStoreWithKey || existingStoreWithKey.storeId === store.storeId) {
          nextApiKey = candidate;
          break;
        }
      }

      if (!nextApiKey) {
        return {
          code: 500,
          success: false,
          message: "Unable to regenerate merchant API key. Please try again",
          user,
          store: mapStoreDetails(store),
          merchantCredentials: mapMerchantCredentials(store),
        };
      }

      updateFields.merchantApiKey = nextApiKey;
      changeLabels.push("API key");
    }

    if (regenerateSecret) {
      updateFields.merchantSecret = generateMerchantSecret();
      changeLabels.push("secret");
    }

    if (Object.keys(updateFields).length === 0) {
      return {
        code: 400,
        success: false,
        message: "No merchant detail updates provided",
        user,
        store: mapStoreDetails(store),
        merchantCredentials: mapMerchantCredentials(store),
      };
    }

    const updateResult = await stores.updateOne(
      { storeId: store.storeId, userId, type: "merchant" },
      { $set: updateFields }
    );

    if (updateResult.modifiedCount === 0) {
      const refreshedStore = await stores.findOne({ userId });
      return {
        code: 409,
        success: false,
        message: "Unable to update merchant details. Please try again",
        user,
        store: refreshedStore ? mapStoreDetails(refreshedStore) : null,
        merchantCredentials: mapMerchantCredentials(refreshedStore),
      };
    }

    const updatedStore = await stores.findOne({ userId });

    return {
      code: 200,
      success: true,
      message: `Merchant details updated successfully (${changeLabels.join(", ")})`,
      user,
      store: updatedStore ? mapStoreDetails(updatedStore) : null,
      merchantCredentials: mapMerchantCredentials(updatedStore),
    };
  },

  addStoreImage: async (
    _: unknown,
    { image }: { image: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    if (context.user.role === "admin") {
      return {
        code: 403,
        success: false,
        message: "Admin token is not allowed for this action",
        user: null,
        store: null,
        imgurl: null,
      };
    }

    const normalizedImageInput = normalizeImgbbImageInput(image);
    if (normalizedImageInput.error) {
      return {
        code: 400,
        success: false,
        message: normalizedImageInput.error,
        user: null,
        store: null,
        imgurl: null,
      };
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return {
        code: 404,
        success: false,
        message: "User not found",
        user: null,
        store: null,
        imgurl: null,
      };
    }

    if (!user.isStore) {
      return {
        code: 403,
        success: false,
        message: "Only store users can upload a store image",
        user,
        store: null,
        imgurl: null,
      };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return {
        code: 404,
        success: false,
        message: "Store not found",
        user,
        store: null,
        imgurl: null,
      };
    }

    if (store.type !== "merchant") {
      return {
        code: 403,
        success: false,
        message: "Only merchant stores can upload store images",
        user,
        store: mapStoreDetails(store),
        imgurl: null,
      };
    }

    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      return {
        code: 500,
        success: false,
        message: "Image upload not configured",
        user,
        store: mapStoreDetails(store),
        imgurl: null,
      };
    }

    try {
      const formData = new URLSearchParams();
      formData.append("key", apiKey);
      formData.append("image", normalizedImageInput.image);

      const response = await fetch("https://api.imgbb.com/1/upload", {
        method: "POST",
        body: formData,
      });

      const data = await response.json() as {
        success?: boolean;
        data?: { url?: string };
        error?: { message?: string };
      };

      const imgurl = data.data?.url ?? null;
      if (!response.ok || !data.success || !imgurl) {
        const uploadError = data.error?.message || "Image upload failed";
        const message = /unsupported or unrecognized file format/i.test(uploadError)
          ? "Unsupported image format. Upload JPEG, PNG, GIF, or WebP as base64 or image URL"
          : uploadError;

        return {
          code: 400,
          success: false,
          message,
          user,
          store: mapStoreDetails(store),
          imgurl: null,
        };
      }

      const storeUpdate = await catalogsDB.collection<Store>("Stores").updateOne(
        { storeId: store.storeId, userId },
        { $set: { storeImage: imgurl } }
      );

      if (storeUpdate.matchedCount === 0) {
        const refreshedStore = await catalogsDB.collection<Store>("Stores").findOne({ storeId: store.storeId, userId });
        return {
          code: 409,
          success: false,
          message: "Unable to save store image. Please try again",
          user,
          store: refreshedStore ? mapStoreDetails(refreshedStore) : mapStoreDetails(store),
          imgurl: null,
        };
      }

      const updatedStore = await catalogsDB.collection<Store>("Stores").findOne({ storeId: store.storeId, userId });

      return {
        code: 200,
        success: true,
        message: "Store image uploaded successfully",
        user,
        store: updatedStore ? mapStoreDetails(updatedStore) : mapStoreDetails(store),
        imgurl,
      };
    } catch (error) {
      return {
        code: 500,
        success: false,
        message: "Image upload failed",
        user,
        store: mapStoreDetails(store),
        imgurl: null,
      };
    }
  },

  becomeMerchant: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    if (context.user.role === "admin") {
      return {
        code: 403,
        success: false,
        message: "Admin token is not allowed for merchant enrollment",
        user: null,
        store: null,
        wallet: null,
        merchantFunds: null,
        pendingOrders: null,
      };
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
        store: null,
        wallet: null,
        merchantFunds: null,
        pendingOrders: null,
      };
    }

    if (user.isSuspended) {
      return {
        code: 403,
        success: false,
        message: "Your account is suspended. You cannot become a merchant",
        user,
        store: null,
        wallet: null,
        merchantFunds: null,
        pendingOrders: null,
      };
    }

    if (!user.isStore) {
      return {
        code: 403,
        success: false,
        message: "Only store users can become merchants",
        user,
        store: null,
        wallet: null,
        merchantFunds: null,
        pendingOrders: null,
      };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return {
        code: 404,
        success: false,
        message: "Store not found",
        user,
        store: null,
        wallet: null,
        merchantFunds: null,
        pendingOrders: null,
      };
    }

    if (!store.isActive) {
      return {
        code: 403,
        success: false,
        message: "Your store is not active",
        user,
        store: mapStoreDetails(store),
        wallet: null,
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: null,
      };
    }

    if (!store.isApproved) {
      return {
        code: 403,
        success: false,
        message: "Only approved stores can become merchants",
        user,
        store: mapStoreDetails(store),
        wallet: null,
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: null,
      };
    }

    if (store.type === "official") {
      return {
        code: 403,
        success: false,
        message: "Official stores cannot switch to merchant type",
        user,
        store: mapStoreDetails(store),
        wallet: null,
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: null,
      };
    }

    if (store.type === "merchant") {
      const balanceDoc = await walletsDB.collection<Balance>("Balances").findOne({ userId });
      return {
        code: 409,
        success: false,
        message: "Store is already a merchant",
        user,
        store: mapStoreDetails(store),
        wallet: balanceDoc ? mapWalletDetails(balanceDoc) : null,
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: null,
      };
    }

    const balance = await walletsDB.collection<Balance>("Balances").findOne({ userId });
    if (!balance) {
      return {
        code: 404,
        success: false,
        message: "Wallet not found",
        user,
        store: mapStoreDetails(store),
        wallet: null,
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: null,
      };
    }

    if (balance.availableBalance < MERCHANT_LOCK_AMOUNT) {
      return {
        code: 400,
        success: false,
        message: `Insufficient balance. ${MERCHANT_LOCK_AMOUNT} USDT required`,
        user,
        store: mapStoreDetails(store),
        wallet: mapWalletDetails(balance),
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: null,
      };
    }

    const lockedAt = new Date().toISOString();
    const stores = catalogsDB.collection<Store>("Stores");

    let merchantApiKey: string | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateMerchantApiKeyCandidate();
      const existingStoreWithKey = await stores.findOne({ merchantApiKey: candidate });
      if (!existingStoreWithKey) {
        merchantApiKey = candidate;
        break;
      }
    }

    if (!merchantApiKey) {
      return {
        code: 500,
        success: false,
        message: "Unable to generate merchant API key. Please try again",
        user,
        store: mapStoreDetails(store),
        wallet: mapWalletDetails(balance),
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: null,
      };
    }

    const merchantSecret = generateMerchantSecret();

    const balanceUpdate = await walletsDB.collection<Balance>("Balances").updateOne(
      { userId, availableBalance: { $gte: MERCHANT_LOCK_AMOUNT } },
      { $inc: { availableBalance: -MERCHANT_LOCK_AMOUNT, suspendedBalance: MERCHANT_LOCK_AMOUNT } }
    );

    if (balanceUpdate.modifiedCount === 0) {
      const refreshedBalance = await walletsDB.collection<Balance>("Balances").findOne({ userId });
      return {
        code: 409,
        success: false,
        message: "Unable to lock merchant funds due to a balance change. Please try again",
        user,
        store: mapStoreDetails(store),
        wallet: refreshedBalance ? mapWalletDetails(refreshedBalance) : null,
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: null,
      };
    }

    const storeUpdate = await stores.updateOne(
      { storeId: store.storeId, userId, type: { $ne: "merchant" }, isApproved: true },
      {
        $set: {
          type: "merchant",
          bio: generateMerchantStoreBio(store.storeName),
          merchantLockedAmount: MERCHANT_LOCK_AMOUNT,
          merchantLockedAt: lockedAt,
          merchantApiKey,
          merchantSecret,
        },
      }
    );

    if (storeUpdate.modifiedCount === 0) {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId },
        { $inc: { availableBalance: MERCHANT_LOCK_AMOUNT, suspendedBalance: -MERCHANT_LOCK_AMOUNT } }
      );

      const refreshedStore = await catalogsDB.collection<Store>("Stores").findOne({ userId });
      const refreshedBalance = await walletsDB.collection<Balance>("Balances").findOne({ userId });

      return {
        code: 409,
        success: false,
        message: "Unable to update store to merchant. No funds were locked",
        user,
        store: refreshedStore ? mapStoreDetails(refreshedStore) : null,
        wallet: refreshedBalance ? mapWalletDetails(refreshedBalance) : null,
        merchantFunds: buildMerchantFundsStatus(refreshedStore),
        pendingOrders: null,
      };
    }

    const merchantUpgradeTransaction: Transaction = {
      userId,
      id: crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, ""),
      type: "MerchantUpgrade",
      status: "completed",
      method: "balance",
      amount: MERCHANT_LOCK_AMOUNT,
      createdAt: lockedAt,
    };

    await walletsDB.collection<Transaction>("Transactions").insertOne(merchantUpgradeTransaction);

    const updatedStore = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    const updatedBalance = await walletsDB.collection<Balance>("Balances").findOne({ userId });

    if (shouldSendEmailForUser(user) && updatedStore) {
      try {
        const html = renderStoreMerchantUpgradeEmail(user, updatedStore, lockedAt);

        await smtpTransporter.sendMail({
          from: `GAMEKET <${process.env.SMTP_EMAIL}>`,
          to: user.email,
          subject: "Your Store Is Now a Merchant Store",
          html,
        });
      } catch (error) {
        console.error("Failed to send merchant upgrade email:", error);
      }
    }

    return {
      code: 200,
      success: true,
      message: `${MERCHANT_LOCK_AMOUNT} USDT locked successfully. Store is now a merchant`,
      user,
      store: updatedStore ? mapStoreDetails(updatedStore) : null,
      wallet: updatedBalance ? mapWalletDetails(updatedBalance) : null,
      merchantFunds: buildMerchantFundsStatus(updatedStore),
      pendingOrders: null,
    };
  },

  UnfreezeMerchantfunds: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    if (context.user.role === "admin") {
      return {
        code: 403,
        success: false,
        message: "Admin token is not allowed for this action",
        user: null,
        store: null,
        wallet: null,
        merchantFunds: null,
        pendingOrders: null,
      };
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
        store: null,
        wallet: null,
        merchantFunds: null,
        pendingOrders: null,
      };
    }

    if (!user.isStore) {
      return {
        code: 403,
        success: false,
        message: "Only store users can unfreeze merchant funds",
        user,
        store: null,
        wallet: null,
        merchantFunds: null,
        pendingOrders: null,
      };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return {
        code: 404,
        success: false,
        message: "Store not found",
        user,
        store: null,
        wallet: null,
        merchantFunds: null,
        pendingOrders: null,
      };
    }

    if (store.type !== "merchant") {
      const walletDoc = await walletsDB.collection<Balance>("Balances").findOne({ userId });
      return {
        code: 400,
        success: false,
        message: "Store is not currently a merchant",
        user,
        store: mapStoreDetails(store),
        wallet: walletDoc ? mapWalletDetails(walletDoc) : null,
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: null,
      };
    }

    const lockAmount = Number(store.merchantLockedAmount ?? 0);
    const lockedAt = store.merchantLockedAt;
    const lockedAtMs = lockedAt ? new Date(lockedAt).getTime() : NaN;

    if (!lockedAt || !Number.isFinite(lockedAtMs) || lockAmount <= 0) {
      const walletDoc = await walletsDB.collection<Balance>("Balances").findOne({ userId });
      return {
        code: 400,
        success: false,
        message: "No locked merchant funds found for this store",
        user,
        store: mapStoreDetails(store),
        wallet: walletDoc ? mapWalletDetails(walletDoc) : null,
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: null,
      };
    }

    const unlocksAtMs = lockedAtMs + MERCHANT_LOCK_PERIOD_MS;
    const nowMs = Date.now();
    if (nowMs < unlocksAtMs) {
      const daysRemaining = Math.ceil((unlocksAtMs - nowMs) / (24 * 60 * 60 * 1000));
      const walletDoc = await walletsDB.collection<Balance>("Balances").findOne({ userId });

      return {
        code: 400,
        success: false,
        message: `Merchant funds can be unfrozen after ${daysRemaining} day(s)`,
        user,
        store: mapStoreDetails(store),
        wallet: walletDoc ? mapWalletDetails(walletDoc) : null,
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: null,
      };
    }

    const pendingReleaseOrders = await walletsDB
      .collection<Order>("Orders")
      .countDocuments({
        sellerId: userId,
        isReleased: false,
        status: { $in: ["completed", "pending"] },
      });

    if (pendingReleaseOrders > 0) {
      const walletDoc = await walletsDB.collection<Balance>("Balances").findOne({ userId });

      return {
        code: 400,
        success: false,
        message: "Merchant funds cannot be unfrozen while there are orders waiting for funds release",
        user,
        store: mapStoreDetails(store),
        wallet: walletDoc ? mapWalletDetails(walletDoc) : null,
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: pendingReleaseOrders,
      };
    }

    const balanceUpdate = await walletsDB.collection<Balance>("Balances").updateOne(
      { userId, suspendedBalance: { $gte: lockAmount } },
      { $inc: { availableBalance: lockAmount, suspendedBalance: -lockAmount } }
    );

    if (balanceUpdate.modifiedCount === 0) {
      const walletDoc = await walletsDB.collection<Balance>("Balances").findOne({ userId });
      return {
        code: 409,
        success: false,
        message: "Unable to unfreeze merchant funds. Suspended balance is insufficient",
        user,
        store: mapStoreDetails(store),
        wallet: walletDoc ? mapWalletDetails(walletDoc) : null,
        merchantFunds: buildMerchantFundsStatus(store),
        pendingOrders: 0,
      };
    }

    const nextStoreType = user.isPremium ? "premium" : "basic";

    const storeUpdate = await catalogsDB.collection<Store>("Stores").updateOne(
      { storeId: store.storeId, userId, type: "merchant" },
      {
        $set: {
          type: nextStoreType,
          merchantLockedAmount: 0,
          merchantLockedAt: null,
          merchantApiKey: null,
          merchantSecret: null,
        },
      }
    );

    if (storeUpdate.modifiedCount === 0) {
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId },
        { $inc: { availableBalance: -lockAmount, suspendedBalance: lockAmount } }
      );

      const refreshedStore = await catalogsDB.collection<Store>("Stores").findOne({ userId });
      const refreshedBalance = await walletsDB.collection<Balance>("Balances").findOne({ userId });

      return {
        code: 409,
        success: false,
        message: "Unable to remove merchant benefits. Funds were restored to locked state",
        user,
        store: refreshedStore ? mapStoreDetails(refreshedStore) : null,
        wallet: refreshedBalance ? mapWalletDetails(refreshedBalance) : null,
        merchantFunds: buildMerchantFundsStatus(refreshedStore),
        pendingOrders: 0,
      };
    }

    const updatedStore = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    const updatedBalance = await walletsDB.collection<Balance>("Balances").findOne({ userId });

    return {
      code: 200,
      success: true,
      message: `Merchant funds unfrozen successfully. Store returned to ${nextStoreType} type`,
      user,
      store: updatedStore ? mapStoreDetails(updatedStore) : null,
      wallet: updatedBalance ? mapWalletDetails(updatedBalance) : null,
      merchantFunds: buildMerchantFundsStatus(updatedStore),
      pendingOrders: 0,
    };
  },

  updateDeliveryOption: async (
    _: unknown,
    { option }: { option: "email" | "telegram" },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user) {
      return { code: 404, success: false, message: "User not found", user: null };
    }

    await db.collection<User>("users").updateOne(
      { id: userId },
      { $set: { deliveryOption: option } }
    );

    const updatedUser = await db.collection<User>("users").findOne({ id: userId });

    return {
      code: 200,
      success: true,
      message: `Delivery option updated to ${option}`,
      user: updatedUser,
    };
  },
};
