import crypto from "crypto";
import { allGroups } from "../../../data/categories/index.js";
import { GraphQLError } from "graphql";
import { v4 as uuidv4 } from "uuid";
import { getCatalogsDB, getDB, getWalletsDB } from "../../db.js";
import type { Product, PromotedProduct, PromotedStore, Store, User, Balance, Transaction, VerificationRequest } from "../../types.js";
import type { Context } from "../../index.js";
import countryData from "../../../data/country.json";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

const smtpTransporter = nodemailer.createTransport({
  host: "gameket.io",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

// Rate limiting for adminAuthorizeStore
const adminAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

// Verification image limits
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB in bytes
const ALLOWED_IMAGE_SIGNATURES: Record<string, string> = {
  "/9j/": "image/jpeg",
  iVBORw0KGgo: "image/png",
  R0lGODlh: "image/gif",
  UklGR: "image/webp",
};

function validateBase64Image(base64: string, fieldName: string): void {
  // Strip data URI prefix if present
  const raw = base64.replace(/^data:image\/\w+;base64,/, "");

  // Check size (base64 is ~33% larger than binary)
  const sizeInBytes = Math.ceil((raw.length * 3) / 4);
  if (sizeInBytes > MAX_IMAGE_SIZE) {
    throw new GraphQLError(`${fieldName} exceeds the 5MB size limit`, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }

  // Validate it's actually an image by checking magic bytes
  const isImage = Object.keys(ALLOWED_IMAGE_SIGNATURES).some((sig) =>
    raw.startsWith(sig)
  );
  if (!isImage) {
    throw new GraphQLError(
      `${fieldName} must be a valid image (JPEG, PNG, GIF, or WebP)`,
      { extensions: { code: "BAD_USER_INPUT" } }
    );
  }
}

function sanitizeTextInput(value: string, fieldName: string, maxLength: number = 200): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new GraphQLError(`${fieldName} is required`, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  if (trimmed.length > maxLength) {
    throw new GraphQLError(`${fieldName} must not exceed ${maxLength} characters`, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  // Strip HTML tags and control characters
  const sanitized = trimmed
    .replace(/<[^>]*>/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  if (sanitized.length === 0) {
    throw new GraphQLError(`${fieldName} contains invalid content`, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  return sanitized;
}
const ALGORITHM = "aes-256-gcm";

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, "hex"), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText: string): string {
  const [ivHex, authTagHex, ciphertext] = encryptedText.split(":");
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, "hex"), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

const validRegions = new Set([
  ...Object.values(countryData.countries).map((c) => c.toLowerCase()),
  ...Object.values(countryData.regions).map((r) => r.toLowerCase()),
]);

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString("base64");
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64").toString("utf-8");
  return parseInt(decoded.replace("cursor:", ""), 10);
}

export const catalogsQueries = {
  getUserProducts: async (
    _: unknown,
    { productId, first, after, last, before }: { productId?: string; first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can view their products", product: null, products: null };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return { code: 403, success: false, message: "You must have a store to view products", product: null, products: null };
    }

    if (!store.isActive) {
      return { code: 403, success: false, message: "Your store is not active", product: null, products: null };
    }

    // Single product lookup
    if (productId) {
      const p = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
      if (!p) {
        return { code: 404, success: false, message: "Product not found or does not belong to you", product: null, products: null };
      }
      return {
        code: 200,
        success: true,
        message: "Product retrieved successfully",
        user,
        product: {
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
        },
        products: null,
      };
    }

    const allProducts = await catalogsDB.collection<Product>("Products").find({ userId }).toArray();
    const total = allProducts.length;

    let start = 0;
    let end = total;

    if (first != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + first, total);
    } else if (first != null) {
      end = Math.min(first, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allProducts.slice(start, end);

    const edges = sliced.map((p, i) => ({
      cursor: encodeCursor(start + i),
      node: {
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
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} product(s) found`,
      user,
      products: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  viewProductCodes: async (
    _: unknown,
    { productId, first, after, last, before }: { productId: string; first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can view product codes", availableCodes: null, soldCodes: null };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you", availableCodes: null, soldCodes: null };
    }

    const allAvailable = product.availableCodes.map((c) => decrypt(c));
    const allSold = (product.soldCodes || []).map((c) => decrypt(c));

    function paginateCodes(codes: string[]) {
      const total = codes.length;
      let start = 0;
      let end = total;

      if (first != null && after) {
        start = decodeCursor(after) + 1;
        end = Math.min(start + first, total);
      } else if (first != null) {
        end = Math.min(first, total);
      } else if (last != null && before) {
        end = decodeCursor(before);
        start = Math.max(end - last, 0);
      } else if (last != null) {
        start = Math.max(total - last, 0);
      }

      const sliced = codes.slice(start, end);

      const edges = sliced.map((code, i) => ({
        cursor: encodeCursor(start + i),
        node: code,
      }));

      return {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      };
    }

    return {
      code: 200,
      success: true,
      message: `${allAvailable.length} available, ${allSold.length} sold`,
      user,
      availableCodes: paginateCodes(allAvailable),
      soldCodes: paginateCodes(allSold),
    };
  },

  getUserAdvertisableProducts: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can view advertisable products", products: null };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return { code: 403, success: false, message: "You must have a store to view products", products: null };
    }

    if (!store.isActive) {
      return { code: 403, success: false, message: "Your store is not active", products: null };
    }

    const allProducts = await catalogsDB
      .collection<Product>("Products")
      .find({ userId, isActive: true, isPromoted: false })
      .toArray();
    const total = allProducts.length;

    let start = 0;
    let end = total;

    if (first != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + first, total);
    } else if (first != null) {
      end = Math.min(first, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allProducts.slice(start, end);

    const edges = sliced.map((p, i) => ({
      cursor: encodeCursor(start + i),
      node: {
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
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} advertisable product(s) found`,
      user,
      products: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  checkProductADPosition: async (
    _: unknown,
    { productId, amount }: { productId: string; amount: number },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can check ad positions", category: null, overallPosition: null, categoryPosition: null, totalPromoted: null, totalPromotedInCategory: null };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you", category: null, overallPosition: null, categoryPosition: null, totalPromoted: null, totalPromotedInCategory: null };
    }

    if (amount < 0.5) {
      return { code: 400, success: false, message: "Minimum ad amount is 0.5", category: null, overallPosition: null, categoryPosition: null, totalPromoted: null, totalPromotedInCategory: null };
    }

    const allPromotions = await catalogsDB
      .collection<PromotedProduct>("PromotedProducts")
      .find()
      .sort({ amount: -1, createdAt: 1 })
      .toArray();

    // Simulate overall position
    const overallPosition = allPromotions.filter((p) => p.amount > amount).length + 1;
    const totalPromoted = allPromotions.length + 1;

    // Get product IDs for category filtering
    const promotedProductIds = allPromotions.map((p) => p.productId);
    const promotedProducts = promotedProductIds.length
      ? await catalogsDB
          .collection<Product>("Products")
          .find({ productId: { $in: promotedProductIds }, category: product.category })
          .toArray()
      : [];

    const categoryProductIds = new Set(promotedProducts.map((p) => p.productId));
    const categoryPromotions = allPromotions.filter((p) => categoryProductIds.has(p.productId));

    const categoryPosition = categoryPromotions.filter((p) => p.amount > amount).length + 1;
    const totalPromotedInCategory = categoryPromotions.length + 1;

    return {
      code: 200,
      success: true,
      message: `With an amount of ${amount}, your product would be ranked #${overallPosition} overall and #${categoryPosition} in its category`,
      user,
      category: product.category,
      overallPosition,
      categoryPosition,
      totalPromoted,
      totalPromotedInCategory,
    };
  },

  checkStoreADPosition: async (
    _: unknown,
    { amount }: { amount: number },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can check ad positions", overallPosition: null, totalPromoted: null };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return { code: 404, success: false, message: "Store not found", overallPosition: null, totalPromoted: null };
    }

    if (amount < 0.5) {
      return { code: 400, success: false, message: "Minimum ad amount is 0.5", overallPosition: null, totalPromoted: null };
    }

    const allPromotions = await catalogsDB
      .collection<PromotedStore>("PromotedStores")
      .find()
      .sort({ amount: -1, createdAt: 1 })
      .toArray();

    const overallPosition = allPromotions.filter((p) => p.amount > amount).length + 1;
    const totalPromoted = allPromotions.length + 1;

    return {
      code: 200,
      success: true,
      message: `With an amount of ${amount}, your store would be ranked #${overallPosition} overall`,
      user,
      overallPosition,
      totalPromoted,
    };
  },

  fetchCatalog: async (
    _: unknown,
    { name, category, first, after, last, before }: { name: string; category?: string; first?: number; after?: string; last?: number; before?: string }
  ) => {
    const searchName = name.trim().toLowerCase();

    if (searchName.length === 0) {
      return { code: 400, success: false, message: "Name is required", group: null, item: null };
    }

    const group = allGroups.find(
      (g) => g.title.toLowerCase() === searchName
    );

    if (!group) {
      return { code: 404, success: false, message: "Catalog not found", group: null, item: null };
    }

    // If category provided, return single item
    if (category && category.trim().length > 0) {
      const searchCategory = category.trim().toLowerCase();
      const found = group.categories.find(
        (c) => c.name.toLowerCase() === searchCategory
      );

      if (!found) {
        return { code: 404, success: false, message: "Category not found in this catalog", group: null, item: null };
      }

      return {
        code: 200,
        success: true,
        message: "Category retrieved successfully",
        group: null,
        item: {
          slug: found.slug,
          name: found.name,
          groupId: group.id,
          groupTitle: group.title,
        },
      };
    }

    // Paginate categories
    const allCategories = group.categories;
    const totalCount = allCategories.length;

    let startIndex: number;
    let endIndex: number;

    if (before) {
      // Backward pagination
      const beforeIndex = decodeCursor(before);
      const limit = last ?? 20;
      startIndex = Math.max(0, beforeIndex - limit);
      endIndex = beforeIndex;
    } else {
      // Forward pagination
      const limit = first ?? 20;
      startIndex = after ? decodeCursor(after) + 1 : 0;
      endIndex = startIndex + limit;
    }

    const sliced = allCategories.slice(startIndex, endIndex);

    const edges = sliced.map((cat, i) => ({
      cursor: encodeCursor(startIndex + i),
      node: {
        slug: cat.slug,
        name: cat.name,
        groupId: group.id,
        groupTitle: group.title,
      },
    }));

    const lastIndex = startIndex + sliced.length - 1;

    return {
      code: 200,
      success: true,
      message: "Catalog retrieved successfully",
      group: {
        id: group.id,
        title: group.title,
        icon: group.icon,
        categories: {
          edges,
          pageInfo: {
            hasNextPage: lastIndex < totalCount - 1,
            hasPreviousPage: startIndex > 0,
            startCursor: edges.length > 0 ? edges[0].cursor : null,
            endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
            fetchedCount: sliced.length,
            remainingCount: Math.max(0, totalCount - (startIndex + sliced.length)),
          },
          totalCount,
        },
      },
      item: null,
    };
  },

  getPromotedProducts: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string }
  ) => {
    const catalogsDB = getCatalogsDB();
    const now = new Date().toISOString();

    // Get active promotions
    const activePromotions = await catalogsDB
      .collection<PromotedProduct>("PromotedProducts")
      .find({ campaignEnd: { $gte: now } })
      .sort({ amount: -1 })
      .toArray();

    const promotedProductIds = new Set(activePromotions.map((p) => p.productId));

    // Get all active products
    const allActiveProducts = await catalogsDB
      .collection<Product>("Products")
      .find({ isActive: true })
      .toArray();

    if (!allActiveProducts.length) {
      return {
        code: 200,
        success: true,
        message: "No products found",
        products: { edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null, fetchedCount: 0, remainingCount: 0 } },
      };
    }

    // Split into promoted and non-promoted
    const promoted = allActiveProducts.filter((p) => promotedProductIds.has(p.productId));
    const nonPromoted = allActiveProducts.filter((p) => !promotedProductIds.has(p.productId));

    // Sort promoted by ad spend descending
    const promoAmountMap = new Map(activePromotions.map((p) => [p.productId, p.amount]));
    promoted.sort((a, b) => (promoAmountMap.get(b.productId) || 0) - (promoAmountMap.get(a.productId) || 0));

    // Sort non-promoted by recently added to oldest
    nonPromoted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Fetch store details
    const storeUserIds = [...new Set(allActiveProducts.map((p) => p.userId))];
    const stores = await catalogsDB
      .collection<Store>("Stores")
      .find({ userId: { $in: storeUserIds } })
      .toArray();
    const storeMap = new Map(stores.map((s) => [s.userId, s]));

    const mapProduct = (p: Product) => {
      const s = storeMap.get(p.userId);
      return {
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
        store: s
          ? {
              storeId: s.storeId,
              storeName: s.storeName,
              isActive: s.isActive,
              isApproved: s.isApproved,
              approveStatus: s.approveStatus ?? null,
              isPromoted: s.isPromoted,
              type: s.type,
              totalSales: s.totalSales,
              positiveReviews: s.positiveReviews,
              negativeReviews: s.negativeReviews,
              registered: s.createdAt?.split("T")[0] || s.createdAt,
              requestCount: s.requestCount ?? 0,
            }
          : null,
      };
    };

    // Promoted first, then non-promoted
    const merged = [...promoted.map(mapProduct), ...nonPromoted.map(mapProduct)];

    const total = merged.length;
    const defaultPageSize = 30;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let start = 0;
    let end = total;

    if (pageFirst != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + pageFirst, total);
    } else if (pageFirst != null) {
      end = Math.min(pageFirst, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = merged.slice(start, end);

    const edges = sliced.map((item, i) => ({
      cursor: encodeCursor(start + i),
      node: item,
    }));

    return {
      code: 200,
      success: true,
      message: `${total} product(s) found`,
      products: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  getPromotedStores: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string }
  ) => {
    const catalogsDB = getCatalogsDB();
    const now = new Date().toISOString();

    // Get active promotions
    const activePromotions = await catalogsDB
      .collection<PromotedStore>("PromotedStores")
      .find({ campaignEnd: { $gte: now } })
      .sort({ amount: -1 })
      .toArray();

    const promotedStoreIds = new Set(activePromotions.map((p) => p.storeId));

    // Get all active stores
    const allActiveStores = await catalogsDB
      .collection<Store>("Stores")
      .find({ isActive: true })
      .toArray();

    if (!allActiveStores.length) {
      return {
        code: 200,
        success: true,
        message: "No stores found",
        store: { edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null, fetchedCount: 0, remainingCount: 0 } },
      };
    }

    // Split into promoted and non-promoted
    const promoted = allActiveStores.filter((s) => promotedStoreIds.has(s.storeId));
    const nonPromoted = allActiveStores.filter((s) => !promotedStoreIds.has(s.storeId));

    // Sort promoted by ad spend descending
    const promoAmountMap = new Map(activePromotions.map((p) => [p.storeId, p.amount]));
    promoted.sort((a, b) => (promoAmountMap.get(b.storeId) || 0) - (promoAmountMap.get(a.storeId) || 0));

    // Sort non-promoted by highest sales to lowest
    nonPromoted.sort((a, b) => b.totalSales - a.totalSales);

    const mapStore = (s: Store) => ({
      storeId: s.storeId,
      storeName: s.storeName,
      isActive: s.isActive,
      isApproved: s.isApproved,
      approveStatus: s.approveStatus ?? null,
      isPromoted: s.isPromoted,
      type: s.type,
      totalSales: s.totalSales,
      positiveReviews: s.positiveReviews,
      negativeReviews: s.negativeReviews,
      registered: s.createdAt?.split("T")[0] || s.createdAt,
      requestCount: s.requestCount ?? 0,
    });

    // Promoted first, then non-promoted
    const merged = [...promoted.map(mapStore), ...nonPromoted.map(mapStore)];

    const total = merged.length;
    const defaultPageSize = 10;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let start = 0;
    let end = total;

    if (pageFirst != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + pageFirst, total);
    } else if (pageFirst != null) {
      end = Math.min(pageFirst, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = merged.slice(start, end);

    const edges = sliced.map((item, i) => ({
      cursor: encodeCursor(start + i),
      node: item,
    }));

    return {
      code: 200,
      success: true,
      message: `${total} store(s) found`,
      store: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  getProducts: async (
    _: unknown,
    { category, region, min, max, sort, first, after, last, before }: {
      category: string; region?: string; min?: number; max?: number; sort?: string;
      first?: number; after?: string; last?: number; before?: string;
    }
  ) => {
    const catalogsDB = getCatalogsDB();
    const now = new Date().toISOString();

    // Get active promotions for this category
    const activePromotions = await catalogsDB
      .collection<PromotedProduct>("PromotedProducts")
      .find({ campaignEnd: { $gte: now } })
      .sort({ amount: -1 })
      .toArray();

    const promotedProductIds = new Set(activePromotions.map((p) => p.productId));

    // Build filter query
    const filter: Record<string, unknown> = { category, isActive: true };
    if (region) filter.region = region;
    if (min != null || max != null) {
      filter.price = {} as Record<string, number>;
      if (min != null) (filter.price as Record<string, number>).$gte = min;
      if (max != null) (filter.price as Record<string, number>).$lte = max;
    }

    // Get all active products in the category
    const allCategoryProducts = await catalogsDB
      .collection<Product>("Products")
      .find(filter)
      .toArray();

    if (!allCategoryProducts.length) {
      return {
        code: 200,
        success: true,
        message: "No products found in this category",
        products: { edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null, fetchedCount: 0, remainingCount: 0 } },
      };
    }

    // Split into promoted and non-promoted
    const promoted = allCategoryProducts.filter((p) => promotedProductIds.has(p.productId));
    const nonPromoted = allCategoryProducts.filter((p) => !promotedProductIds.has(p.productId));

    // Sort promoted by ad spend descending
    const promoAmountMap = new Map(activePromotions.map((p) => [p.productId, p.amount]));
    promoted.sort((a, b) => (promoAmountMap.get(b.productId) || 0) - (promoAmountMap.get(a.productId) || 0));

    // Sort non-promoted by sold descending, then createdAt descending
    nonPromoted.sort((a, b) => {
      if (b.sold !== a.sold) return b.sold - a.sold;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Fetch store details for all products
    const storeUserIds = [...new Set(allCategoryProducts.map((p) => p.userId))];
    const stores = await catalogsDB
      .collection<Store>("Stores")
      .find({ userId: { $in: storeUserIds } })
      .toArray();
    const storeMap = new Map(stores.map((s) => [s.userId, s]));

    const mapProduct = (p: Product) => {
      const s = storeMap.get(p.userId);
      return {
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
        store: s
          ? {
              storeId: s.storeId,
              storeName: s.storeName,
              isActive: s.isActive,
              isApproved: s.isApproved,
              approveStatus: s.approveStatus ?? null,
              isPromoted: s.isPromoted,
              type: s.type,
              totalSales: s.totalSales,
              positiveReviews: s.positiveReviews,
              negativeReviews: s.negativeReviews,
              registered: s.createdAt?.split("T")[0] || s.createdAt,
              requestCount: s.requestCount ?? 0,
            }
          : null,
      };
    };

    // Promoted first, then non-promoted
    let merged = [...promoted.map(mapProduct), ...nonPromoted.map(mapProduct)];

    // Apply sort override if specified
    if (sort === "LOW_HIGH") {
      merged.sort((a, b) => a.price - b.price);
    } else if (sort === "RANK") {
      merged.sort((a, b) => (b.store?.totalSales ?? 0) - (a.store?.totalSales ?? 0));
    } else if (sort === "QUANTITY_SOLD") {
      merged.sort((a, b) => b.sold - a.sold);
    }

    const total = merged.length;
    const defaultPageSize = 30;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let start = 0;
    let end = total;

    if (pageFirst != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + pageFirst, total);
    } else if (pageFirst != null) {
      end = Math.min(pageFirst, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = merged.slice(start, end);

    const edges = sliced.map((item, i) => ({
      cursor: encodeCursor(start + i),
      node: item,
    }));

    return {
      code: 200,
      success: true,
      message: `${total} product(s) found`,
      products: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  getProductDetails: async (
    _: unknown,
    { productId }: { productId: string }
  ) => {
    const catalogsDB = getCatalogsDB();

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found", product: null };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId: product.userId });

    return {
      code: 200,
      success: true,
      message: "Product retrieved successfully",
      product: {
        productId: product.productId,
        catalog: product.catalog,
        category: product.category,
        region: product.region,
        name: product.name,
        description: product.description,
        marketPrice: product.marketPrice,
        price: product.price,
        discount: product.discount,
        isActive: product.isActive,
        isPromoted: product.isPromoted,
        available: product.available,
        sold: product.sold,
        type: product.type,
        createdAt: product.createdAt,
        store: store
          ? {
              storeId: store.storeId,
              storeName: store.storeName,
              isActive: store.isActive,
              isApproved: store.isApproved,
              approveStatus: store.approveStatus ?? null,
              isPromoted: store.isPromoted,
              type: store.type,
              totalSales: store.totalSales,
              positiveReviews: store.positiveReviews,
              negativeReviews: store.negativeReviews,
              registered: store.createdAt?.split("T")[0] || store.createdAt,
              requestCount: store.requestCount ?? 0,
            }
          : null,
      },
    };
  },

  getStoreDetails: async (
    _: unknown,
    { storeId, first, after, last, before }: { storeId: string; first?: number; after?: string; last?: number; before?: string }
  ) => {
    const catalogsDB = getCatalogsDB();

    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId });
    if (!store) {
      return { code: 404, success: false, message: "Store not found", store: null, products: null };
    }

    const allProducts = await catalogsDB
      .collection<Product>("Products")
      .find({ userId: store.userId, isActive: true })
      .sort({ sold: -1, createdAt: -1 })
      .toArray();

    const total = allProducts.length;
    const defaultPageSize = 30;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let start = 0;
    let end = total;

    if (pageFirst != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + pageFirst, total);
    } else if (pageFirst != null) {
      end = Math.min(pageFirst, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allProducts.slice(start, end);

    const edges = sliced.map((p, i) => ({
      cursor: encodeCursor(start + i),
      node: {
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
      },
    }));

    return {
      code: 200,
      success: true,
      message: "Store retrieved successfully",
      store: {
        storeId: store.storeId,
        storeName: store.storeName,
        isActive: store.isActive,
        isApproved: store.isApproved,
        approveStatus: store.approveStatus ?? null,
        isPromoted: store.isPromoted,
        type: store.type,
        totalSales: store.totalSales,
        positiveReviews: store.positiveReviews,
        negativeReviews: store.negativeReviews,
        registered: store.createdAt?.split("T")[0] || store.createdAt,
        requestCount: store.requestCount ?? 0,
      },
      products: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  getStores: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string }
  ) => {
    const catalogsDB = getCatalogsDB();

    const allStores = await catalogsDB
      .collection<Store>("Stores")
      .find({ isActive: true })
      .sort({ totalSales: -1 })
      .toArray();

    const total = allStores.length;
    const defaultPageSize = 30;
    const pageFirst = first ?? (last == null ? defaultPageSize : undefined);
    let start = 0;
    let end = total;

    if (pageFirst != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + pageFirst, total);
    } else if (pageFirst != null) {
      end = Math.min(pageFirst, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allStores.slice(start, end);

    const edges = sliced.map((s, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        storeId: s.storeId,
        storeName: s.storeName,
        isActive: s.isActive,
        isApproved: s.isApproved,
        approveStatus: s.approveStatus ?? null,
        isPromoted: s.isPromoted,
        type: s.type,
        totalSales: s.totalSales,
        positiveReviews: s.positiveReviews,
        negativeReviews: s.negativeReviews,
        registered: s.createdAt?.split("T")[0] || s.createdAt,
        requestCount: s.requestCount ?? 0,
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} store(s) found`,
      stores: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },

  getVerificationRequest: async (
    _: unknown,
    { storeId, superkey }: { storeId: string; superkey: string }
  ) => {
    const db = getDB();

    // Verify superkey
    const admin = await db.collection("Admin").findOne({ key: "superkey" });
    if (!admin) {
      return { code: 500, success: false, message: "Admin configuration missing", verification: null };
    }

    const isValid = await bcrypt.compare(superkey, admin.value);
    if (!isValid) {
      return { code: 403, success: false, message: "Invalid superkey", verification: null };
    }

    const verification = await db.collection<VerificationRequest>("Verification").findOne({ storeId });
    if (!verification) {
      return { code: 404, success: false, message: "No verification request found for this store", verification: null };
    }

    return {
      code: 200,
      success: true,
      message: "Verification request retrieved",
      verification: {
        userId: verification.userId,
        storeId: verification.storeId,
        storeName: verification.storeName,
        surname: verification.surname,
        otherNames: verification.otherNames,
        gender: verification.gender,
        dateOfBirth: verification.dateOfBirth,
        address: verification.address,
        nationality: verification.nationality,
        identification: verification.identification,
        proofPerson: verification.proofPerson,
        submittedAt: verification.submittedAt,
      },
    };
  },
};

export const catalogsMutations = {
  addProduct: async (
    _: unknown,
    { input }: { input: { catalog: string; category: string; region: string; name: string; description: string; marketPrice: number; price: number; type: string } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    // Verify user is a seller
    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can create products", product: null };
    }

    // Verify user has a store
    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return { code: 403, success: false, message: "You must have a store to add products", product: null };
    }

    if (!store.isActive) {
      return { code: 403, success: false, message: "Your store is not active", product: null };
    }

    const catalog = input.catalog.trim();
    const category = input.category.trim();
    const region = input.region.trim();
    const name = input.name.trim();
    const description = input.description.trim();
    const { marketPrice, price } = input;

    // Validate required fields
    if (catalog.length === 0) {
      return { code: 400, success: false, message: "Catalog is required", product: null };
    }
    if (category.length === 0) {
      return { code: 400, success: false, message: "Category is required", product: null };
    }
    if (region.length === 0) {
      return { code: 400, success: false, message: "Region is required", product: null };
    }
    if (name.length === 0) {
      return { code: 400, success: false, message: "Name is required", product: null };
    }
    if (name.length > 100) {
      return { code: 400, success: false, message: "Name must be at most 100 characters", product: null };
    }
    if (description.length === 0) {
      return { code: 400, success: false, message: "Description is required", product: null };
    }
    if (description.length > 500) {
      return { code: 400, success: false, message: "Description must be at most 500 characters", product: null };
    }
    if (marketPrice <= 0) {
      return { code: 400, success: false, message: "Market price must be greater than 0", product: null };
    }
    if (price <= 0) {
      return { code: 400, success: false, message: "Price must be greater than 0", product: null };
    }
    if (price > marketPrice) {
      return { code: 400, success: false, message: "Price cannot exceed market price", product: null };
    }

    // Validate type
    const productType = input.type;
    if (productType !== "Auto" && productType !== "Manual") {
      return { code: 400, success: false, message: "Type must be either 'Auto' or 'Manual'", product: null };
    }

    // Validate catalog exists
    const group = allGroups.find(
      (g) => g.title.toLowerCase() === catalog.toLowerCase()
    );
    if (!group) {
      return { code: 400, success: false, message: "Invalid catalog", product: null };
    }

    // Validate category exists in catalog
    const categoryExists = group.categories.some(
      (c) => c.name.toLowerCase() === category.toLowerCase()
    );
    if (!categoryExists) {
      return { code: 400, success: false, message: "Invalid category for this catalog", product: null };
    }

    // Validate region
    if (!validRegions.has(region.toLowerCase())) {
      return { code: 400, success: false, message: "Invalid region or country", product: null };
    }

    // Calculate discount
    const discount = parseFloat((((marketPrice - price) / marketPrice) * 100).toFixed(2));

    const product: Product = {
      userId,
      storeId: store.storeId,
      productId: uuidv4(),
      catalog,
      category,
      region,
      name,
      description,
      marketPrice: parseFloat(marketPrice.toFixed(2)),
      price: parseFloat(price.toFixed(2)),
      discount,
      type: productType as "Auto" | "Manual",
      isActive: false,
      isPromoted: false,
      available: 0,
      sold: 0,
      availableCodes: [],
      soldCodes: [],
      createdAt: new Date().toISOString(),
    };

    await catalogsDB.collection<Product>("Products").insertOne(product);

    return {
      code: 201,
      success: true,
      message: "Product added successfully",
      user,
      product: {
        productId: product.productId,
        catalog: product.catalog,
        category: product.category,
        region: product.region,
        name: product.name,
        description: product.description,
        marketPrice: product.marketPrice,
        price: product.price,
        discount: product.discount,
        isActive: product.isActive,
        isPromoted: product.isPromoted,
        available: product.available,
        sold: product.sold,
        type: product.type,
        createdAt: product.createdAt,
      },
    };
  },

  addProductCodes: async (
    _: unknown,
    { input }: { input: { productId: string; codes: string[] } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const userId = context.user.userId;
    const { productId, codes } = input;

    if (!codes.length) {
      return { code: 400, success: false, message: "Codes array cannot be empty", available: null };
    }

    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });

    // Verify product belongs to user
    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you", available: null };
    }

    // Encrypt each code
    const encryptedCodes = codes.map((code) => encrypt(code.trim()));

    // Push codes and increment available count
    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId },
      {
        $push: { availableCodes: { $each: encryptedCodes } },
        $inc: { available: encryptedCodes.length },
        $set: { isActive: true },
      }
    );

    return {
      code: 200,
      success: true,
      message: `${encryptedCodes.length} code(s) added successfully`,
      user,
      available: product.available + encryptedCodes.length,
    };
  },

  deleteProductCodes: async (
    _: unknown,
    { input }: { input: { productId: string; codes: string[] } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const userId = context.user.userId;
    const { productId, codes } = input;

    if (!codes.length) {
      return { code: 400, success: false, message: "Codes array cannot be empty", available: null };
    }

    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you", available: null };
    }

    if (!product.availableCodes.length) {
      return { code: 400, success: false, message: "No codes available to delete", available: product.available };
    }

    // Decrypt stored codes to find matches
    const codesToDelete = new Set(codes.map((c) => c.trim()));
    const toRemove: string[] = [];
    const toKeep: string[] = [];

    for (const encrypted of product.availableCodes) {
      const decrypted = decrypt(encrypted);
      if (codesToDelete.has(decrypted)) {
        toRemove.push(encrypted);
        codesToDelete.delete(decrypted);
      } else {
        toKeep.push(encrypted);
      }
    }

    if (!toRemove.length) {
      return { code: 404, success: false, message: "None of the provided codes were found", available: product.available };
    }

    const newAvailable = product.available - toRemove.length;

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId },
      {
        $set: { availableCodes: toKeep, available: newAvailable, isActive: newAvailable > 0 },
      }
    );

    return {
      code: 200,
      success: true,
      message: `${toRemove.length} code(s) deleted successfully`,
      user,
      available: newAvailable,
    };
  },

  updateProduct: async (
    _: unknown,
    { input }: { input: { productId: string; description?: string; marketPrice?: number; price?: number } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can update products", product: null };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId: input.productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you", product: null };
    }

    const updates: Record<string, unknown> = {};

    if (input.description != null) {
      const description = input.description.trim();
      if (description.length === 0) {
        return { code: 400, success: false, message: "Description cannot be empty", product: null };
      }
      if (description.length > 500) {
        return { code: 400, success: false, message: "Description must be at most 500 characters", product: null };
      }
      updates.description = description;
    }

    if (input.marketPrice != null) {
      if (input.marketPrice <= 0) {
        return { code: 400, success: false, message: "Market price must be greater than 0", product: null };
      }
      updates.marketPrice = parseFloat(input.marketPrice.toFixed(2));
    }

    if (input.price != null) {
      if (input.price <= 0) {
        return { code: 400, success: false, message: "Price must be greater than 0", product: null };
      }
      updates.price = parseFloat(input.price.toFixed(2));
    }

    if (Object.keys(updates).length === 0) {
      return { code: 400, success: false, message: "No fields to update", product: null };
    }

    // Recalculate discount with final values
    const finalMarketPrice = (updates.marketPrice as number) ?? product.marketPrice;
    const finalPrice = (updates.price as number) ?? product.price;

    if (finalPrice > finalMarketPrice) {
      return { code: 400, success: false, message: "Price cannot exceed market price", product: null };
    }

    updates.discount = parseFloat((((finalMarketPrice - finalPrice) / finalMarketPrice) * 100).toFixed(2));

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId: input.productId, userId },
      { $set: updates }
    );

    const updated = await catalogsDB.collection<Product>("Products").findOne({ productId: input.productId, userId });

    return {
      code: 200,
      success: true,
      message: "Product updated successfully",
      user,
      product: {
        productId: updated!.productId,
        catalog: updated!.catalog,
        category: updated!.category,
        region: updated!.region,
        name: updated!.name,
        description: updated!.description,
        marketPrice: updated!.marketPrice,
        price: updated!.price,
        discount: updated!.discount,
        isActive: updated!.isActive,
        isPromoted: updated!.isPromoted,
        available: updated!.available,
        sold: updated!.sold,
        createdAt: updated!.createdAt,
      },
    };
  },

  deleteProduct: async (
    _: unknown,
    { productId }: { productId: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can delete products" };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you" };
    }

    await catalogsDB.collection<Product>("Products").deleteOne({ productId, userId });

    return {
      code: 200,
      success: true,
      message: "Product deleted successfully",
      user,
    };
  },

  disableProduct: async (
    _: unknown,
    { productId }: { productId: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can disable products" };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you" };
    }

    if (!product.isActive) {
      return { code: 409, success: false, message: "Product is already disabled" };
    }

    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId },
      { $set: { isActive: false } }
    );

    return {
      code: 200,
      success: true,
      message: "Product disabled successfully",
      user,
      product: {
        productId: product.productId,
        catalog: product.catalog,
        category: product.category,
        region: product.region,
        name: product.name,
        description: product.description,
        marketPrice: product.marketPrice,
        price: product.price,
        discount: product.discount,
        isActive: false,
        isPromoted: product.isPromoted,
        available: product.available,
        sold: product.sold,
        type: product.type,
        createdAt: product.createdAt,
      },
    };
  },

  advertiseProduct: async (
    _: unknown,
    { input }: { input: { productId: string; amount: number; campaignStart: string; campaignEnd: string } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const { productId, amount } = input;
    const start = new Date(input.campaignStart);
    const end = new Date(input.campaignEnd);

    if (amount < 0.5) {
      return { code: 400, success: false, message: "Minimum ad amount is 0.5", promotion: null };
    }

    if (end <= start) {
      return { code: 400, success: false, message: "Campaign end must be after campaign start", promotion: null };
    }

    const db = getDB();
    const catalogsDB = getCatalogsDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can advertise products", promotion: null };
    }

    const product = await catalogsDB.collection<Product>("Products").findOne({ productId, userId });
    if (!product) {
      return { code: 404, success: false, message: "Product not found or does not belong to you", promotion: null };
    }

    if (!product.isActive) {
      return { code: 400, success: false, message: "Product must be active to advertise", promotion: null };
    }

    // Check balance
    const balance = await walletsDB.collection<Balance>("Balances").findOne({ userId });
    if (!balance || balance.availableBalance < amount) {
      return { code: 400, success: false, message: "Insufficient balance", promotion: null };
    }

    // Check if product already has a promotion
    const existingPromotion = await catalogsDB
      .collection<PromotedProduct>("PromotedProducts")
      .findOne({ productId });

    if (existingPromotion) {
      return { code: 409, success: false, message: "Product is already promoted. Wait for the current campaign to end before creating a new one", promotion: null };
    }

    // Deduct from wallet
    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId },
      { $inc: { availableBalance: -amount } }
    );

    // Record transaction
    const transaction: Transaction = {
      userId,
      id: crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, ""),
      type: "Product promotion",
      status: "completed",
      method: "balance",
      amount: parseFloat(amount.toFixed(2)),
      createdAt: new Date().toISOString(),
    };

    await walletsDB.collection<Transaction>("Transactions").insertOne(transaction);

    // Create new promotion
    const promotion: PromotedProduct = {
      userId,
      storeId: product.storeId,
      productId,
      amount: parseFloat(amount.toFixed(2)),
      campaignStart: start.toISOString(),
      campaignEnd: end.toISOString(),
      createdAt: new Date().toISOString(),
    };

    await catalogsDB.collection<PromotedProduct>("PromotedProducts").insertOne(promotion);

    // Set isPromoted on the product
    await catalogsDB.collection<Product>("Products").updateOne(
      { productId, userId },
      { $set: { isPromoted: true } }
    );

    return {
      code: 201,
      success: true,
      message: "Product promoted successfully",
      user,
      promotion: {
        productId: promotion.productId,
        amount: promotion.amount,
        campaignStart: promotion.campaignStart,
        campaignEnd: promotion.campaignEnd,
        createdAt: promotion.createdAt,
        product: {
          productId: product.productId,
          catalog: product.catalog,
          category: product.category,
          region: product.region,
          name: product.name,
          description: product.description,
          marketPrice: product.marketPrice,
          price: product.price,
          discount: product.discount,
          isActive: product.isActive,
          isPromoted: true,
          available: product.available,
          sold: product.sold,
          type: product.type,
          createdAt: product.createdAt,
        },
      },
    };
  },

  advertiseStore: async (
    _: unknown,
    { input }: { input: { amount: number; campaignStart: string; campaignEnd: string } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const { amount } = input;
    const start = new Date(input.campaignStart);
    const end = new Date(input.campaignEnd);

    if (amount < 0.5) {
      return { code: 400, success: false, message: "Minimum ad amount is 0.5", promotion: null };
    }

    if (end <= start) {
      return { code: 400, success: false, message: "Campaign end must be after campaign start", promotion: null };
    }

    const db = getDB();
    const catalogsDB = getCatalogsDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });
    if (!user || !user.isStore) {
      return { code: 403, success: false, message: "Only sellers can advertise stores", promotion: null };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return { code: 404, success: false, message: "Store not found", promotion: null };
    }

    if (!store.isActive) {
      return { code: 400, success: false, message: "Store must be active to advertise", promotion: null };
    }

    // Check balance
    const balance = await walletsDB.collection<Balance>("Balances").findOne({ userId });
    if (!balance || balance.availableBalance < amount) {
      return { code: 400, success: false, message: "Insufficient balance", promotion: null };
    }

    // Check if store already has a promotion
    const existingPromotion = await catalogsDB
      .collection<PromotedStore>("PromotedStores")
      .findOne({ storeId: store.storeId });

    if (existingPromotion) {
      return { code: 409, success: false, message: "Store is already promoted. Wait for the current campaign to end before creating a new one", promotion: null };
    }

    // Deduct from wallet
    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId },
      { $inc: { availableBalance: -amount } }
    );

    // Record transaction
    const transaction: Transaction = {
      userId,
      id: crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, ""),
      type: "Store promotion",
      status: "completed",
      method: "balance",
      amount: parseFloat(amount.toFixed(2)),
      createdAt: new Date().toISOString(),
    };

    await walletsDB.collection<Transaction>("Transactions").insertOne(transaction);

    // Create new promotion
    const promotion: PromotedStore = {
      userId,
      storeId: store.storeId,
      amount: parseFloat(amount.toFixed(2)),
      campaignStart: start.toISOString(),
      campaignEnd: end.toISOString(),
      createdAt: new Date().toISOString(),
    };

    await catalogsDB.collection<PromotedStore>("PromotedStores").insertOne(promotion);

    // Set isPromoted on the store
    await catalogsDB.collection<Store>("Stores").updateOne(
      { storeId: store.storeId, userId },
      { $set: { isPromoted: true } }
    );

    return {
      code: 201,
      success: true,
      message: "Store promoted successfully",
      user,
      promotion: {
        storeId: promotion.storeId,
        amount: promotion.amount,
        campaignStart: promotion.campaignStart,
        campaignEnd: promotion.campaignEnd,
        createdAt: promotion.createdAt,
        store: {
          storeId: store.storeId,
          storeName: store.storeName,
          isActive: store.isActive,
          isApproved: store.isApproved,
          approveStatus: store.approveStatus ?? null,
          isPromoted: true,
          type: store.type,
          totalSales: store.totalSales,
          positiveReviews: store.positiveReviews,
          negativeReviews: store.negativeReviews,
          registered: store.createdAt?.split("T")[0] || store.createdAt,
          requestCount: store.requestCount ?? 0,
        },
      },
    };
  },

  requestStoreAccess: async (
    _: unknown,
    { input }: {
      input: {
        surname: string;
        otherNames: string;
        gender: string;
        dateOfBirth: string;
        address: string;
        nationality: string;
        identification: string;
        proofPerson: string;
      };
    },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const store = await catalogsDB.collection<Store>("Stores").findOne({ userId });
    if (!store) {
      return { code: 404, success: false, message: "Store not found" };
    }

    if (store.isApproved) {
      return { code: 400, success: false, message: "Store is already approved" };
    }

    if (store.approveStatus === "pending") {
      return { code: 400, success: false, message: "Verification request is already pending" };
    }

    if (store.requestCount >= 3) {
      return { code: 400, success: false, message: "Maximum verification requests reached (3). No more attempts allowed" };
    }

    // Check if a pending verification request already exists
    const existing = await db.collection<VerificationRequest>("Verification").findOne({ userId });
    if (existing) {
      return { code: 400, success: false, message: "Verification request already submitted" };
    }

    // Sanitize text inputs
    const surname = sanitizeTextInput(input.surname, "Surname", 100);
    const otherNames = sanitizeTextInput(input.otherNames, "Other names", 100);
    const gender = sanitizeTextInput(input.gender, "Gender", 20);
    const dateOfBirth = sanitizeTextInput(input.dateOfBirth, "Date of birth", 10);
    const address = sanitizeTextInput(input.address, "Address", 300);
    const nationality = sanitizeTextInput(input.nationality, "Nationality", 100);

    // Validate gender
    const validGenders = ["Male", "Female", "Other"];
    if (!validGenders.includes(gender)) {
      return { code: 400, success: false, message: "Gender must be Male, Female, or Other" };
    }

    // Validate date of birth format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) || isNaN(Date.parse(dateOfBirth))) {
      return { code: 400, success: false, message: "Date of birth must be in YYYY-MM-DD format" };
    }

    // Validate images
    validateBase64Image(input.identification, "Identification");
    validateBase64Image(input.proofPerson, "Proof of person");

    // Store verification request in Main DB
    const verificationDoc: VerificationRequest = {
      userId,
      storeId: store.storeId,
      storeName: store.storeName,
      surname,
      otherNames,
      gender,
      dateOfBirth,
      address,
      nationality,
      identification: input.identification,
      proofPerson: input.proofPerson,
      submittedAt: new Date().toISOString(),
    };

    await db.collection<VerificationRequest>("Verification").insertOne(verificationDoc);

    // Update store: set approval to pending and increment request count
    await catalogsDB.collection<Store>("Stores").updateOne(
      { userId },
      { $set: { approveStatus: "pending" }, $inc: { requestCount: 1 } }
    );

    // Get user details for the email
    const user = await db.collection<User>("users").findOne({ id: userId });

    // Send email notification to admin with images attached
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail && user) {
      try {
        // Extract raw base64 and detect content type for attachments
        const idRaw = input.identification.replace(/^data:image\/\w+;base64,/, "");
        const ppRaw = input.proofPerson.replace(/^data:image\/\w+;base64,/, "");

        const detectContentType = (b64: string): string => {
          if (b64.startsWith("/9j/")) return "image/jpeg";
          if (b64.startsWith("iVBORw0KGgo")) return "image/png";
          if (b64.startsWith("R0lGODlh")) return "image/gif";
          if (b64.startsWith("UklGR")) return "image/webp";
          return "image/jpeg";
        };

        const idContentType = detectContentType(idRaw);
        const ppContentType = detectContentType(ppRaw);
        const idExt = idContentType.split("/")[1];
        const ppExt = ppContentType.split("/")[1];

        await smtpTransporter.sendMail({
          from: process.env.SMTP_EMAIL,
          to: adminEmail,
          subject: "New Store Access Request - Gameket",
          html: `
            <h2>New Store Access Request</h2>
            <p>A user has requested to become a seller on Gameket.</p>
            <table style="border-collapse: collapse; width: 100%; max-width: 500px;">
              <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Username</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${user.username}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Email</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${user.email}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Surname</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${surname}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Other Names</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${otherNames}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Gender</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${gender}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Date of Birth</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${dateOfBirth}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Nationality</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${nationality}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Address</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${address}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Store ID</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${store.storeId}</td></tr>
              <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Store Name</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${store.storeName}</td></tr>
            </table>
            <h3 style="margin-top: 20px;">Identification Document</h3>
            <img src="cid:identification" style="max-width: 500px; border: 1px solid #ccc;" />
            <h3 style="margin-top: 20px;">Proof of Person</h3>
            <img src="cid:proofPerson" style="max-width: 500px; border: 1px solid #ccc;" />
          `,
          attachments: [
            {
              filename: `identification.${idExt}`,
              content: idRaw,
              encoding: "base64",
              cid: "identification",
              contentType: idContentType,
            },
            {
              filename: `proof-person.${ppExt}`,
              content: ppRaw,
              encoding: "base64",
              cid: "proofPerson",
              contentType: ppContentType,
            },
          ],
        });
      } catch (emailError) {
        console.error("Failed to send admin email:", emailError);
      }
    }

    return { code: 200, success: true, message: "Verification request submitted successfully" };
  },

  adminAuthorizeStore: async (
    _: unknown,
    { storeId, superkey }: { storeId: string; superkey: string }
  ) => {
    // Rate limiting: track by storeId
    const now = Date.now();
    const attempt = adminAttempts.get(storeId);
    if (attempt) {
      if (attempt.lockedUntil > now) {
        const minutesLeft = Math.ceil((attempt.lockedUntil - now) / 60000);
        return { code: 429, success: false, message: `Too many attempts. Try again in ${minutesLeft} minute(s)` };
      }
      if (attempt.lockedUntil <= now && attempt.count >= MAX_ATTEMPTS) {
        adminAttempts.delete(storeId);
      }
    }

    const db = getDB();
    const catalogsDB = getCatalogsDB();

    // Retrieve the stored bcrypt hash of the superkey
    const adminDoc = await db.collection("Admin").findOne({ key: "superkey" });
    if (!adminDoc) {
      return { code: 500, success: false, message: "Server configuration error" };
    }

    const isValid = await bcrypt.compare(superkey, adminDoc.value);
    if (!isValid) {
      const current = adminAttempts.get(storeId) || { count: 0, lockedUntil: 0 };
      current.count += 1;
      if (current.count >= MAX_ATTEMPTS) {
        current.lockedUntil = now + LOCKOUT_DURATION;
      }
      adminAttempts.set(storeId, current);
      return { code: 403, success: false, message: "Invalid superkey" };
    }

    // Clear attempts on success
    adminAttempts.delete(storeId);

    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId });
    if (!store) {
      return { code: 404, success: false, message: "Store not found" };
    }

    if (store.isApproved) {
      return { code: 400, success: false, message: "Store is already approved" };
    }

    await catalogsDB.collection<Store>("Stores").updateOne(
      { storeId },
      { $set: { isApproved: true, approveStatus: "success" } }
    );

    return { code: 200, success: true, message: "Store authorized successfully" };
  },

  adminRejectStore: async (
    _: unknown,
    { storeId, superkey }: { storeId: string; superkey: string }
  ) => {
    const db = getDB();
    const catalogsDB = getCatalogsDB();

    const adminDoc = await db.collection("Admin").findOne({ key: "superkey" });
    if (!adminDoc) {
      return { code: 500, success: false, message: "Server configuration error" };
    }

    const isValid = await bcrypt.compare(superkey, adminDoc.value);
    if (!isValid) {
      return { code: 403, success: false, message: "Invalid superkey" };
    }

    const store = await catalogsDB.collection<Store>("Stores").findOne({ storeId });
    if (!store) {
      return { code: 404, success: false, message: "Store not found" };
    }

    if (store.approveStatus !== "pending") {
      return { code: 400, success: false, message: "Store does not have a pending request" };
    }

    await catalogsDB.collection<Store>("Stores").updateOne(
      { storeId },
      { $set: { approveStatus: "failed" } }
    );

    // Delete the verification doc so user can resubmit with new data
    await db.collection<VerificationRequest>("Verification").deleteOne({ storeId });

    return { code: 200, success: true, message: "Store request rejected" };
  },

  uploadImage: async (
    _: unknown,
    { image }: { image: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      return { code: 500, success: false, message: "Image upload not configured", url: null, deleteUrl: null };
    }

    try {
      const formData = new URLSearchParams();
      formData.append("key", apiKey);
      formData.append("image", image);

      const response = await fetch("https://api.imgbb.com/1/upload", {
        method: "POST",
        body: formData,
      });

      const data = await response.json() as { success: boolean; data?: { url: string; delete_url: string }; error?: { message: string } };

      if (!data.success) {
        return { code: 400, success: false, message: data.error?.message || "Image upload failed", url: null, deleteUrl: null };
      }

      return {
        code: 200,
        success: true,
        message: "Image uploaded successfully",
        url: data.data!.url,
        deleteUrl: data.data!.delete_url,
      };
    } catch (error) {
      return { code: 500, success: false, message: "Image upload failed", url: null, deleteUrl: null };
    }
  },
};
